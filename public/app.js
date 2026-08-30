let scenarios = [];
let activeScenarioId = null;

const scenarioList = document.querySelector("#scenarioList");
const payloadEditor = document.querySelector("#payloadEditor");
const scenarioDescription = document.querySelector("#scenarioDescription");
const resultBox = document.querySelector("#resultBox");
const decisionBadge = document.querySelector("#decisionBadge");
const pipeline = document.querySelector("#pipeline");
const streamOutput = document.querySelector("#streamOutput");

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function selectScenario(id) {
  activeScenarioId = id;
  const scenario = scenarios.find(item => item.id === id);
  payloadEditor.value = pretty(scenario.payload);
  scenarioDescription.textContent = scenario.description;
  renderScenarios();
}

function renderScenarios() {
  scenarioList.innerHTML = "";
  for (const scenario of scenarios) {
    const card = document.createElement("button");
    card.className = `scenario-card ${scenario.id === activeScenarioId ? "active" : ""}`;
    card.innerHTML = `<strong>${scenario.name}</strong><span>${scenario.description}</span>`;
    card.addEventListener("click", () => selectScenario(scenario.id));
    scenarioList.appendChild(card);
  }
}

function stage(name, detail, state = "ok") {
  return `<div class="stage ${state}"><strong>${name}</strong><span>${detail}</span></div>`;
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
    : "No structured sensitive data detected";

  pipeline.innerHTML = [
    stage("Prevent", scrubbed),
    stage("Gate", `${result.layers.gate.session_tool_calls} tool calls; circuit ${result.layers.gate.circuit_open ? "open" : "closed"}`),
    stage("Verify", result.layers.verify.fallback_used ? "Fallback search recovered source evidence" : "Source tags matched registry", result.layers.verify.fallback_used ? "warn" : "ok"),
    stage(
      "Control",
      result.cache?.hit ? `Semantic cache hit (${result.cache.similarity})` : `${result.layers.control.route}; ${result.layers.control.bucket.store}`,
      result.cache?.hit ? "warn" : "ok"
    )
  ].join("");
}

async function refreshDashboard() {
  const response = await fetch("/api/dashboard");
  const dashboard = await response.json();
  document.querySelector("#totalEvents").textContent = dashboard.metrics.total_events;
  document.querySelector("#blockedEvents").textContent = dashboard.metrics.blocked_or_flagged;
  document.querySelector("#fallbackEvents").textContent = dashboard.metrics.fallbacks;
  document.querySelector("#cacheEntries").textContent = dashboard.metrics.cache_entries || 0;
  document.querySelector("#auditLog").innerHTML = dashboard.auditLog.slice(0, 6).map(event => `
    <div class="audit-row">
      <span>${new Date(event.timestamp).toLocaleTimeString()}</span>
      <strong>${event.decision}</strong>
      <span>${event.route || event.reason || event.tool_name || ""}</span>
    </div>
  `).join("") || "<span>No events yet</span>";
}

async function runInterceptor() {
  let payload;
  try {
    payload = JSON.parse(payloadEditor.value);
  } catch (error) {
    resultBox.textContent = pretty({ error: "Invalid JSON", detail: error.message });
    decisionBadge.textContent = "Invalid JSON";
    return;
  }

  const response = await fetch("/api/intercept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  resultBox.textContent = pretty(result);
  streamOutput.textContent = result.final_answer || "No user-visible answer emitted.";
  decisionBadge.textContent = result.decision || result.errors?.[0] || "Completed";
  renderPipeline(result);
  await refreshDashboard();
}

async function runStream() {
  let payload;
  try {
    payload = JSON.parse(payloadEditor.value);
  } catch (error) {
    resultBox.textContent = pretty({ error: "Invalid JSON", detail: error.message });
    decisionBadge.textContent = "Invalid JSON";
    return;
  }

  streamOutput.textContent = "";
  resultBox.textContent = "{}";
  decisionBadge.textContent = "Streaming";

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
    decisionBadge.textContent = trace.decision || "Completed";
    renderPipeline(trace);
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
  decisionBadge.textContent = attempts.at(-1).reason;
  await refreshDashboard();
}

async function boot() {
  const response = await fetch("/api/scenarios");
  const data = await response.json();
  scenarios = data.scenarios;
  selectScenario(scenarios[0].id);
  pipeline.innerHTML = [
    stage("Prevent", "Ready"),
    stage("Gate", "Ready"),
    stage("Verify", "Ready"),
    stage("Control", "Ready")
  ].join("");
  await refreshDashboard();
}

document.querySelector("#runButton").addEventListener("click", runInterceptor);
document.querySelector("#streamButton").addEventListener("click", runStream);
document.querySelector("#actionButton").addEventListener("click", simulateAction);
boot();
