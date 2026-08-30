const assert = require("assert");
const {
  validateRequest,
  scrubPrompt,
  parseSources,
  verifySources,
  processRequest,
  authorizeAction
} = require("../src/controlPlane");

async function run() {
  const validPayload = {
    request_id: "req-test",
    user_id: "user-test",
    session_id: "session-test",
    prompt: "My SSN is 123-45-6789 and my internal host is 10.0.2.15.",
    metadata: {
      use_case: "high_risk_external",
      geography: "US",
      industry: "retail",
      model: "gpt-enterprise",
      latency_budget_ms: 1000
    }
  };

  assert.equal(validateRequest(validPayload).valid, true);
  assert.equal(validateRequest({ prompt: "missing fields" }).valid, false);

  const scrubbed = scrubPrompt(validPayload.prompt);
  assert.equal(scrubbed.scrubbed.includes("123-45-6789"), false);
  assert.equal(scrubbed.scrubbed.includes("10.0.2.15"), false);
  assert.deepEqual(scrubbed.findings.map(item => item.type), ["ssn", "internal_ip"]);

  assert.deepEqual(parseSources("Answer <source>POLICY-REFUND-2026</source>"), ["POLICY-REFUND-2026"]);
  assert.equal(verifySources(["POLICY-REFUND-2026"]).ok, true);
  assert.equal(verifySources(["https://made-up.example"]).ok, false);

  const processed = await processRequest(validPayload);
  assert.equal(processed.accepted, true);
  assert.equal(processed.layers.prevent.scrubbed_entities.length, 2);
  assert.equal(processed.layers.verify.source_verification.ok, true);
  assert.equal(processed.final_answer.includes("<source>"), false);

  const missingSource = await processRequest({
    ...validPayload,
    request_id: "req-missing-source",
    prompt: "Tell a loan officer whether the applicant is low risk and cite the policy.",
    metadata: {
      ...validPayload.metadata,
      industry: "financial_services",
      simulate_missing_source: true
    }
  });
  assert.equal(missingSource.layers.verify.fallback_used, true);
  assert.equal(missingSource.layers.verify.sources[0], "POLICY-CREDIT-EU-7");

  const denied = authorizeAction({
    user_id: "user-test",
    session_id: "session-test-action",
    use_case: "high_risk_external",
    tool_name: "send_email"
  });
  assert.equal(denied.allowed, false);

  for (let i = 0; i < 3; i += 1) {
    authorizeAction({
      user_id: "user-test",
      session_id: "session-loop",
      use_case: "high_risk_external",
      tool_name: "source_lookup",
      arguments_hash: "same-query",
      status: "failed"
    });
  }
  const circuit = authorizeAction({
    user_id: "user-test",
    session_id: "session-loop",
    use_case: "high_risk_external",
    tool_name: "source_lookup",
    arguments_hash: "same-query",
    status: "failed"
  });
  assert.equal(circuit.allowed, false);
  assert.equal(circuit.reason, "circuit_breaker_open");

  console.log("All ControlPlane.ai tests passed");
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
