# ControlPlane.ai

ControlPlane.ai is an AI Governance Middleware Proxy for Track 1. It sits between client apps and foundation model APIs and enforces a `Prevent -> Gate -> Verify -> Control` architecture in real time.

The model should not be the only thing making decisions. The proxy checks the request before it reaches the model, watches the model while it streams, verifies the answer before it is shown, and logs enough context for a governance team to explain what happened.

> [!IMPORTANT]
> **Prerequisites Check:** Before running, please ensure you have checked the [Prerequisites & Setup Instructions](#8-execution-instructions) (Python 3.10–3.12 and dependencies installed via `pip install -r requirements.txt`).

## 1. Demo First: How to run

Run the app:

```bash
.venv\Scripts\python.exe run.py
```

Open:

```text
http://127.0.0.1:8000
```

Then use these demo actions on the page:

1. Select `PII Shield + High-Risk Verify` and click `Run`.
2. Select `Semantic Cache Cost Save` and click `Run` twice.
3. Select `Citation Recovery Branch` and click `Stream`.
4. Select `Provider Rate-Limit Failover` and click `Stream`.
5. Click `Simulate Action`.
6. Select `Fail-Closed Schema Drop` and click `Run`.
7. Select `Confidently Wrong Detector` and click `Run`.
8. Select `Bias Risk Detector` and click `Run`.
9. Select `The Perfect Storm (Multi-Risk)` and click `Run` or `Stream`.

## 2. The Output

When the evaluator runs the demo, the interface presents five distinct observational surfaces:

### Inspection Pipeline Flow

This shows the four-stage inline governance progression:

- `Prevent`: Confirms schema validity and PII masking results.
- `Gate`: Displays session tool invocations and circuit breaker status.
- `Verify`: Reports source grounding match, async recovery, and judge status.
- `Control`: Shows model routing, token budgeting, and semantic cache status.

### Sanitized User-Facing Output

Displays the sanitized response emitted token-by-token (via SSE) or buffered. Internal `<source>` tags and sensitive personal entities are scrubbed before reaching this container.

### Trace Telemetry JSON (Top Vertical Basin)

The raw structured JSON telemetry emitted by the proxy engine, containing exact timestamps, layer metrics, session states, and sanitized prompt envelopes. One-click copyable.

### Execution Analysis & Decision Breakdown (Bottom Vertical Basin)

An executive-level operational breakdown explaining the output in plain, structured engineering language:

- `Policy Verdict & Reason`: Explains why `ALLOW`, `EDIT`, or `BLOCK` was issued.
- `Data Privacy & DLP`: Reports specific PII entities intercepted and redacted.
- `Routing & Resiliency`: Documents route selection, cache hits, or mid-stream 429 provider failover.
- `Source Grounding`: Verifies document IDs cited against the enterprise registry.
- `Risk & Safety Profile`: Displays numeric tri-risk scores (`overall_risk`, `performance_risk`, `cost_risk`, `responsibility_risk`) and secondary AI Judge critique.

### Audit Log & Lifecycle Explainer

- **Audit Ledger**: A live compliance trail recording each transaction, timestamp, decision, and route.
- **Execution Lifecycle**: Four architectural cards detailing input defense, generation control, verification scoring, and final policy sanitization.

## 3. What Each Demo Proves

### `PII Shield + High-Risk Verify`

This shows the Prevent layer and the high-risk route working together.

Expected output:

- SSN and credit card data are masked in `scrubbed_prompt`
- the route becomes `heavy_verification`
- the answer is validated against governed source IDs
- source tags are removed from the final user answer

### `Semantic Cache Cost Save`

This shows cost reduction through repeated verified prompts.

Expected output:

- first run goes through the model path
- second run returns `allow_cached`
- telemetry shows near-zero token usage on the second run

### `Citation Recovery Branch`

This shows the verify fallback branch.

Expected output:

- the model answer intentionally omits source tags
- the verifier suspends the response
- fallback recovery produces a grounded answer
- the final text is still clean for the user

### `Provider Rate-Limit Failover`

This shows mid-stream resilience.

Expected output:

- the stream starts token by token
- the trace includes `primary_rate_limit`
- the fallback provider continues the response

### `Simulate Agent Action`

This shows the Gate layer.

Expected output:

- repeated identical failed tool calls are tracked
- the circuit breaker opens
- later calls are denied with `circuit_breaker_open`

### `Fail-Closed Schema Drop`

This shows the Prevent layer rejecting bad input.

Expected output:

- missing required fields cause a `422` response
- the proxy returns `decision: drop`
- no model call is made

### `Confidently Wrong Detector`

This shows the performance-risk detector.

Expected output:

- the response contains overconfident language in the simulated model path
- `performance_risk` increases
- `judge_invocation.invoke` becomes `true`
- the final decision becomes `block`

### `Bias Risk Detector`

This shows responsibility-risk detection.

Expected output:

- protected-attribute language is detected
- `responsibility_risk` increases
- the judge branch is invoked because risk and budget justify it
- the final decision becomes `block`

### `The Perfect Storm (Multi-Risk)`

This demonstrates the proxy's capability to orchestrate concurrent, multi-vector enterprise governance failures in a single transaction.

Expected output:

- Inbound SSN is masked in `scrubbed_prompt` (`Prevent` layer)
- Primary model stream encounters an HTTP 429 rate limit and fails over mid-stream to `claude-3-haiku` (`Control` layer)
- Omission of source tags triggers asynchronous evidence retrieval fallback (`Verify` layer)
- Overconfident phrasing and protected demographic terms drive up `performance_risk` and `responsibility_risk`
- Secondary AI Judge is dynamically invoked to review the assertion
- Final response is safely intercepted and blocked or edited according to unified policy

## 4. Solution Architecture

ControlPlane.ai sits between client applications and foundation model runtimes as an **inline governance middleware proxy**. Rather than trusting the foundation model to self-police via system prompts, the proxy enforces deterministic policy verification across four decoupled layers:

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                 INCOMING CLIENT REQUEST                 │
                  └────────────────────────────┬────────────────────────────┘
                                               │
                                               ▼
         ┌──────────────────────────────────────────────────────────────────────────┐
         │ 1. PREVENT LAYER (Inbound Gateway Defense)                              │
         │  • Strict Pydantic Schema Validation (Drop malformed payloads fail-close) │
         │  • Presidio DLP & Regex Masking (Scrub SSNs, CCs, PII to safe tokens)   │
         └─────────────────────────────────────┬────────────────────────────────────┘
                                               │
                                               ▼
         ┌──────────────────────────────────────────────────────────────────────────┐
         │ 2. GATE LAYER (Autonomous Agent Firewall)                               │
         │  • Session Tool Tracking & Authorization Checks                          │
         │  • Exponential Failure Tracker & Automatic Circuit Breaker Trips         │
         └─────────────────────────────────────┬────────────────────────────────────┘
                                               │
                                               ▼
         ┌──────────────────────────────────────────────────────────────────────────┐
         │ 3. CONTROL LAYER (Economics, Routing & Failover)                         │
         │  • Semantic Embedding Cache Lookup (0ms latency, 0 tokens on hit)        │
         │  • Dynamic Provider Routing & Mid-Stream 429 Failover (Primary -> Claude)│
         │  • Session Token Bucket Allocation & Rate Throttling                     │
         └─────────────────────────────────────┬────────────────────────────────────┘
                                               │
                                               ▼
                                   [ FOUNDATION MODEL RUNTIME ]
                                               │
                                               ▼
         ┌──────────────────────────────────────────────────────────────────────────┐
         │ 4. VERIFY & SANITIZE LAYER (Post-Generation Audit)                       │
         │  • Registry Grounding Audit (Matches <source> tags vs known documents)   │
         │  • Asynchronous Grounding Fallback Search (Recovers missing evidence)   │
         │  • Tri-Factor Risk Scoring (Performance, Cost, Responsibility / Bias)    │
         │  • Adaptive AI-as-a-Judge Escalation (Invoked only when risk justifies)  │
         │  • Final Outbound Sanitization (Strips internal tags & masks leaks)      │
         └─────────────────────────────────────┬────────────────────────────────────┘
                                               │
                                               ▼
                  ┌─────────────────────────────────────────────────────────┐
                  │       SANITIZED USER ANSWER + AUDIT TELEMETRY           │
                  └─────────────────────────────────────────────────────────┘
```

### Layer Breakdown

1. **Prevent (Inbound Screening):**
   * Pydantic enforces strict contract validation, dropping malformed payloads with HTTP 422 before token consumption.
   * Microsoft Presidio Analyzer and regex redactors detect structured sensitive entities (SSNs, credit card numbers, confidential IDs) and mask them in-flight before the model sees them.

2. **Gate (Agent Execution Guard):**
   * Monitors autonomous tool calls and agent loops.
   * Enforces tool-level authorization policies and tracks consecutive failure frequencies.
   * Trips an automatic circuit breaker when repeated failures occur, halting runaway loops and preventing budget exhaustion.

3. **Control (Routing & Economics):**
   * Inspects semantic cache embeddings (cosine similarity >= 0.90) to serve repeat queries instantly at zero cost.
   * Employs LiteLLM-compatible abstraction for intelligent model dispatch (`gpt-4o-mini` primary).
   * Intercepts upstream HTTP 429 rate limit exceptions mid-SSE stream and routes failover to secondary providers (`claude-3-haiku`) without dropping the client connection.

4. **Verify & Sanitize (Grounding & Safety Audit):**
   * Verifies hidden `<source>...</source>` citations against an authoritative document store (`SOURCE_REGISTRY`).
   * Triggers an asynchronous fallback search if the model hallucinates or omits citations.
   * Calculates a composite tri-risk score across Performance, Cost, and Responsibility.
   * Strips all internal source tags and leaked tokens before returning the final response to the user.

## 5. Risk Scoring And Decisions

The proxy computes a normalized tri-factor composite risk score:

* **`performance_risk`**: Measures hallucination likelihood, lack of registry-backed source citations, and overconfident asserting language.
* **`cost_risk`**: Tracks token budget depletion, upstream provider failover occurrences, and high token utilization.
* **`responsibility_risk`**: Flags demographic bias, protected personal attributes, and sensitive entity context.

Based on the composite risk matrix, the proxy enforces an explicit policy decision:
* **`ALLOW`**: Response passed all safety checks and citations; within normal risk tolerances.
* **`EDIT`**: Response contained sensitive entities or internal source metadata; sanitized before user delivery.
* **`BLOCK`**: Response exceeded allowable composite risk or was rejected by secondary AI Judge review.

### Adaptive AI-as-a-Judge Escalation (Economics of AI)

Calling a secondary LLM-as-a-Judge on every request is economically unviable and adds unacceptable latency. ControlPlane.ai uses an **adaptive escalation pattern**:
1. Run fast, deterministic heuristic scoring first.
2. If risk exceeds the use-case threshold AND the session has sufficient token and latency budget, invoke the Judge.
3. If risk is low or budget is constrained, skip the Judge and resolve via deterministic policy.

## 6. Implementation Approach

ControlPlane.ai is engineered with a strict **separation of concerns** between protocol ingestion, security middleware, and evaluation visualization:

* **Modular Decoupling**: The governance proxy (`app/services.py`) is completely independent of FastAPI web endpoints (`app/main.py`) and browser presentation code (`public/`). The core engine can be embedded as an ASGI middleware, a sidecar proxy, or a standalone API gateway.
* **Zero-Cold-Start In-Memory Architecture**: Designed to run immediately without requiring third-party cloud credentials. Presidio, semantic embeddings, and source registries fall back gracefully to local deterministic mocks if external enterprise infrastructure (Dragonfly, Redis, Qdrant) is absent.
* **Real-Time SSE Streaming Interception**: Rather than buffering entire responses before auditing, the proxy processes Server-Sent Events (SSE) token-by-token. If an upstream provider rate limits mid-stream, the proxy intercepts the event and continues the stream from a backup provider seamlessly.
* **Closed-Loop Feedback Sensitivity**: Exposes `/api/feedback` to dynamically adjust future risk thresholds. Feedback is incorporated into runtime multipliers to prevent alert fatigue while tightening enforcement on recurring violations.

## 7. Dependencies

| Package | Version | Purpose & Rationale | Fallback / Resilience |
| :--- | :---: | :--- | :--- |
| **`fastapi`** | `^0.110.0` | High-performance async ASGI web framework for REST & SSE streaming | Core requirement |
| **`uvicorn`** | `^0.28.0` | Production-grade ASGI server implementation | Core requirement |
| **`pydantic`** | `^2.6.0` | Strict schema validation and fail-closed data contract enforcement | Core requirement |
| **`httpx`** | `^0.27.0` | Asynchronous HTTP client for provider communication & mock streams | Core requirement |
| **`presidio-analyzer`** | `^2.2.35` | Enterprise DLP engine for entity and PII detection | Deterministic regex masking |
| **`presidio-anonymizer`** | `^2.2.35` | PII anonymization and token replacement | Safe placeholder redaction |
| **`litellm`** | `^1.30.0` | Multi-provider LLM abstraction layer for dynamic model routing | Simulated deterministic router |
| **`redis`** | `^5.0.0` | Distributed token bucket and rate limit storage | In-memory atomic token bucket |

## 8. Execution Instructions

### Prerequisites
* Python 3.10, 3.11, or 3.12 installed.

### Option A: Quick Start (Windows)

```powershell
# 1. Clone repository and enter directory
cd c:\ADrive\Accenture

# 2. Activate existing virtual environment
.\.venv\Scripts\Activate.ps1

# 3. Launch the governance proxy
python run.py
```

### Option B: Clean Install from Scratch (Any Platform)

```bash
# 1. Create and activate virtual environment
python -m venv .venv

# On Windows:
.venv\Scripts\activate
# On Linux / macOS:
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Start the server
python run.py
```

### Accessing the Interface
Open your browser to:
```text
http://127.0.0.1:8000
```

### Running the Automated Test Suite
To verify all 9 governance proxy tests (PII scrubbing, semantic caching, 429 failover, citation recovery, circuit breaker, and risk scoring):

```bash
python -m unittest tests/test_governance_proxy.py
```
Expected output:
```text
Ran 9 tests in ~12s
OK
```

## 9. API Endpoints

`POST /api/intercept`

Buffered request path. Returns the full decision trace.

`POST /api/intercept/stream`

Streaming request path. Emits token-by-token SSE and then the final trace.

`POST /api/action`

Agent execution firewall. Authorizes or blocks tool calls.

`POST /api/feedback`

Lightweight feedback loop. Records whether a risk was missed or over-flagged and adjusts future risk sensitivity for that dimension.

`GET /api/dashboard`

Governance telemetry for the UI.

`GET /api/scenarios`

Returns the demo scenarios shown in the left panel.

## 10. Project Structure

- `app/main.py`: FastAPI app and routes
- `app/schemas.py`: Pydantic models
- `app/services.py`: governance engine
- `app/sample_data.py`: demo cases
- `public/index.html`: browser UI
- `public/app.js`: browser behavior
- `public/styles.css`: UI styling
- `tests/test_governance_proxy.py`: tests
- `run.py`: entry point

## 11. Production Integration Points

- Replace `LlmRouter._simulate_model_stream` with `litellm.acompletion(..., stream=True)`.
- Point `BudgetStore` at Dragonfly or Redis in production.
- Replace `SemanticCache.embed` with managed embeddings or vector DB search.
- Replace `SOURCE_REGISTRY` with SharePoint, Confluence, Snowflake, Databricks, or enterprise search.
- Add NeMo Guardrails or Llama Guard as an async semantic security branch in `GovernanceProxy.judge`.
- Replace the lightweight feedback threshold adjustment with offline evaluation and calibrated policy tuning.
- Persist audit logs to SIEM, data lake, or governance dashboard.

## 12. A Simple Mental Model

The browser sends a request, the proxy checks and routes it, the model answers, the verifier checks the answer, and the user only sees the sanitized result plus a full audit trail.

That is the whole system.
