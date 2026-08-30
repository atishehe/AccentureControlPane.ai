from __future__ import annotations


SCENARIOS = [
    {
        "id": "customer-support-pii",
        "name": "PII Shield + High-Risk Verify",
        "description": "External chatbot request with SSN, credit card, strict routing, and source validation.",
        "payload": {
            "request_id": "req-1001",
            "user_id": "agent-ava",
            "session_id": "support-001",
            "prompt": "Customer says my SSN is 123-45-6789 and card 4111 1111 1111 1111. Can you check the refund policy?",
            "metadata": {
                "use_case_tag": "high_risk_external",
                "geography": "US",
                "industry": "retail",
                "requested_model": "gpt-4o-mini",
                "fallback_model": "claude-3-haiku",
                "latency_budget_ms": 1200
            },
            "max_tokens": 512,
            "stream": True
        }
    },
    {
        "id": "semantic-cache",
        "name": "Semantic Cache Cost Save",
        "description": "Run twice to show the second request bypassing the model path.",
        "payload": {
            "request_id": "req-1002",
            "user_id": "employee-nikhil",
            "session_id": "internal-042",
            "prompt": "Summarize the onboarding checklist for a new project manager.",
            "metadata": {
                "use_case_tag": "low_risk_internal",
                "geography": "IN",
                "industry": "consulting",
                "requested_model": "gpt-4o-mini",
                "fallback_model": "claude-3-haiku",
                "latency_budget_ms": 450
            },
            "max_tokens": 256,
            "stream": True
        }
    },
    {
        "id": "missing-source-fallback",
        "name": "Citation Recovery Branch",
        "description": "Forces missing source tags, then recovers evidence through async fallback search.",
        "payload": {
            "request_id": "req-1003",
            "user_id": "analyst-maya",
            "session_id": "decision-007",
            "prompt": "Tell a loan officer whether the applicant is low risk and cite the policy.",
            "metadata": {
                "use_case_tag": "regulated_decision_support",
                "geography": "EU",
                "industry": "financial_services",
                "requested_model": "gpt-4o-mini",
                "fallback_model": "claude-3-haiku",
                "latency_budget_ms": 1800,
                "simulate_missing_source": True
            },
            "max_tokens": 512,
            "stream": True
        }
    },
    {
        "id": "provider-failover",
        "name": "Provider Rate-Limit Failover",
        "description": "Simulates a mid-flight provider rate limit and switches to a fallback model route.",
        "payload": {
            "request_id": "req-1004",
            "user_id": "ops-zara",
            "session_id": "ops-900",
            "prompt": "What security controls should enterprise AI operations enforce?",
            "metadata": {
                "use_case_tag": "high_risk_external",
                "geography": "US",
                "industry": "technology",
                "requested_model": "gpt-4o-mini",
                "fallback_model": "claude-3-haiku",
                "latency_budget_ms": 1500,
                "simulate_provider_rate_limit": True
            },
            "max_tokens": 512,
            "stream": True
        }
    },
    {
        "id": "schema-drop",
        "name": "Fail-Closed Schema Drop",
        "description": "Malformed payload missing required metadata fields.",
        "payload": {
            "request_id": "req-1005",
            "user_id": "employee-lee",
            "prompt": "Can this request pass without session and metadata?"
        }
    }
]
