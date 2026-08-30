const scenarios = [
  {
    id: "customer-support-pii",
    name: "Customer support privacy leak",
    description: "External chatbot request containing structured PII and a source-backed answer.",
    payload: {
      request_id: "req-1001",
      user_id: "agent-ava",
      session_id: "support-001",
      prompt: "Customer says: my SSN is 123-45-6789 and card 4111 1111 1111 1111. Can you check the refund policy?",
      metadata: {
        use_case: "high_risk_external",
        geography: "US",
        industry: "retail",
        model: "gpt-enterprise",
        latency_budget_ms: 1200
      }
    }
  },
  {
    id: "internal-fast-path",
    name: "Internal knowledge fast path",
    description: "Low-risk internal request with tight latency and no sensitive data.",
    payload: {
      request_id: "req-1002",
      user_id: "employee-nikhil",
      session_id: "internal-042",
      prompt: "Summarize the onboarding checklist for a new project manager.",
      metadata: {
        use_case: "low_risk_internal",
        geography: "IN",
        industry: "consulting",
        model: "gpt-enterprise",
        latency_budget_ms: 450
      }
    }
  },
  {
    id: "missing-source",
    name: "Missing citation recovery",
    description: "Model output intentionally omits source tags, triggering verification fallback.",
    payload: {
      request_id: "req-1003",
      user_id: "analyst-maya",
      session_id: "decision-007",
      prompt: "Tell a loan officer whether the applicant is low risk and cite the policy.",
      metadata: {
        use_case: "high_risk_external",
        geography: "EU",
        industry: "financial_services",
        model: "gpt-enterprise",
        latency_budget_ms: 1800,
        simulate_missing_source: true
      }
    }
  },
  {
    id: "schema-drop",
    name: "Malformed request drop",
    description: "Payload missing required metadata, proving the prevent layer fails closed.",
    payload: {
      request_id: "req-1004",
      user_id: "employee-lee",
      prompt: "Can this request pass without a session id?"
    }
  }
];

module.exports = { scenarios };
