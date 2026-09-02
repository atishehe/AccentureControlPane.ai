let scenarios = [];
let activeScenarioId = null;

const scenarioList = document.querySelector("#scenarioList");
const scenarioCount = document.querySelector("#scenarioCount");
const payloadEditor = document.querySelector("#payloadEditor");
const scenarioDescription = document.querySelector("#scenarioDescription");
const resultBox = document.querySelector("#resultBox");
const decisionBadge = document.querySelector("#decisionBadge");
const pipeline = document.querySelector("#pipeline");
const streamOutput = document.querySelector("#streamOutput");
const copyPayloadBtn = document.querySelector("#copyPayloadBtn");
const copyResultBtn = document.querySelector("#copyResultBtn");

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function previewExplainer(scenario) {
  const piiBox = document.querySelector("#expPiiFindings");
  const routingBox = document.querySelector("#expRoutingStatus");
  const riskBox = document.querySelector("#expRiskScores");
  const decisionBox = document.querySelector("#expPolicyDecision");
  const statusPill = document.querySelector("#explainerStatusPill");

  if (statusPill) statusPill.textContent = "Scenario Selected";

  const meta = scenario.payload?.metadata || {};
  const hasSSN = scenario.payload?.prompt?.includes("123-45-6789") || scenario.payload?.prompt?.includes("SSN");
  const hasCard = scenario.payload?.prompt?.includes("4111");

  if (piiBox) {
    if (hasSSN || hasCard) {
      piiBox.innerHTML = `<span class="tag-badge warn">PII</span> Sensitive pattern detected. Will be masked to <code>XXX-XX-XXXX</code>.`;
    } else {
      piiBox.innerHTML = `<span class="tag-badge ok">Clean</span> Payload ready for schema validation.`;
    }
  }

  if (routingBox) {
    if (meta.simulate_provider_rate_limit) {
      routingBox.innerHTML = `<span class="tag-badge warn">Failover</span> Primary route configured with secondary fallback.`;
    } else if (scenario.id === "semantic-cache") {
      routingBox.innerHTML = `<span class="tag-badge info">Cache</span> Request evaluated against cache index.`;
    } else {
      routingBox.innerHTML = `<span class="tag-badge info">Route</span> Model: <code>${meta.requested_model || "default"}</code> | Budget: <code>${meta.latency_budget_ms || 1200}ms</code>`;
    }
  }

  if (riskBox) {
    if (meta.simulate_bias_risk) {
      riskBox.innerHTML = `<span class="tag-badge danger">Review</span> Protected attribute detected; high responsibility weight.`;
    } else if (meta.simulate_confidently_wrong) {
      riskBox.innerHTML = `<span class="tag-badge warn">Review</span> Assertion check enabled; eligible for judge review.`;
    } else if (meta.simulate_missing_source) {
      riskBox.innerHTML = `<span class="tag-badge warn">Grounding</span> Missing citations will trigger evidence search.`;
    } else {
      riskBox.innerHTML = `<span class="tag-badge ok">Standard</span> Routine policy evaluation.`;
    }
  }

  if (decisionBox) {
    decisionBox.innerHTML = `<span class="tag-badge info">Standby</span> Ready to run inspection.`;
  }
}

function previewTraceDetail(scenario) {
  const container = document.querySelector("#traceDetailContent");
  const evalPill = document.querySelector("#traceEvalPill");
  if (!container) return;

  if (evalPill) evalPill.textContent = "Preset Loaded";

  container.innerHTML = `
    <div class="trace-detail-section">
      <div class="trace-section-title">
        <span>Selected Scenario</span>
      </div>
      <div class="trace-section-body">
        <p><strong>${scenario.name}:</strong> ${scenario.description}</p>
        <p style="color:var(--text-secondary); margin-top:6px;">Click <strong>Run</strong> or <strong>Stream</strong> to execute this payload through the pipeline and inspect live verification telemetry.</p>
      </div>
    </div>
  `;
}

function selectScenario(id) {
  activeScenarioId = id;
  const scenario = scenarios.find(item => item.id === id);
  if (!scenario) return;
  payloadEditor.value = pretty(scenario.payload);
  scenarioDescription.textContent = scenario.description;
  renderScenarios();
  previewExplainer(scenario);
  previewTraceDetail(scenario);
}

function renderScenarios() {
  scenarioList.innerHTML = "";
  for (const scenario of scenarios) {
    const card = document.createElement("button");
    const isActive = scenario.id === activeScenarioId;
    card.className = `scenario-card ${isActive ? "active" : ""}`;
    card.innerHTML = `
      <strong>${scenario.name}</strong>
      <span>${scenario.description}</span>
    `;
    card.addEventListener("click", () => selectScenario(scenario.id));
    scenarioList.appendChild(card);
  }
}

function stage(name, detail, state = "ok") {
  return `
    <div class="stage ${state}">
      <strong>${name}</strong>
      <span>${detail}</span>
    </div>
  `;
}

function setDecisionBadge(decision) {
  decisionBadge.textContent = decision;
  const normalized = (decision || "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  decisionBadge.className = `decision-pill ${normalized}`;
}

function renderPipeline(result) {
  if (!result.accepted) {
    pipeline.innerHTML = [
      stage("Prevent", "Schema failed; request dropped before model call.", "danger"),
      stage("Gate", "No action requested", "warn"),
      stage("Verify", "Not reached", "warn"),
      stage("Control", "Fail-closed", "danger")
    ].join("");
    return;
  }

  const scrubbed = result.layers.prevent.pii_findings.length
    ? `${result.layers.prevent.pii_findings.map(item => `${item.count || 1} ${item.type}`).join(", ")} masked`
    : "No sensitive data detected";
  const risk = result.layers.verify.risk_score;
  const judge = result.layers.verify.judge_invocation;
  const verifyText = risk
    ? `Risk ${risk.overall_risk}; Judge ${judge?.invoke ? "invoked" : "skipped"}`
    : result.layers.verify.fallback_used ? "Fallback recovered evidence" : "Sources matched registry";

  pipeline.innerHTML = [
    stage("Prevent", scrubbed, result.layers.prevent.pii_findings.length ? "warn" : "ok"),
    stage("Gate", `${result.layers.gate.session_tool_calls} tool calls; circuit ${result.layers.gate.circuit_open ? "open" : "closed"}`, result.layers.gate.circuit_open ? "danger" : "ok"),
    stage("Verify", verifyText, result.layers.verify.fallback_used || result.decision === "edit" ? "warn" : result.decision === "block" ? "danger" : "ok"),
    stage(
      "Control",
      result.cache?.hit ? `Cache hit (${result.cache.similarity})` : `${result.layers.control.route}`,
      result.cache?.hit ? "ok" : "ok"
    )
  ].join("");
}

function renderExplainer(result) {
  const piiBox = document.querySelector("#expPiiFindings");
  const routingBox = document.querySelector("#expRoutingStatus");
  const riskBox = document.querySelector("#expRiskScores");
  const decisionBox = document.querySelector("#expPolicyDecision");
  const statusPill = document.querySelector("#explainerStatusPill");

  if (!result || !result.accepted) {
    if (statusPill) statusPill.textContent = "Rejected at Ingestion";
    if (piiBox) piiBox.innerHTML = `<span class="tag-badge danger">DROP</span> Schema violation: Request dropped fail-closed before model call.`;
    if (routingBox) routingBox.innerHTML = `<span class="tag-badge warn">HALTED</span> Model execution bypassed. Zero tokens spent.`;
    if (riskBox) riskBox.innerHTML = `<span class="tag-badge warn">BYPASSED</span> Verification phase not reached.`;
    if (decisionBox) decisionBox.innerHTML = `<span class="tag-badge danger">BLOCKED</span> Zero risk allowed into runtime.`;
    return;
  }

  if (statusPill) statusPill.textContent = `Evaluation Complete (${(result.decision || "").toUpperCase()})`;

  // Phase 1: PII & Gate
  const piiFindings = result.layers?.prevent?.pii_findings || [];
  if (piiFindings.length > 0) {
    const piiSummary = piiFindings.map(f => `<span class="tag-badge warn">${f.count || 1} ${f.type}</span>`).join(" ");
    piiBox.innerHTML = `${piiSummary} Redacted to <code>XXX-XX-XXXX</code> before model dispatch.`;
  } else {
    piiBox.innerHTML = `<span class="tag-badge ok">CLEAN</span> Valid schema. No structured sensitive entities or PII detected.`;
  }

  // Phase 2: Routing & Control
  const isCache = result.cache?.hit;
  const route = result.layers?.control?.route || "direct";
  const failover = result.layers?.provider_events?.includes("primary_rate_limit");
  if (isCache) {
    routingBox.innerHTML = `<span class="tag-badge ok">CACHE HIT</span> Similarity ${result.cache.similarity}. Bypassed model (0 tokens spent).`;
  } else if (failover) {
    routingBox.innerHTML = `<span class="tag-badge warn">FAILOVER</span> Primary 429'd; switched mid-flight to fallback model route.`;
  } else {
    routingBox.innerHTML = `<span class="tag-badge info">ROUTED</span> Dispatched to <code>${route}</code> with source citation rules.`;
  }

  // Phase 3: Verification & Risk
  const risk = result.layers?.verify?.risk_score;
  const judge = result.layers?.verify?.judge_invocation;
  const fallbackUsed = result.layers?.verify?.fallback_used;
  if (risk) {
    const judgeTag = judge?.invoke 
      ? `<span class="tag-badge ${judge.passed ? "ok" : "danger"}">Judge Invoked</span>` 
      : `<span class="tag-badge ok">Judge Skipped</span>`;
    const fallbackTag = fallbackUsed ? `<span class="tag-badge warn">Fallback Cited</span>` : ``;
    riskBox.innerHTML = `${judgeTag} ${fallbackTag} Perf: ${risk.performance_risk} | Cost: ${risk.cost_risk} | Resp: ${risk.responsibility_risk}`;
  } else {
    riskBox.innerHTML = `<span class="tag-badge ok">VERIFIED</span> Sources checked against trusted registry.`;
  }

  // Phase 4: Sanitization & Policy Decision
  const dec = result.decision || "allow";
  const reason = result.decision_policy?.reason || "risk_within_policy";
  const decClass = dec === "allow" ? "ok" : dec === "edit" ? "warn" : "danger";
  const outputSanitized = result.layers?.verify?.output_sanitization?.length > 0;
  decisionBox.innerHTML = `<span class="tag-badge ${decClass}">${dec.toUpperCase()}</span> ${reason.replace(/_/g, " ")}. ${outputSanitized ? "Output sanitized." : "Clean."}`;
}

function renderTraceDetail(result) {
  const container = document.querySelector("#traceDetailContent");
  const evalPill = document.querySelector("#traceEvalPill");
  if (!container) return;

  if (!result) {
    if (evalPill) evalPill.textContent = "Awaiting Run";
    container.innerHTML = `<div class="trace-empty-state">Select a scenario and click <strong>Run</strong> or <strong>Stream</strong> to inspect the detailed execution and output analysis.</div>`;
    return;
  }

  const dec = (result.decision || "unknown").toUpperCase();
  if (evalPill) evalPill.textContent = `Verdict: ${dec}`;

  if (!result.accepted) {
    container.innerHTML = `
      <div class="trace-detail-section">
        <div class="trace-section-title">
          <span>Verdict &amp; Enforcement</span>
          <span class="tag-badge danger">Dropped</span>
        </div>
        <div class="trace-section-body">
          <p><strong>Fail-Closed Schema Drop:</strong> The incoming payload violated strict Pydantic schema validation. The proxy terminated execution immediately with HTTP 422.</p>
          <p><strong>Safety Impact:</strong> Zero tokens consumed. Zero unverified parameters reached the foundation model runtime.</p>
        </div>
      </div>
    `;
    return;
  }

  // 1. Verdict & Decision Rationale
  const decClass = dec === "ALLOW" ? "ok" : dec === "EDIT" ? "warn" : "danger";
  const reason = (result.decision_policy?.reason || "standard_policy").replace(/_/g, " ");
  let verdictExplanation = "";
  if (dec === "ALLOW") {
    verdictExplanation = "Output passed all inline verification gates. Evidence citations confirmed in registry, and risk scores remain safely below threshold.";
  } else if (dec === "EDIT") {
    verdictExplanation = "Output was sanitized prior to release. Internal source tags were stripped, and/or detected sensitive entities were masked.";
  } else {
    verdictExplanation = "Output was blocked by policy enforcement. Composite risk exceeded tolerance or the secondary AI Judge rejected the assertion.";
  }

  // 2. DLP & Privacy
  const piiFindings = result.layers?.prevent?.pii_findings || [];
  const sanitizations = result.layers?.verify?.output_sanitization || [];
  let dlpSummary = "";
  if (piiFindings.length > 0) {
    const list = piiFindings.map(f => `${f.count || 1} ${f.type}`).join(", ");
    dlpSummary = `Inbound prompt contained sensitive entities (<code>${list}</code>). Redacted to safe tokens before dispatch.`;
  } else {
    dlpSummary = "Inbound prompt was verified clean of sensitive personal data.";
  }
  if (sanitizations.length > 0) {
    dlpSummary += ` Outbound sanitization applied: ${sanitizations.join(", ")}.`;
  }

  // 3. Routing, Cache & Provider Resiliency
  const isCache = result.cache?.hit;
  const route = result.layers?.control?.route || "direct";
  const events = result.layers?.provider_events || [];
  const hadFailover = events.includes("primary_rate_limit");
  let routeSummary = "";
  if (isCache) {
    routeSummary = `Resolved via <strong>Semantic Cache</strong> (${result.cache.similarity} similarity). Model inference bypassed (0ms latency, 0 token cost).`;
  } else if (hadFailover) {
    routeSummary = `Primary provider returned <strong>HTTP 429 Rate Limit</strong> mid-flight. Automatic circuit switch routed to <code>claude-3-haiku</code> without dropping user stream.`;
  } else {
    routeSummary = `Dispatched directly to primary route <code>${route}</code> with source citation constraints injected into system envelope.`;
  }

  // 4. Grounding & Evidence Verification
  const extracted = result.layers?.verify?.extracted_sources || [];
  const fallbackUsed = result.layers?.verify?.fallback_used;
  let groundingSummary = "";
  if (extracted.length > 0) {
    groundingSummary = `Citations verified in registry: ${extracted.map(s => `<code>${s}</code>`).join(" ")}.`;
  } else if (fallbackUsed) {
    groundingSummary = `Model omitted explicit citations. Async grounding search triggered to retrieve fallback evidence from document store.`;
  } else {
    groundingSummary = `Standard enterprise knowledge response audited against safety bounds.`;
  }

  // 5. Multi-Factor Risk & AI Judge
  const risk = result.layers?.verify?.risk_score;
  const judge = result.layers?.verify?.judge_invocation;

  let riskHtml = "";
  if (risk) {
    riskHtml = `
      <div class="trace-metric-chips">
        <span class="trace-chip">Overall: <strong>${risk.overall_risk}</strong></span>
        <span class="trace-chip">Perf: <strong>${risk.performance_risk}</strong></span>
        <span class="trace-chip">Cost: <strong>${risk.cost_risk}</strong></span>
        <span class="trace-chip">Resp: <strong>${risk.responsibility_risk}</strong></span>
      </div>
    `;
  }

  let judgeHtml = "";
  if (judge?.invoke) {
    judgeHtml = `<p style="margin-top:6px;"><strong>AI-as-a-Judge Invoked:</strong> ${judge.passed ? "Passed" : "Failed"}. Critique: <em>${judge.critique || judge.reason || "Review complete"}</em></p>`;
  } else {
    judgeHtml = `<p style="margin-top:6px; color:var(--text-secondary);"><strong>AI-as-a-Judge:</strong> Skipped (risk profile within standard threshold; conserved budget).</p>`;
  }

  container.innerHTML = `
    <!-- Verdict -->
    <div class="trace-detail-section">
      <div class="trace-section-title">
        <span>Policy Verdict</span>
        <span class="tag-badge ${decClass}">${dec}</span>
      </div>
      <div class="trace-section-body">
        <p><strong>Reason:</strong> ${reason}</p>
        <p>${verdictExplanation}</p>
      </div>
    </div>

    <!-- DLP & Privacy -->
    <div class="trace-detail-section">
      <div class="trace-section-title">
        <span>Data Privacy &amp; DLP</span>
      </div>
      <div class="trace-section-body">
        <p>${dlpSummary}</p>
      </div>
    </div>

    <!-- Routing -->
    <div class="trace-detail-section">
      <div class="trace-section-title">
        <span>Routing &amp; Failover</span>
      </div>
      <div class="trace-section-body">
        <p>${routeSummary}</p>
      </div>
    </div>

    <!-- Grounding -->
    <div class="trace-detail-section">
      <div class="trace-section-title">
        <span>Source Grounding</span>
      </div>
      <div class="trace-section-body">
        <p>${groundingSummary}</p>
      </div>
    </div>

    <!-- Risk & Safety -->
    <div class="trace-detail-section">
      <div class="trace-section-title">
        <span>Risk &amp; Evaluation Profile</span>
      </div>
      <div class="trace-section-body">
        ${riskHtml}
        ${judgeHtml}
      </div>
    </div>
  `;
}

async function refreshDashboard() {
  try {
    const response = await fetch("/api/dashboard");
    const dashboard = await response.json();
    document.querySelector("#totalEvents").textContent = dashboard.metrics.total_events;
    document.querySelector("#blockedEvents").textContent = dashboard.metrics.blocked_or_flagged;
    document.querySelector("#editedEvents").textContent = dashboard.metrics.edited || 0;
    document.querySelector("#fallbackEvents").textContent = dashboard.metrics.fallbacks;
    document.querySelector("#cacheEntries").textContent = dashboard.metrics.cache_entries || 0;

    const auditContainer = document.querySelector("#auditLog");
    if (dashboard.auditLog && dashboard.auditLog.length > 0) {
      auditContainer.innerHTML = dashboard.auditLog.slice(0, 7).map(event => {
        const dec = (event.decision || "unknown").toLowerCase();
        return `
          <div class="audit-row">
            <span>${new Date(event.timestamp).toLocaleTimeString()}</span>
            <strong class="${dec}">${event.decision}</strong>
            <span title="${event.route || event.reason || event.tool_name || ""}">${event.route || event.reason || event.tool_name || "—"}</span>
          </div>
        `;
      }).join("");
    } else {
      auditContainer.innerHTML = `<span style="padding:14px; color:var(--text-muted); font-size:0.75rem;">Awaiting transactions...</span>`;
    }
  } catch (err) {
    console.error("Dashboard refresh error:", err);
  }
}

async function runInterceptor() {
  let payload;
  try {
    payload = JSON.parse(payloadEditor.value);
  } catch (error) {
    resultBox.textContent = pretty({ error: "Invalid JSON", detail: error.message });
    setDecisionBadge("Invalid JSON");
    return;
  }

  setDecisionBadge("Inspecting...");
  const response = await fetch("/api/intercept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  resultBox.textContent = pretty(result);
  streamOutput.textContent = result.final_answer || "No user-visible answer emitted.";
  setDecisionBadge(result.decision || result.errors?.[0] || "Completed");
  renderPipeline(result);
  renderExplainer(result);
  renderTraceDetail(result);
  await refreshDashboard();
}

async function runStream() {
  let payload;
  try {
    payload = JSON.parse(payloadEditor.value);
  } catch (error) {
    resultBox.textContent = pretty({ error: "Invalid JSON", detail: error.message });
    setDecisionBadge("Invalid JSON");
    return;
  }

  streamOutput.textContent = "";
  resultBox.textContent = "{}";
  setDecisionBadge("Streaming");

  const response = await fetch("/api/intercept/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let trace = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop();
    for (const eventText of events) {
      const eventLine = eventText.split("\n").find(line => line.startsWith("event:"));
      const dataLine = eventText.split("\n").find(line => line.startsWith("data:"));
      if (!eventLine || !dataLine) continue;
      const eventName = eventLine.replace("event:", "").trim();
      const data = JSON.parse(dataLine.replace("data:", "").trim());
      if (eventName === "token") streamOutput.textContent += data.text;
      if (eventName === "trace" || eventName === "blocked") trace = data;
    }
  }

  if (trace) {
    resultBox.textContent = pretty(trace);
    setDecisionBadge(trace.decision || "Completed");
    renderPipeline(trace);
    renderExplainer(trace);
    renderTraceDetail(trace);
  }
  await refreshDashboard();
}

async function simulateAction() {
  let payload;
  try {
    payload = JSON.parse(payloadEditor.value);
  } catch (error) {
    resultBox.textContent = pretty({ error: "Invalid JSON", detail: error.message });
    return;
  }

  setDecisionBadge("Simulating Tool...");
  const actionPayload = {
    user_id: payload.user_id,
    session_id: payload.session_id,
    use_case_tag: payload.metadata?.use_case_tag || "high_risk_external",
    tool_name: payload.metadata?.use_case_tag === "low_risk_internal" ? "knowledge_search" : "source_lookup",
    arguments_hash: "same-query",
    status: "failed"
  };

  const attempts = [];
  for (let i = 0; i < 4; i += 1) {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actionPayload)
    });
    attempts.push(await response.json());
  }

  resultBox.textContent = pretty({ simulated_action: actionPayload, attempts });
  setDecisionBadge(attempts.at(-1).reason || "Tripped");
  renderTraceDetail({
    accepted: true,
    decision: "block",
    final_answer: "Tool execution halted by circuit breaker.",
    decision_policy: { reason: attempts.at(-1).reason || "circuit_breaker_tripped" },
    layers: {
      prevent: { pii_findings: [] },
      gate: { session_tool_calls: attempts.length, circuit_open: true },
      control: { route: "agent_tool_firewall" },
      verify: {
        extracted_sources: [],
        risk_score: { overall_risk: 0.95, performance_risk: 0.9, cost_risk: 0.8, responsibility_risk: 0.2 },
        judge_invocation: { invoke: false }
      },
      provider_events: ["circuit_breaker_opened"]
    }
  });
  await refreshDashboard();
}

// Copy button handlers
if (copyPayloadBtn) {
  copyPayloadBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(payloadEditor.value).then(() => {
      const orig = copyPayloadBtn.textContent;
      copyPayloadBtn.textContent = "Copied!";
      setTimeout(() => copyPayloadBtn.textContent = orig, 1500);
    });
  });
}

if (copyResultBtn) {
  copyResultBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(resultBox.textContent).then(() => {
      const orig = copyResultBtn.textContent;
      copyResultBtn.textContent = "Copied!";
      setTimeout(() => copyResultBtn.textContent = orig, 1500);
    });
  });
}

async function boot() {
  try {
    const response = await fetch("/api/scenarios");
    const data = await response.json();
    scenarios = data.scenarios;
    selectScenario(scenarios[0].id);
    pipeline.innerHTML = [
      stage("Prevent", "Ready", "ok"),
      stage("Gate", "Ready", "ok"),
      stage("Verify", "Ready", "ok"),
      stage("Control", "Ready", "ok")
    ].join("");
    await refreshDashboard();
  } catch (err) {
    console.error("Boot error:", err);
  }
}

document.querySelector("#runButton").addEventListener("click", runInterceptor);
document.querySelector("#streamButton").addEventListener("click", runStream);
document.querySelector("#actionButton").addEventListener("click", simulateAction);
boot();
