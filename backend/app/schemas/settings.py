from pydantic import BaseModel, Field
from typing import Optional, List
from enum import Enum

class AIProvider(str, Enum):
    GEMINI = "gemini"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    DEEPSEEK = "deepseek"

class ProviderConfig(BaseModel):
    api_key: Optional[str] = None
    enabled: bool = True
    thinking_mode: bool = False

class AIModel(BaseModel):
    id: str
    name: str
    provider: AIProvider
    description: Optional[str] = None
    supports_thinking: bool = False

class AISettings(BaseModel):
    provider: AIProvider = AIProvider.GEMINI
    model_id: str = "gemini-3-flash-preview"
    configs: dict[str, ProviderConfig] = {}
    max_ai_concurrency: int = 4

class AISettingsUpdate(BaseModel):
    provider: Optional[AIProvider] = None
    model_id: Optional[str] = None
    api_key: Optional[str] = None
    enabled: Optional[bool] = None
    thinking_mode: Optional[bool] = None
    max_ai_concurrency: Optional[int] = None

class AITestRequest(BaseModel):
    api_key: str
    model_id: str = "gemini-3-flash-preview"
    provider: AIProvider = AIProvider.GEMINI

class AITestResponse(BaseModel):
    success: bool
    message: str
