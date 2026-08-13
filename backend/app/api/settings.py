import logging
from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from app.core.security import get_current_user_id
from app.core.encryption import encrypt_api_key, decrypt_api_key
from app.schemas.settings import AISettings, AISettingsUpdate, AIModel, AIProvider, AITestRequest, AITestResponse
from app.services.data_adapter import DataService
from app.services.gemini import test_api_key

logger = logging.getLogger(__name__)

# Router for user-specific settings
user_router = APIRouter(
    prefix="/users",
    tags=["settings"],
)

# Router for global settings
global_router = APIRouter(
    tags=["settings"],
)

def verify_user_access(user_id: str, current_user_id: str):
    if user_id != current_user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied"
        )

@user_router.get("/{userId}/settings/ai", response_model=AISettings)
async def get_ai_settings(
    userId: str,
    current_user_id: str = Depends(get_current_user_id)
):
    verify_user_access(userId, current_user_id)
    
    # Try to get from Firestore
    settings_dict = await DataService.get_user_settings(userId, "ai_config")
    if not settings_dict:
        # Default settings
        return AISettings()
    
    # Handle migration from old structure if necessary
    if "api_key" in settings_dict and settings_dict["api_key"]:
        provider = settings_dict.get("provider", AIProvider.GEMINI)
        if "configs" not in settings_dict:
            settings_dict["configs"] = {}
        
        if provider not in settings_dict["configs"] or not settings_dict["configs"][provider].get("api_key"):
            if provider not in settings_dict["configs"]:
                settings_dict["configs"][provider] = {"enabled": True, "thinking_mode": False}
            settings_dict["configs"][provider]["api_key"] = settings_dict["api_key"]
            # Clean up old key if migration is successful
            del settings_dict["api_key"]
            await DataService.update_user_settings(userId, "ai_config", settings_dict)
    
    # Decrypt and mask API keys for response
    if "configs" in settings_dict:
        for provider in settings_dict["configs"]:
            key = settings_dict["configs"][provider].get("api_key")
            if key and key != "" and not key.startswith("********"):
                plaintext = decrypt_api_key(key)
                if plaintext:
                    settings_dict["configs"][provider]["api_key"] = "********" + plaintext[-4:]
        
    return AISettings(**settings_dict)

@user_router.put("/{userId}/settings/ai", response_model=AISettings)
async def update_ai_settings(
    userId: str,
    settings_update: AISettingsUpdate,
    current_user_id: str = Depends(get_current_user_id)
):
    verify_user_access(userId, current_user_id)
    
    # Get current settings
    current = await DataService.get_user_settings(userId, "ai_config") or {}
    
    # Update logic
    if "configs" not in current:
        current["configs"] = {}
        
    update_data = settings_update.model_dump(exclude_unset=True)
    
    # Handle provider-specific update
    if settings_update.provider:
        current["provider"] = settings_update.provider
    
    if settings_update.model_id:
        current["model_id"] = settings_update.model_id
        
    # Update specific provider config
    active_provider = current.get("provider", AIProvider.GEMINI)
    if active_provider not in current["configs"]:
        current["configs"][active_provider] = {"api_key": None, "enabled": True, "thinking_mode": False}
        
    if "api_key" in update_data:
        key = update_data["api_key"]
        if key and not key.startswith("********"):
            current["configs"][active_provider]["api_key"] = encrypt_api_key(key)
    
    if "enabled" in update_data:
        current["configs"][active_provider]["enabled"] = update_data["enabled"]

    if "thinking_mode" in update_data:
        current["configs"][active_provider]["thinking_mode"] = update_data["thinking_mode"]

    if "max_ai_concurrency" in update_data:
        current["max_ai_concurrency"] = update_data["max_ai_concurrency"]
        
    await DataService.update_user_settings(userId, "ai_config", current)
    
    # Decrypt and mask API keys for response
    for provider in current["configs"]:
        key = current["configs"][provider].get("api_key")
        if key and key != "" and not key.startswith("********"):
            plaintext = decrypt_api_key(key)
            if plaintext:
                current["configs"][provider]["api_key"] = "********" + plaintext[-4:]

    return AISettings(**current)

@user_router.post("/{userId}/settings/ai/test", response_model=AITestResponse)
async def test_ai_settings(
    userId: str,
    test_request: AITestRequest,
    current_user_id: str = Depends(get_current_user_id)
):
    verify_user_access(userId, current_user_id)
    
    # If the key is the masked one, we need to get the real one from Firestore
    api_key = test_request.api_key
    if api_key.startswith("********"):
        current = await DataService.get_user_settings(userId, "ai_config")
        if not current or not current.get("configs") or test_request.provider not in current["configs"]:
            return AITestResponse(success=False, message="No API key stored for this provider to test")
        api_key = decrypt_api_key(current["configs"][test_request.provider].get("api_key", ""))
        if not api_key:
            return AITestResponse(success=False, message="API key is empty")
    
    # Note: need a way to test different providers
    success, error_detail = await test_api_key(api_key, test_request.model_id, test_request.provider)
    
    if success:
        return AITestResponse(success=True, message="API Key is valid!")
    else:
        # Persist the failure so the user can review the specific reason
        # (payment/quota 402, auth 401, rate-limit 429, ...) even if they
        # navigate away from the settings page.
        try:
            from app.services.scan_error_service import log_error
            from app.services.error_codes import ErrorCode, classify_exception
            code = ErrorCode.UNKNOWN
            if error_detail:
                scan_error = classify_exception(Exception(error_detail))
                code = scan_error.code
            await log_error(
                userId,
                kind="system",
                code=code,
                message=error_detail or "API key validation failed",
                title=f"API key test failed ({test_request.provider})",
                data={
                    "provider": test_request.provider,
                    "model_id": test_request.model_id,
                },
            )
        except Exception:
            logger.exception("Failed to persist API key test failure")
        return AITestResponse(success=False, message=error_detail or "Invalid API Key or connection error")

from app.services.model_registry import get_all_models

logger = logging.getLogger(__name__)
...
@global_router.get("/settings/models", response_model=List[AIModel])
async def get_available_models():
    """List available AI models."""
    model_data = get_all_models()
    result = []
    for provider, models in model_data.items():
        for model in models:
            result.append(AIModel(
                id=model["id"],
                name=model["name"],
                provider=AIProvider(provider),
                description=model.get("description"),
                supports_thinking=model.get("supports_thinking", False)
            ))
    return result
