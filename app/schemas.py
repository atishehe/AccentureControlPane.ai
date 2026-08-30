from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator


class UseCaseTag(str, Enum):
    low_risk_internal = "low_risk_internal"
    high_risk_external = "high_risk_external"
    regulated_decision_support = "regulated_decision_support"


class RequestMetadata(BaseModel):
    use_case_tag: UseCaseTag = Field(..., description="Governance policy selector.")
    geography: str = Field(..., min_length=2)
    industry: str = Field(..., min_length=2)
    requested_model: str = Field(default="gpt-4o-mini")
    fallback_model: str = Field(default="claude-3-haiku")
    latency_budget_ms: int = Field(..., ge=100, le=30_000)
    simulate_missing_source: bool = False
    simulate_provider_rate_limit: bool = False


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str = Field(..., min_length=1)


class ProxyRequest(BaseModel):
    request_id: str = Field(..., min_length=3)
    user_id: str = Field(..., min_length=2)
    session_id: str = Field(..., min_length=2)
    prompt: str = Field(..., min_length=1, max_length=20_000)
    metadata: RequestMetadata
    messages: List[ChatMessage] = Field(default_factory=list)
    max_tokens: int = Field(default=512, ge=1, le=4096)
    stream: bool = True

    @field_validator("prompt")
    @classmethod
    def reject_empty_prompt(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("prompt must not be blank")
        return value


class AgentActionRequest(BaseModel):
    user_id: str
    session_id: str
    use_case_tag: UseCaseTag
    tool_name: str
    arguments_hash: str = "no-args"
    status: Literal["planned", "succeeded", "failed"] = "planned"


class Scenario(BaseModel):
    id: str
    name: str
    description: str
    payload: Dict[str, Any]
