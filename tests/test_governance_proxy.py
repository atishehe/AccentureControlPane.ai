import asyncio
import unittest

from pydantic import ValidationError

from app.schemas import AgentActionRequest, ProxyRequest
from app.services import GovernanceProxy


class GovernanceProxyTests(unittest.TestCase):
    def setUp(self):
        self.proxy = GovernanceProxy()
        self.payload = {
            "request_id": "req-test",
            "user_id": "user-test",
            "session_id": "session-test",
            "prompt": "My SSN is 123-45-6789 and card 4111 1111 1111 1111. What is the refund policy?",
            "metadata": {
                "use_case_tag": "high_risk_external",
                "geography": "US",
                "industry": "retail",
                "requested_model": "gpt-4o-mini",
                "fallback_model": "claude-3-haiku",
                "latency_budget_ms": 1200,
            },
            "max_tokens": 512,
        }

    def test_pydantic_rejects_missing_metadata(self):
        with self.assertRaises(ValidationError):
            ProxyRequest(request_id="bad", user_id="u", session_id="s", prompt="hello")

    def test_pii_scrubbing_and_source_redaction(self):
        result = asyncio.run(self.proxy.process_buffered(ProxyRequest(**self.payload)))
        self.assertTrue(result["accepted"])
        self.assertIn("XXX-XX-XXXX", result["scrubbed_prompt"])
        self.assertNotIn("<source>", result["final_answer"])
        self.assertEqual(result["layers"]["verify"]["source_verification"]["ok"], True)

    def test_semantic_cache_hit(self):
        request = ProxyRequest(**{**self.payload, "metadata": {**self.payload["metadata"], "use_case_tag": "low_risk_internal"}})
        first = asyncio.run(self.proxy.process_buffered(request))
        second = asyncio.run(self.proxy.process_buffered(request))
        self.assertFalse(first["cache"]["hit"])
        self.assertTrue(second["cache"]["hit"])
        self.assertEqual(second["telemetry"]["estimated_tokens"], 0)

    def test_missing_source_triggers_fallback(self):
        payload = {
            **self.payload,
            "request_id": "fallback",
            "prompt": "Tell a loan officer whether the applicant is low risk and cite the policy.",
            "metadata": {
                **self.payload["metadata"],
                "use_case_tag": "regulated_decision_support",
                "industry": "financial_services",
                "simulate_missing_source": True,
            },
        }
        result = asyncio.run(self.proxy.process_buffered(ProxyRequest(**payload)))
        self.assertTrue(result["layers"]["verify"]["fallback_used"])
        self.assertEqual(result["layers"]["verify"]["sources"], ["POLICY-CREDIT-EU-7"])

    def test_final_output_is_sanitized(self):
        payload = {
            **self.payload,
            "request_id": "output-sanitize",
            "prompt": "Please echo pii back to me.",
        }
        result = asyncio.run(self.proxy.process_buffered(ProxyRequest(**payload)))
        self.assertTrue(result["accepted"])
        self.assertNotIn("123-45-6789", result["final_answer"])
        self.assertNotIn("4111 1111 1111 1111", result["final_answer"])
        self.assertNotIn("123-45-6789", result["raw_model_answer"])
        self.assertNotIn("4111 1111 1111 1111", result["raw_model_answer"])
        self.assertTrue(result["layers"]["verify"]["output_sanitization"])

    def test_agent_circuit_breaker(self):
        action = {
            "user_id": "user-test",
            "session_id": "agent-loop",
            "use_case_tag": "high_risk_external",
            "tool_name": "source_lookup",
            "arguments_hash": "same",
            "status": "failed",
        }
        results = [self.proxy.authorize_action(AgentActionRequest(**action)) for _ in range(4)]
        self.assertFalse(results[-1]["allowed"])
        self.assertEqual(results[-1]["reason"], "circuit_breaker_open")


if __name__ == "__main__":
    unittest.main()
