# ControlPlane.ai

ControlPlane.ai is an AI Governance Middleware Proxy for Track 1. It sits between client apps and foundation model APIs and enforces a `Prevent -> Gate -> Verify -> Control` architecture in real time.

The model should not be the only thing making decisions. The proxy checks the request before it reaches the model, watches the model while it streams, verifies the answer before it is shown, and logs enough context for a governance team to explain what happened.

## 1. Demo First: How to run

Run the app:

```bash
cd C:\ADrive\Accenture
.venv\Scripts\python.exe run.py
```

Open:

```text
http://127.0.0.1:8000
```

Then use these demo actions on the page:

1. Select `PII Shield + High-Risk Verify` and click `Run Proxy`.
2. Select `Semantic Cache Cost Save` and click `Run Proxy` twice.
3. Select `Citation Recovery Branch` and click `Stream SSE`.
4. Select `Provider Rate-Limit Failover` and click `Stream SSE`.
5. Click `Simulate Agent Action`.
6. Select `Fail-Closed Schema Drop` and click `Run Proxy`.

## 2. How To Explain The Output

When the checker runs the demo, the UI shows four kinds of output.

### Decision Trace

This is the most important panel. It shows the internal governance path.

- `Prevent` tells you whether the input was valid and whether private data was masked.
- `Gate` tells you whether the agent tool call was allowed and whether the circuit breaker is open.
- `Verify` tells you whether the answer had valid sources, whether fallback recovery was needed, and whether the judge passed.
- `Control` tells you the routing decision and whether the semantic cache or budget store was used.

### Streaming Output

This shows the user-facing answer as it is emitted token by token.

If the provider rate-limits, the stream continues from the fallback path instead of crashing.

### Result JSON

This is the raw structured response from the proxy.

It includes:

- `accepted`
- `decision`
- `scrubbed_prompt`
- `raw_model_answer`
- `final_answer`
- `layers`
- `session`
- `telemetry`

The important thing to notice is that `raw_model_answer` may contain internal `<source>...</source>` tags, but `final_answer` does not.

### Audit Trail

The dashboard at the bottom records each governance event.

It helps explain:

- what route was chosen
- whether a fallback was used
- whether the request was blocked
- whether the cache hit
- whether a circuit breaker opened

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

## 4. Solution Architecture

The architecture is built from four layers.

### Prevent

This layer validates and sanitizes incoming requests.

It uses:

- Pydantic for strict schema checks
- Presidio when available for PII detection
- regex fallback for deterministic masking

### Gate

This layer protects autonomous agent execution.

It uses:

- tool authorization rules
- repeated-failure tracking
- circuit breaker logic

### Verify

This layer checks the model output before it reaches the user.

It uses:

- hidden source-tag instructions
- source parsing with regex
- source registry validation
- fallback evidence recovery
- judge review for high-risk cases
- final redaction of internal tags

### Control

This layer manages economics and routing.

It uses:

- use-case routing
- token bucket budgeting
- semantic caching
- audit logging
- latency and cost telemetry

## 5. Implementation Approach

The project is organized so the governance engine is separate from the UI and the server wiring.

### `app/main.py`

Defines the FastAPI app and HTTP endpoints.

### `app/schemas.py`

Defines the request contracts with Pydantic.

### `app/services.py`

Contains the actual proxy logic:

- request validation support
- PII scrubbing
- token budgeting
- cache lookup
- streaming simulation
- source verification
- judge logic
- circuit breaker logic
- audit logging

### `app/sample_data.py`

Provides ready-made scenarios for the demo UI.

### `public/`

Contains the browser interface used to run and inspect the demo.

### `tests/`

Contains checks that prove the proxy behaves the way the demo claims.

## 6. Dependencies

The project uses these Python packages:

- `fastapi`
- `uvicorn`
- `pydantic`
- `httpx`
- `redis`
- `litellm`
- `presidio-analyzer`
- `presidio-anonymizer`

What they are for:

- FastAPI serves the API and SSE stream
- Pydantic validates request structure
- Redis or Dragonfly can store token budgets in a distributed way
- LiteLLM is the model-routing abstraction point
- Presidio is the PII detector/redactor

The demo also includes fallbacks so it still works if some enterprise services are not available locally.

## 7. Execution Instructions

### Install from scratch

```bash
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### Run the app

```bash
cd C:\ADrive\Accenture
.venv\Scripts\python.exe run.py
```

Then open:

```text
http://127.0.0.1:8000
```

### Run tests

```bash
.venv\Scripts\python.exe -m unittest tests\test_governance_proxy.py
```

## 8. API Endpoints

`POST /api/intercept`

Buffered request path. Returns the full decision trace.

`POST /api/intercept/stream`

Streaming request path. Emits token-by-token SSE and then the final trace.

`POST /api/action`

Agent execution firewall. Authorizes or blocks tool calls.

`GET /api/dashboard`

Governance telemetry for the UI.

`GET /api/scenarios`

Returns the demo scenarios shown in the left panel.

## 9. Project Structure

- `app/main.py`: FastAPI app and routes
- `app/schemas.py`: Pydantic models
- `app/services.py`: governance engine
- `app/sample_data.py`: demo cases
- `public/index.html`: browser UI
- `public/app.js`: browser behavior
- `public/styles.css`: UI styling
- `tests/test_governance_proxy.py`: tests
- `run.py`: entry point

## 10. Production Integration Points

- Replace `LlmRouter._simulate_model_stream` with `litellm.acompletion(..., stream=True)`.
- Point `BudgetStore` at Dragonfly or Redis in production.
- Replace `SemanticCache.embed` with managed embeddings or vector DB search.
- Replace `SOURCE_REGISTRY` with SharePoint, Confluence, Snowflake, Databricks, or enterprise search.
- Add NeMo Guardrails or Llama Guard as an async semantic security branch in `GovernanceProxy.judge`.
- Persist audit logs to SIEM, data lake, or governance dashboard.

## 11. A Simple Mental Model

If you are explaining the project in one sentence, say this:

The browser sends a request, the proxy checks and routes it, the model answers, the verifier checks the answer, and the user only sees the sanitized result plus a full audit trail.

That is the whole system.
