# ControlPlane.ai: 3-Minute Checker Demo Script

**Target duration:** about 3 minutes.  
**Demo preparation:** Start the app and keep the `PII Shield + High-Risk Verify` scenario selected.

---

## 0:00-0:25 | Problem and Solution

**Speaker 1:** Good morning. Enterprise AI can be confidently wrong, quietly expensive, or unsafe and biased, often before anyone notices.

ControlPlane.ai is our AI Governance Middleware Proxy. It sits between a client application and any foundation model, continuously governing every request, tool action, and response through Prevent, Gate, Verify, and Control.

**Speaker 2:** We use the cheapest reliable check first, escalating only when risk justifies the latency and cost.

## 0:25-1:10 | Prevent and Control

**Speaker 1:** In **Prevent**, FastAPI and Pydantic validate IDs, use-case metadata, data types, and token limits. Invalid payloads fail closed before reaching a model.

Microsoft Presidio and regex rules then mask SSNs, cards, emails, phones, and private IP addresses. The same scrubber runs on the final response, so sensitive data cannot leak back to the user.

**Speaker 2:** **Control** routes low-risk work to a fast path and high-risk or regulated work to deeper verification. A semantic cache avoids repeat inference for already-verified prompts.

A Redis or Dragonfly-compatible token bucket enforces tokens-per-minute and session budgets, with an in-memory demo fallback. A provider rate limit triggers automatic streaming failover.

## 1:10-2:10 | Gate and Verify

**Speaker 1:** **Gate** protects AI agents before each tool call. It checks authorization, tracks repeated failures, and opens a circuit breaker if an agent loops or exceeds its budget.

**Speaker 2:** **Verify** checks whether the answer is trustworthy. We require source tags, validate IDs against a governed registry, and recover fallback evidence when citations are absent or invalid.

NLI compares response claims with cited evidence as **entailed**, **contradicted**, or **unknown**. Contradicted and unsupported claims increase performance risk. Ethical and social content receives a higher responsibility baseline.

When risk and budgets justify it, we invoke the Judge. For bias-sensitive content, it evaluates fairness, protected attributes, and stereotyping.

## 2:10-3:00 | Demo and Close

**Speaker 1:** Let’s run the PII Shield scenario. The trace shows the four layers, PII masking, routing, source verification, NLI verdict, risk scores, and policy decision. The user only receives sanitized output, without source tags or sensitive data.

**Speaker 2:** Other scenarios demonstrate cache savings, citation recovery, provider failover, schema rejection, NLI detection of wrong claims, bias review, and the agent circuit breaker.

Trace Telemetry, Execution Analysis, the live NLI badge, and the audit log explain every decision. The stack is FastAPI, Pydantic, Presidio, Redis-compatible budgeting, LiteLLM-ready routing, and optional DeBERTa NLI.

**Speaker 1:** ControlPlane.ai prevents cheap problems cheaply, gates expensive actions, verifies uncertain answers with evidence, and controls cost across the whole session. It helps enterprises find AI risk before their users do. Thank you.
