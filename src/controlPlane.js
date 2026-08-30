const policies = {
  low_risk_internal: {
    label: "Fast path",
    verification: "direct",
    judge: false,
    maxTokens: 4000,
    maxToolCalls: 6,
    allowedTools: ["knowledge_search", "summarize_document"]
  },
  high_risk_external: {
    label: "Heavy verification",
    verification: "strict",
    judge: true,
    maxTokens: 2500,
    maxToolCalls: 3,
    allowedTools: ["knowledge_search", "source_lookup"]
  },
  regulated_decision_support: {
    label: "Human review",
    verification: "strict",
    judge: true,
    maxTokens: 1800,
    maxToolCalls: 2,
    allowedTools: ["policy_lookup"]
  }
};

const sourceRegistry = new Set(["POLICY-REFUND-2026", "KB-ONBOARDING-19", "POLICY-CREDIT-EU-7"]);
const sessions = new Map();
const auditLog = [];

const schema = {
  request_id: "string",
  user_id: "string",
  session_id: "string",
  prompt: "string",
  metadata: "object"
};

const metadataSchema = {
  use_case: "string",
  geography: "string",
  industry: "string",
  model: "string",
  latency_budget_ms: "number"
};

const scrubPatterns = [
  { type: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "XXX-XX-XXXX" },
  { type: "credit_card", regex: /\b(?:\d[ -]*?){13,19}\b/g, replacement: "XXXX-XXXX-XXXX-XXXX" },
  { type: "internal_ip", regex: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g, replacement: "PRIVATE-IP" }
];

function now() {
  return new Date().toISOString();
}

function validateShape(payload, shape, prefix = "") {
  const errors = [];
  for (const [field, type] of Object.entries(shape)) {
    const value = payload ? payload[field] : undefined;
    if (value === undefined || value === null) {
      errors.push(`${prefix}${field} is required`);
      continue;
    }
    if (type === "object") {
      if (typeof value !== "object" || Array.isArray(value)) errors.push(`${prefix}${field} must be an object`);
    } else if (typeof value !== type) {
      errors.push(`${prefix}${field} must be ${type}`);
    }
  }
  return errors;
}

function validateRequest(payload) {
  const errors = [
    ...validateShape(payload, schema),
    ...validateShape(payload && payload.metadata, metadataSchema, "metadata.")
  ];

  if (payload && payload.metadata && !policies[payload.metadata.use_case]) {
    errors.push(`metadata.use_case must be one of ${Object.keys(policies).join(", ")}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function scrubPrompt(prompt) {
  let scrubbed = prompt;
  const findings = [];

  for (const pattern of scrubPatterns) {
    const matches = [...scrubbed.matchAll(pattern.regex)];
    if (matches.length > 0) {
      findings.push({ type: pattern.type, count: matches.length });
      scrubbed = scrubbed.replace(pattern.regex, pattern.replacement);
    }
  }

  return { scrubbed, findings };
}

function sessionFor(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      session_id: sessionId,
      token_count: 0,
      tool_calls: 0,
      repeated_failures: {},
      requests: 0,
      blocked: false,
      updated_at: now()
    });
  }
  return sessions.get(sessionId);
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function route(metadata) {
  const policy = policies[metadata.use_case] || policies.low_risk_internal;
  return {
    route: policy.label,
    risk: metadata.use_case,
    verification: policy.verification,
    requiresJudge: policy.judge,
    latencyBudgetMs: metadata.latency_budget_ms,
    policy
  };
}

function injectInstruction(prompt, routeDecision) {
  const sourceInstruction = "Hidden system instruction: answer concisely and append source document IDs inside <source>...</source> tags.";
  const riskInstruction = routeDecision.requiresJudge
    ? "High-risk instruction: avoid unsupported claims, protected-class reasoning, and decisive recommendations without evidence."
    : "Fast-path instruction: prioritize latency while preserving privacy and citation discipline.";
  return `${riskInstruction}\n${sourceInstruction}\n\nUser prompt:\n${prompt}`;
}

function simulateFoundationModel(modifiedPrompt, payload, routeDecision) {
  const prompt = payload.prompt.toLowerCase();

  if (payload.metadata.simulate_missing_source) {
    return "The applicant should not be treated as low risk without verified income, repayment history, and jurisdiction-specific policy checks.";
  }

  if (prompt.includes("refund")) {
    return "I can summarize the refund policy after removing sensitive data. Refund eligibility depends on purchase channel, item condition, and return window. <source>POLICY-REFUND-2026</source>";
  }

  if (prompt.includes("onboarding")) {
    return "A new project manager should confirm scope, stakeholders, delivery cadence, risk log ownership, and access to delivery repositories. <source>KB-ONBOARDING-19</source>";
  }

  return `The request was handled through the ${routeDecision.route.toLowerCase()} route with evidence capture enabled. <source>POLICY-REFUND-2026</source>`;
}

function parseSources(text) {
  const matches = [...String(text).matchAll(/<source>(.*?)<\/source>/gis)];
  return matches.flatMap(match => match[1].split(",").map(s => s.trim()).filter(Boolean));
}

function verifySources(sources) {
  if (sources.length === 0) {
    return { ok: false, reason: "missing_source_tags", hallucinated: [] };
  }
  const hallucinated = sources.filter(source => !sourceRegistry.has(source));
  return {
    ok: hallucinated.length === 0,
    reason: hallucinated.length ? "unknown_source_ids" : "source_registry_match",
    hallucinated
  };
}

function fallbackSearch(prompt) {
  const promptText = String(prompt).toLowerCase();
  if (promptText.includes("loan") || promptText.includes("credit")) {
    return {
      recovered: true,
      source: "POLICY-CREDIT-EU-7",
      answer: "The answer was suspended because the model omitted sources. Fallback verification found the relevant credit decision policy and recommends human review before any applicant-level decision."
    };
  }
  return {
    recovered: true,
    source: "POLICY-REFUND-2026",
    answer: "The answer was suspended because the model omitted sources. Fallback verification found the closest governed policy and produced a cautious summary."
  };
}

function judgeResponse(text, payload) {
  const lower = String(text).toLowerCase();
  const issues = [];
  if (lower.includes("always approve") || lower.includes("always reject")) issues.push("overconfident_decision");
  if (lower.includes("race") || lower.includes("religion") || lower.includes("gender")) issues.push("protected_attribute_risk");
  if (payload.metadata.industry === "financial_services" && !lower.includes("human review")) issues.push("regulated_decision_requires_review");

  return {
    passed: issues.length === 0,
    score: Math.max(0.2, 1 - issues.length * 0.25),
    issues
  };
}

function redactSources(text) {
  return String(text).replace(/\s*<source>.*?<\/source>/gis, "").trim();
}

function recordAudit(entry) {
  auditLog.unshift({ timestamp: now(), ...entry });
  auditLog.splice(50);
}

async function processRequest(payload) {
  const started = Date.now();
  const validation = validateRequest(payload);

  if (!validation.valid) {
    const result = {
      accepted: false,
      layer: "prevent",
      decision: "drop",
      errors: validation.errors
    };
    recordAudit({ request_id: payload && payload.request_id, decision: "drop", reason: validation.errors.join("; ") });
    return result;
  }

  const session = sessionFor(payload.session_id);
  const routeDecision = route(payload.metadata);
  const scrub = scrubPrompt(payload.prompt);
  const modifiedPrompt = injectInstruction(scrub.scrubbed, routeDecision);
  const tokenEstimate = estimateTokens(modifiedPrompt);

  session.requests += 1;
  session.token_count += tokenEstimate;
  session.updated_at = now();

  let modelText = simulateFoundationModel(modifiedPrompt, { ...payload, prompt: scrub.scrubbed }, routeDecision);
  let sources = parseSources(modelText);
  let sourceVerification = verifySources(sources);
  let fallback = null;

  if (!sourceVerification.ok) {
    fallback = fallbackSearch(scrub.scrubbed);
    modelText = `${fallback.answer} <source>${fallback.source}</source>`;
    sources = parseSources(modelText);
    sourceVerification = verifySources(sources);
  }

  const judge = routeDecision.requiresJudge ? judgeResponse(modelText, payload) : null;
  const finalText = redactSources(modelText);
  const decision = judge && !judge.passed ? "flag_for_human_review" : "allow";

  const result = {
    accepted: true,
    decision,
    layers: {
      prevent: { schema_valid: true, scrubbed_entities: scrub.findings },
      control: {
        route: routeDecision.route,
        risk: routeDecision.risk,
        verification: routeDecision.verification,
        latency_budget_ms: routeDecision.latencyBudgetMs
      },
      prompt_modifier: {
        injected: true,
        model_prompt_preview: modifiedPrompt.slice(0, 220)
      },
      verify: {
        sources,
        source_verification: sourceVerification,
        fallback_used: Boolean(fallback),
        judge
      }
    },
    session: {
      session_id: session.session_id,
      token_count: session.token_count,
      tool_calls: session.tool_calls,
      requests: session.requests,
      max_tokens: routeDecision.policy.maxTokens,
      max_tool_calls: routeDecision.policy.maxToolCalls
    },
    final_answer: finalText,
    raw_model_answer: modelText,
    scrubbed_prompt: scrub.scrubbed,
    telemetry: {
      latency_ms: Date.now() - started,
      estimated_tokens: tokenEstimate,
      estimated_cost_usd: Number((tokenEstimate * 0.000002).toFixed(6))
    }
  };

  recordAudit({
    request_id: payload.request_id,
    session_id: payload.session_id,
    use_case: payload.metadata.use_case,
    decision,
    route: routeDecision.route,
    scrubbed_entities: scrub.findings.length,
    fallback_used: Boolean(fallback),
    judge_passed: judge ? judge.passed : null
  });

  return result;
}

function authorizeAction(payload) {
  const { user_id, session_id, tool_name, arguments_hash, status = "planned" } = payload || {};
  const session = sessionFor(session_id || "unknown");
  const useCase = payload && payload.use_case ? payload.use_case : "high_risk_external";
  const policy = policies[useCase] || policies.high_risk_external;
  const failureKey = `${tool_name}:${arguments_hash || "no-args"}`;

  if (!user_id || !session_id || !tool_name) {
    return { allowed: false, reason: "malformed_action_request" };
  }

  if (!policy.allowedTools.includes(tool_name)) {
    recordAudit({ session_id, user_id, decision: "block_action", reason: "tool_not_allowed", tool_name });
    return { allowed: false, reason: "tool_not_allowed", allowed_tools: policy.allowedTools };
  }

  if (status === "failed") {
    session.repeated_failures[failureKey] = (session.repeated_failures[failureKey] || 0) + 1;
  }

  if (session.repeated_failures[failureKey] >= 3 || session.tool_calls >= policy.maxToolCalls) {
    session.blocked = true;
    recordAudit({ session_id, user_id, decision: "circuit_breaker", reason: "repeat_failure_or_budget", tool_name });
    return {
      allowed: false,
      reason: "circuit_breaker_open",
      failed_attempts: session.repeated_failures[failureKey] || 0,
      tool_calls: session.tool_calls,
      max_tool_calls: policy.maxToolCalls
    };
  }

  session.tool_calls += 1;
  session.updated_at = now();
  recordAudit({ session_id, user_id, decision: "allow_action", tool_name });
  return {
    allowed: true,
    reason: "authorized",
    tool_calls: session.tool_calls,
    remaining_tool_budget: policy.maxToolCalls - session.tool_calls
  };
}

function getDashboard() {
  return {
    policies,
    sessions: [...sessions.values()],
    auditLog,
    metrics: {
      total_events: auditLog.length,
      blocked_or_flagged: auditLog.filter(event => ["drop", "block_action", "circuit_breaker", "flag_for_human_review"].includes(event.decision)).length,
      fallbacks: auditLog.filter(event => event.fallback_used).length
    }
  };
}

module.exports = {
  policies,
  validateRequest,
  scrubPrompt,
  route,
  injectInstruction,
  parseSources,
  verifySources,
  processRequest,
  authorizeAction,
  getDashboard
};
