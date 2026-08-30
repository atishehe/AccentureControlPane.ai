from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .sample_data import SCENARIOS
from .schemas import AgentActionRequest, ProxyRequest
from .services import proxy

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"

app = FastAPI(
    title="ControlPlane.ai Governance Middleware Proxy",
    version="2.0.0",
    description="Enterprise-grade Responsible AI reverse proxy with Prevent, Control, Gate, and Verify layers.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/scenarios")
async def scenarios() -> Dict[str, Any]:
    return {"scenarios": SCENARIOS}


@app.get("/api/dashboard")
async def dashboard() -> Dict[str, Any]:
    return proxy.dashboard()


@app.post("/api/intercept")
async def intercept(request: ProxyRequest) -> Dict[str, Any]:
    return await proxy.process_buffered(request)


@app.post("/api/intercept/stream")
async def intercept_stream(request: ProxyRequest) -> StreamingResponse:
    return StreamingResponse(proxy.stream_sse(request), media_type="text/event-stream")


@app.post("/api/action")
async def action(request: AgentActionRequest) -> Dict[str, Any]:
    return proxy.authorize_action(request)


@app.exception_handler(ValidationError)
async def validation_exception_handler(_: Request, exc: ValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"accepted": False, "decision": "drop", "layer": "prevent", "errors": exc.errors()})


@app.exception_handler(RequestValidationError)
async def request_validation_exception_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"accepted": False, "decision": "drop", "layer": "prevent", "errors": exc.errors()})


app.mount("/", StaticFiles(directory=PUBLIC, html=True), name="public")
