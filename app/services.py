from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import time
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, Iterable, List, Optional, Tuple

from .schemas import AgentActionRequest, FeedbackRequest, ProxyRequest, UseCaseTag

try:
    from presidio_analyzer import AnalyzerEngine
    from presidio_anonymizer import AnonymizerEngine
except Exception:  # pragma: no cover - optional enterprise dependency
    AnalyzerEngine = None
    AnonymizerEngine = None

try:
    import redis
except Exception:  # pragma: no cover - optional enterprise dependency
    redis = None


SOURCE_REGISTRY = {
    "POLICY-REFUND-2026": "Customer refund policy, governed document store",
    "KB-ONBOARDING-19": "Internal onboarding checklist, knowledge base",
    "POLICY-CREDIT-EU-7": "EU credit decision support policy",
    "SEC-AI-OPS-4": "AI operations security baseline",
}


POLICIES = {
    UseCaseTag.low_risk_internal: {
        "route": "fast_path",
        "label": "Low-risk internal fast path",
        "judge": False,
        "semantic_cache": True,
        "max_tpm": 8_000,
        "session_token_budget": 12_000,
        "max_tool_calls": 8,
        "judge_min_risk": 0.68,
        "judge_token_budget": 160,
        "allowed_tools": {"knowledge_search", "summarize_document", "source_lookup"},
    },
    UseCaseTag.high_risk_external: {
        "route": "heavy_verification",
        "label": "High-risk external verification",
        "judge": True,
        "semantic_cache": True,
        "max_tpm": 4_000,
        "session_token_budget": 6_000,
        "max_tool_calls": 4,
        "judge_min_risk": 0.42,
        "judge_token_budget": 220,
        "allowed_tools": {"source_lookup", "policy_lookup"},
    },
    UseCaseTag.regulated_decision_support: {
        "route": "human_review",
        "label": "Regulated decision support",
        "judge": True,
        "semantic_cache": False,
        "max_tpm": 2_500,
        "session_token_budget": 4_000,
        "max_tool_calls": 3,
        "judge_min_risk": 0.32,
        "judge_token_budget": 260,
        "allowed_tools": {"policy_lookup"},
    },
}


@dataclass
class SessionState:
    session_id: str
    token_count: int = 0
    tool_calls: int = 0
    repeated_failures: Counter = field(default_factory=Counter)
    request_count: int = 0
    circuit_open: bool = False
    updated_at: str = field(default_factory=lambda: utc_now())


class AuditLog:
    def __init__(self) -> None:
        self.events: deque[Dict[str, Any]] = deque(maxlen=200)

    def add(self, **event: Any) -> None:
        self.events.appendleft({"timestamp": utc_now(), **event})

    def list(self) -> List[Dict[str, Any]]:
        return list(self.events)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PiiScrubber:
    def __init__(self) -> None:
        self.presidio_available = False
        self.analyzer = None
        self.anonymizer = None
        if AnalyzerEngine is not None and AnonymizerEngine is not None:
            try:
                self.analyzer = AnalyzerEngine()
                self.anonymizer = AnonymizerEngine()
                self.presidio_available = True
            except Exception:
                # Presidio may try to download a spaCy language model on first boot.
                # The proxy must still fail open to deterministic redaction for demos and air-gapped enterprises.
                self.analyzer = None
                self.anonymizer = None
        self.regex_patterns = [
            ("US_SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "XXX-XX-XXXX"),
            ("CREDIT_CARD", re.compile(r"\b(?:\d[ -]*?){13,19}\b"), "XXXX-XXXX-XXXX-XXXX"),
            ("PHONE_NUMBER", re.compile(r"\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b"), "REDACTED-PHONE"),
            ("PRIVATE_IP", re.compile(r"\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b"), "PRIVATE-IP"),
            ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), "REDACTED-EMAIL"),
        ]

    def scrub(self, text: str) -> Tuple[str, List[Dict[str, Any]]]:
        scrubbed = text
        findings: List[Dict[str, Any]] = []

        if self.presidio_available:
            presidio_findings = self.analyzer.analyze(text=text, language="en")
            anonymized = self.anonymizer.anonymize(text=text, analyzer_results=presidio_findings)
            scrubbed = anonymized.text
            findings = [
                {"type": item.entity_type, "start": item.start, "end": item.end, "score": round(item.score, 3)}
                for item in presidio_findings
            ]

        for entity_type, pattern, replacement in self.regex_patterns:
            matches = list(pattern.finditer(scrubbed))
            if matches:
                findings.append({"type": entity_type, "count": len(matches), "engine": "regex_fallback"})
                scrubbed = pattern.sub(replacement, scrubbed)
                
        return scrubbed, findings

    def sanitize_output(self, text: str) -> Tuple[str, List[Dict[str, Any]]]:
        # Output sanitization uses the same deterministic and Presidio-backed logic as input scrubbing.
        return self.scrub(text)


class BudgetStore:
    """Redis/Dragonfly-compatible token bucket with an in-memory fallback."""

    def __init__(self) -> None:
        self.redis_client = None
        self.memory_buckets: Dict[str, Tuple[float, float]] = {}
        if redis is not None:
            try:
                self.redis_client = redis.Redis.from_url("redis://localhost:6379/0", socket_connect_timeout=0.05)
                self.redis_client.ping()
            except Exception:
                self.redis_client = None

    def authorize(self, key: str, requested_tokens: int, capacity: int, refill_per_second: float) -> Dict[str, Any]:
        if self.redis_client:
            return self._authorize_redis(key, requested_tokens, capacity, refill_per_second)
        return self._authorize_memory(key, requested_tokens, capacity, refill_per_second)

    def _authorize_memory(self, key: str, requested_tokens: int, capacity: int, refill_per_second: float) -> Dict[str, Any]:
        now = time.time()
        tokens, last_seen = self.memory_buckets.get(key, (float(capacity), now))
        tokens = min(float(capacity), tokens + (now - last_seen) * refill_per_second)
        allowed = tokens >= requested_tokens
        if allowed:
            tokens -= requested_tokens
        self.memory_buckets[key] = (tokens, now)
        return {
            "allowed": allowed,
            "store": "memory",
            "remaining_tokens": int(tokens),
            "requested_tokens": requested_tokens,
            "capacity": capacity,
        }

    def _authorize_redis(self, key: str, requested_tokens: int, capacity: int, refill_per_second: float) -> Dict[str, Any]:
        # Dragonfly is Redis-compatible, so the same atomic Lua script applies.
        script = """
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local requested = tonumber(ARGV[2])
        local capacity = tonumber(ARGV[3])
        local refill = tonumber(ARGV[4])
        local bucket = redis.call('HMGET', key, 'tokens', 'ts')
        local tokens = tonumber(bucket[1]) or capacity
        local ts = tonumber(bucket[2]) or now
        tokens = math.min(capacity, tokens + ((now - ts) * refill))
        local allowed = 0
        if tokens >= requested then
          tokens = tokens - requested
          allowed = 1
        end
        redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
        redis.call('EXPIRE', key, 120)
        return {allowed, math.floor(tokens)}
        """
        allowed, remaining = self.redis_client.eval(script, 1, key, time.time(), requested_tokens, capacity, refill_per_second)
        return {
            "allowed": bool(allowed),
            "store": "redis_or_dragonfly",
            "remaining_tokens": int(remaining),
            "requested_tokens": requested_tokens,
            "capacity": capacity,
        }


class SemanticCache:
    def __init__(self) -> None:
        self.entries: List[Dict[str, Any]] = []

    def embed(self, text: str) -> Counter:
        words = re.findall(r"[a-z0-9]+", text.lower())
        return Counter(words)

    def similarity(self, left: Counter, right: Counter) -> float:
        if not left or not right:
            return 0.0
        shared = sum((left & right).values())
        return shared / math.sqrt(sum(left.values()) * sum(right.values()))

    def get(self, prompt: str, use_case_tag: UseCaseTag, threshold: float = 0.84) -> Optional[Dict[str, Any]]:
        vector = self.embed(prompt)
        best: Optional[Dict[str, Any]] = None
        best_score = 0.0
        for entry in self.entries:
            if entry["use_case_tag"] != use_case_tag:
                continue
            score = self.similarity(vector, entry["vector"])
            if score > best_score:
                best = entry
                best_score = score
        if best and best_score >= threshold:
            return {**best, "similarity": round(best_score, 3)}
        return None

    def put(self, prompt: str, use_case_tag: UseCaseTag, final_answer: str, trace: Dict[str, Any]) -> None:
        self.entries.append({
            "cache_key": hashlib.sha256(f"{use_case_tag}:{prompt}".encode()).hexdigest()[:16],
            "use_case_tag": use_case_tag,
            "prompt": prompt,
            "vector": self.embed(prompt),
            "final_answer": final_answer,
            "trace": trace,
            "created_at": utc_now(),
        })
        self.entries[:] = self.entries[-100:]


class LlmRouter:
    async def stream(self, request: ProxyRequest, modified_prompt: str) -> AsyncIterator[Dict[str, str]]:
        if request.metadata.simulate_provider_rate_limit:
            yield {"event": "provider_error", "data": "primary_rate_limit"}
            async for chunk in self._simulate_model_stream(request, modified_prompt, provider="fallback_provider"):
                yield chunk
            return

        async for chunk in self._simulate_model_stream(request, modified_prompt, provider="primary_provider"):
            yield chunk

    async def _simulate_model_stream(self, request: ProxyRequest, modified_prompt: str, provider: str) -> AsyncIterator[Dict[str, str]]:
        answer = self._answer_for(request, provider)
        for token in answer.split(" "):
            await asyncio.sleep(0.005)
            yield {"event": "token", "data": token + " "}

    def _answer_for(self, request: ProxyRequest, provider: str) -> str:
        prompt = request.prompt.lower()
        if request.metadata.simulate_missing_source:
            return "This response was generated without explicit source tags and must be recovered by the verifier."
        if request.metadata.simulate_confidently_wrong:
            return f"This is definitely correct: the refund policy always approves every request with no exceptions. Routed through {provider}. <source>POLICY-REFUND-2026</source>"
        if request.metadata.simulate_bias_risk:
            return f"The answer uses gender as a factor when deciding access priority. Routed through {provider}. <source>SEC-AI-OPS-4</source>"
        if "echo pii" in prompt or "leak pii" in prompt:
            return f"The answer must not expose sensitive data like 123-45-6789 or 4111 1111 1111 1111. Routed through {provider}. <source>SEC-AI-OPS-4</source>"
        if "refund" in prompt:
            return f"Sensitive data was removed before processing. Refund eligibility depends on return window, condition, and purchase channel. Routed through {provider}. <source>POLICY-REFUND-2026</source>"
        if "onboarding" in prompt:
            return f"Start with scope, stakeholders, cadence, access, risks, and delivery governance. Routed through {provider}. <source>KB-ONBOARDING-19</source>"
        if "security" in prompt:
            return f"Use least privilege, audit logging, rate limits, and source-grounded answers for enterprise AI operations. Routed through {provider}. <source>SEC-AI-OPS-4</source>"
        return f"The proxy completed governed inference with source verification enabled. Routed through {provider}. <source>SEC-AI-OPS-4</source>"


class GovernanceProxy:
    def __init__(self) -> None:
        self.scrubber = PiiScrubber()
        self.budget_store = BudgetStore()
        self.semantic_cache = SemanticCache()
        self.llm_router = LlmRouter()
        self.sessions: Dict[str, SessionState] = {}
        self.audit = AuditLog()
        self.feedback_threshold_adjustments = defaultdict(float)

    def session(self, session_id: str) -> SessionState:
        if session_id not in self.sessions:
            self.sessions[session_id] = SessionState(session_id=session_id)
        return self.sessions[session_id]

    def estimate_tokens(self, text: str, max_tokens: int) -> int:
        return max(1, math.ceil(len(text) / 4) + max_tokens)

    def policy_for(self, tag: UseCaseTag) -> Dict[str, Any]:
        return POLICIES[tag]

    def inject_instructions(self, prompt: str, request: ProxyRequest, route: Dict[str, Any]) -> str:
        return (
            "Hidden governance instruction: Answer only with grounded claims. "
            "Append source IDs inside <source>...</source> tags. "
            "For regulated or high-risk cases, avoid decisive recommendations without review.\n"
            f"Route={route['route']} geography={request.metadata.geography} industry={request.metadata.industry}\n"
            f"User prompt: {prompt}"
        )

    def parse_sources(self, text: str) -> List[str]:
        return [item.strip() for item in re.findall(r"<source>(.*?)</source>", text, flags=re.I | re.S) if item.strip()]

    def verify_sources(self, sources: Iterable[str]) -> Dict[str, Any]:
        source_list = list(sources)
        missing = len(source_list) == 0
        hallucinated = [source for source in source_list if source not in SOURCE_REGISTRY]
        return {
            "ok": not missing and not hallucinated,
            "reason": "missing_source_tags" if missing else "unknown_source_ids" if hallucinated else "source_registry_match",
            "hallucinated": hallucinated,
        }

    async def verification_fallback(self, scrubbed_prompt: str) -> Tuple[str, str]:
        await asyncio.sleep(0.025)
        if "loan" in scrubbed_prompt.lower() or "credit" in scrubbed_prompt.lower():
            return (
                "The verifier recovered the governed credit policy and requires human review before applicant-level action.",
                "POLICY-CREDIT-EU-7",
            )
        return (
            "The verifier recovered the closest governed enterprise AI security policy and generated a cautious grounded answer.",
            "SEC-AI-OPS-4",
        )

    def judge(self, text: str, request: ProxyRequest) -> Dict[str, Any]:
        issues = []
        lower = text.lower()
        if "always approve" in lower or "always reject" in lower:
            issues.append("overconfident_decision")
        if request.metadata.use_case_tag == UseCaseTag.regulated_decision_support and "human review" not in lower:
            issues.append("human_review_required")
        if any(term in lower for term in ["race", "religion", "gender"]):
            issues.append("protected_attribute_risk")
        return {
            "passed": not issues,
            "score": max(0.1, round(1 - 0.25 * len(issues), 2)),
            "issues": issues,
        }

    def redact_sources(self, text: str) -> str:
        return re.sub(r"\s*<source>.*?</source>", "", text, flags=re.I | re.S).strip()

    def score_risk(
        self,
        request: ProxyRequest,
        requested_tokens: int,
        policy: Dict[str, Any],
        source_verification: Dict[str, Any],
        pii_findings: List[Dict[str, Any]],
        output_findings: List[Dict[str, Any]],
        provider_events: List[Dict[str, str]],
        raw: str,
        fallback_used: bool,
    ) -> Dict[str, Any]:
        lower = raw.lower()
        performance = 0.08
        cost = min(0.85, requested_tokens / max(1, policy["session_token_budget"]))
        responsibility = 0.08
        signals: List[str] = []

        if request.metadata.use_case_tag == UseCaseTag.high_risk_external:
            performance += 0.12
            responsibility += 0.12
            signals.append("high_risk_external_context")

        if not source_verification["ok"]:
            performance += 0.55
            signals.append(source_verification["reason"])
        if fallback_used:
            performance += 0.18
            signals.append("fallback_verification_used")
        if "definitely correct" in lower or "always approves" in lower or "no exceptions" in lower:
            performance += 0.32
            signals.append("overconfident_claim_language")
        if request.metadata.use_case_tag == UseCaseTag.regulated_decision_support:
            performance += 0.16
            responsibility += 0.16
            signals.append("regulated_decision_context")

        if provider_events:
            cost += 0.18
            signals.append("provider_failover_event")
        if requested_tokens > policy["max_tpm"] * 0.5:
            cost += 0.18
            signals.append("large_token_reservation")

        if pii_findings:
            responsibility += 0.28
            signals.append("input_sensitive_data_detected")
        if output_findings:
            responsibility += 0.42
            signals.append("output_sensitive_data_detected")
        if any(term in lower for term in ["race", "religion", "gender", "caste", "disability"]):
            responsibility += 0.4
            signals.append("protected_attribute_language")

        performance = min(1.0, performance + self.feedback_threshold_adjustments["performance"])
        cost = min(1.0, cost + self.feedback_threshold_adjustments["cost"])
        responsibility = min(1.0, responsibility + self.feedback_threshold_adjustments["responsibility"])
        overall = round(max(performance, cost, responsibility), 2)

        return {
            "performance_risk": round(performance, 2),
            "cost_risk": round(cost, 2),
            "responsibility_risk": round(responsibility, 2),
            "overall_risk": overall,
            "signals": sorted(set(signals)),
        }

    def should_invoke_judge(self, risk_score: Dict[str, Any], policy: Dict[str, Any], bucket: Dict[str, Any], request: ProxyRequest) -> Dict[str, Any]:
        if not policy["judge"]:
            return {"invoke": False, "reason": "policy_does_not_require_judge"}
        if risk_score["overall_risk"] < policy["judge_min_risk"]:
            return {"invoke": False, "reason": "risk_below_judge_threshold", "threshold": policy["judge_min_risk"]}
        if bucket["remaining_tokens"] < policy["judge_token_budget"]:
            return {"invoke": False, "reason": "judge_budget_not_available", "required_tokens": policy["judge_token_budget"]}
        if request.metadata.latency_budget_ms < 350:
            return {"invoke": False, "reason": "latency_budget_too_tight"}
        return {"invoke": True, "reason": "risk_and_budget_justify_judge", "threshold": policy["judge_min_risk"], "reserved_tokens": policy["judge_token_budget"]}

    def decide_outcome(
        self,
        risk_score: Dict[str, Any],
        judge_result: Optional[Dict[str, Any]],
        output_findings: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        if judge_result and not judge_result["passed"] and risk_score["overall_risk"] >= 0.8:
            return {"decision": "block", "reason": "judge_failed_high_risk_response"}
        if output_findings:
            return {"decision": "edit", "reason": "sensitive_output_redacted"}
        if judge_result and not judge_result["passed"]:
            return {"decision": "block", "reason": "judge_failed_response"}
        if risk_score["overall_risk"] >= 0.9:
            return {"decision": "block", "reason": "risk_score_exceeds_block_threshold"}
        return {"decision": "allow", "reason": "risk_within_policy"}

    def record_feedback(self, feedback: FeedbackRequest) -> Dict[str, Any]:
        if feedback.signal in {"false_negative", "missed_risk"}:
            self.feedback_threshold_adjustments[feedback.dimension] = min(
                0.2,
                self.feedback_threshold_adjustments[feedback.dimension] + 0.03,
            )
        elif feedback.signal == "false_positive":
            self.feedback_threshold_adjustments[feedback.dimension] = max(
                -0.12,
                self.feedback_threshold_adjustments[feedback.dimension] - 0.02,
            )
        return {
            "accepted": True,
            "threshold_adjustments": dict(self.feedback_threshold_adjustments),
        }

    async def process_buffered(self, request: ProxyRequest) -> Dict[str, Any]:
        started = time.perf_counter()
        session = self.session(request.session_id)
        policy = self.policy_for(request.metadata.use_case_tag)
        scrubbed_prompt, pii_findings = self.scrubber.scrub(request.prompt)
        requested_tokens = self.estimate_tokens(scrubbed_prompt, request.max_tokens)

        bucket = self.budget_store.authorize(
            f"tpm:{request.user_id}:{request.metadata.use_case_tag}",
            requested_tokens,
            policy["max_tpm"],
            policy["max_tpm"] / 60,
        )
        if not bucket["allowed"] or session.token_count + requested_tokens > policy["session_token_budget"]:
            self.audit.add(request_id=request.request_id, decision="block", reason="budget_exceeded")
            return {
                "accepted": False,
                "decision": "block",
                "reason": "budget_exceeded",
                "bucket": bucket,
            }

        route = {"route": policy["route"], "label": policy["label"], "requires_judge": policy["judge"]}
        cached = self.semantic_cache.get(scrubbed_prompt, request.metadata.use_case_tag) if policy["semantic_cache"] else None
        if cached:
            self.audit.add(request_id=request.request_id, session_id=request.session_id, decision="cache_hit", route=route["route"])
            return {
                "accepted": True,
                "decision": "allow_cached",
                "final_answer": cached["final_answer"],
                "cache": {"hit": True, "similarity": cached["similarity"], "cache_key": cached["cache_key"]},
                "layers": cached["trace"],
                "decision_policy": cached["trace"].get("decision_policy"),
                "telemetry": {"latency_ms": round((time.perf_counter() - started) * 1000, 2), "estimated_tokens": 0, "estimated_cost_usd": 0},
            }

        modified_prompt = self.inject_instructions(scrubbed_prompt, request, route)
        raw = ""
        provider_events = []
        async for event in self.llm_router.stream(request, modified_prompt):
            if event["event"] == "token":
                raw += event["data"]
            else:
                provider_events.append(event)

        sources = self.parse_sources(raw)
        source_verification = self.verify_sources(sources)
        fallback_used = False
        if not source_verification["ok"]:
            fallback_answer, fallback_source = await self.verification_fallback(scrubbed_prompt)
            raw = f"{fallback_answer} <source>{fallback_source}</source>"
            sources = self.parse_sources(raw)
            source_verification = self.verify_sources(sources)
            fallback_used = True

        final_answer = self.redact_sources(raw)
        final_answer, output_findings = self.scrubber.sanitize_output(final_answer)
        raw_model_answer, raw_model_output_findings = self.scrubber.sanitize_output(raw)
        risk_score = self.score_risk(
            request=request,
            requested_tokens=requested_tokens,
            policy=policy,
            source_verification=source_verification,
            pii_findings=pii_findings,
            output_findings=output_findings,
            provider_events=provider_events,
            raw=raw,
            fallback_used=fallback_used,
        )
        judge_decision = self.should_invoke_judge(risk_score, policy, bucket, request)
        judge_result = self.judge(raw, request) if judge_decision["invoke"] else None
        outcome = self.decide_outcome(risk_score, judge_result, output_findings)
        decision = outcome["decision"]
        if decision == "block":
            final_answer = "This response was blocked by ControlPlane.ai because the risk score or judge evaluation exceeded policy limits."

        session.request_count += 1
        session.token_count += requested_tokens
        session.updated_at = utc_now()
        trace = {
            "prevent": {"schema_valid": True, "pii_findings": pii_findings},
            "control": {"route": route["route"], "policy": policy["label"], "bucket": bucket},
            "gate": {"session_tool_calls": session.tool_calls, "circuit_open": session.circuit_open},
            "verify": {
                "sources": sources,
                "source_verification": source_verification,
                "fallback_used": fallback_used,
                "risk_score": risk_score,
                "judge_invocation": judge_decision,
                "judge": judge_result,
                "output_sanitization": output_findings,
                "raw_model_output_sanitization": raw_model_output_findings,
            },
            "decision_policy": outcome,
            "provider_events": provider_events,
        }
        if decision in {"allow", "edit"}:
            self.semantic_cache.put(scrubbed_prompt, request.metadata.use_case_tag, final_answer, trace)

        self.audit.add(
            request_id=request.request_id,
            session_id=request.session_id,
            use_case_tag=request.metadata.use_case_tag.value,
            decision=decision,
            route=route["route"],
            fallback_used=fallback_used,
            pii_count=len(pii_findings),
        )

        return {
            "accepted": True,
            "decision": decision,
            "final_answer": final_answer,
            "raw_model_answer": raw_model_answer,
            "scrubbed_prompt": scrubbed_prompt,
            "cache": {"hit": False},
            "layers": trace,
            "decision_policy": outcome,
            "session": session.__dict__,
            "telemetry": {
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                "estimated_tokens": requested_tokens,
                "estimated_cost_usd": round(requested_tokens * 0.000002, 6),
            },
        }

    async def stream_sse(self, request: ProxyRequest) -> AsyncIterator[str]:
        result = await self.process_buffered(request)
        if not result.get("accepted"):
            yield sse("blocked", result)
            return

        for word in result["final_answer"].split(" "):
            await asyncio.sleep(0.004)
            yield sse("token", {"text": word + " "})
        yield sse("trace", result)

    def authorize_action(self, request: AgentActionRequest) -> Dict[str, Any]:
        session = self.session(request.session_id)
        policy = self.policy_for(request.use_case_tag)
        failure_key = f"{request.tool_name}:{request.arguments_hash}"

        if request.tool_name not in policy["allowed_tools"]:
            self.audit.add(session_id=request.session_id, user_id=request.user_id, decision="block_action", reason="tool_not_allowed", tool_name=request.tool_name)
            return {"allowed": False, "reason": "tool_not_allowed", "allowed_tools": sorted(policy["allowed_tools"])}

        if request.status == "failed":
            session.repeated_failures[failure_key] += 1

        failure_rate = sum(session.repeated_failures.values()) / max(1, session.tool_calls + sum(session.repeated_failures.values()))
        sustained_failure_rate = sum(session.repeated_failures.values()) >= 4 and failure_rate > 0.65
        if session.repeated_failures[failure_key] >= 3 or sustained_failure_rate or session.tool_calls >= policy["max_tool_calls"]:
            session.circuit_open = True
            self.audit.add(session_id=request.session_id, user_id=request.user_id, decision="circuit_breaker", reason="runaway_agent", tool_name=request.tool_name)
            return {
                "allowed": False,
                "reason": "circuit_breaker_open",
                "failed_attempts": session.repeated_failures[failure_key],
                "failure_rate": round(failure_rate, 2),
                "tool_calls": session.tool_calls,
                "max_tool_calls": policy["max_tool_calls"],
            }

        session.tool_calls += 1
        session.updated_at = utc_now()
        self.audit.add(session_id=request.session_id, user_id=request.user_id, decision="allow_action", tool_name=request.tool_name)
        return {
            "allowed": True,
            "reason": "authorized",
            "tool_calls": session.tool_calls,
            "remaining_tool_budget": policy["max_tool_calls"] - session.tool_calls,
        }

    def dashboard(self) -> Dict[str, Any]:
        events = self.audit.list()
        return {
            "policies": {key.value: {**value, "allowed_tools": sorted(value["allowed_tools"])} for key, value in POLICIES.items()},
            "sessions": [state.__dict__ for state in self.sessions.values()],
            "auditLog": events,
            "metrics": {
                "total_events": len(events),
                "blocked_or_flagged": sum(1 for event in events if event.get("decision") in {"block", "block_action", "circuit_breaker"}),
                "edited": sum(1 for event in events if event.get("decision") == "edit"),
                "fallbacks": sum(1 for event in events if event.get("fallback_used")),
                "cache_entries": len(self.semantic_cache.entries),
                "presidio_enabled": self.scrubber.presidio_available,
                "budget_store": "redis_or_dragonfly" if self.budget_store.redis_client else "memory_fallback",
                "feedback_threshold_adjustments": dict(self.feedback_threshold_adjustments),
            },
        }


def sse(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


proxy = GovernanceProxy()
