"""
Gemini AI service for receipt extraction and analysis.

Moved from frontend to backend for:
- Better API security (key never exposed to client)
- Caching and optimization server-side
- Scalability
- Cost tracking per user/org
"""

import asyncio
import base64
import json
import logging
from typing import Optional, Tuple, Any
import google.generativeai as genai
from openai import AsyncOpenAI
from app.core.config import settings

def get_deepseek_client(api_key: str):
    return AsyncOpenAI(api_key=api_key, base_url="https://api.deepseek.com")

from openai import AsyncOpenAI, APIStatusError
from app.core.config import settings

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Alibaba Qwen (QwenCloud International / Model Studio) OpenAI-compatible
# endpoint. Keys issued at home.qwencloud.com MUST be used against the
# *international* domain (dashscope-intl.aliyuncs.com) — using the China
# region endpoint (dashscope.aliyuncs.com) returns invalid_api_key 401.
# US/alternate regions:
#   https://dashscope-us.aliyuncs.com/compatible-mode/v1
DASHSCOPE_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"

def get_openai_compatible_client(api_key: str, base_url: str):
    """OpenAI-compatible chat client (DeepSeek, OpenRouter, Qwen, etc.)."""
    return AsyncOpenAI(api_key=api_key, base_url=base_url)

def get_deepseek_client(api_key: str):
    return get_openai_compatible_client(api_key, "https://api.deepseek.com")

def get_openrouter_client(api_key: str):
    return get_openai_compatible_client(api_key, OPENROUTER_BASE_URL)

def get_qwen_client(api_key: str):
    return get_openai_compatible_client(api_key, DASHSCOPE_BASE_URL)

async def call_openai_compatible_api(
    api_key: str,
    base_url: str,
    model_id: str,
    prompt: str,
    content: Any = None,
    thinking_mode: bool = False,
    provider_label: str = "provider",
    extra_body_override: Optional[dict] = None,
    max_tokens: Optional[int] = None,
):
    """Generic chat-completions call shared by OpenAI-compatible providers.

    Builds the messages array, applies provider-specific thinking params,
    and maps HTTP errors to the app's error vocabulary.
    """
    client = get_openai_compatible_client(api_key, base_url)
    messages = [{"role": "user", "content": content if content else prompt}]

    # Thinking-mode params vary by provider:
    #   DeepSeek  → {"thinking": {"type": "enabled"}} + reasoning_effort
    #   OpenRouter → {"reasoning": {"effort": "high"}}
    #   Qwen      → {"enable_thinking": bool} via extra_body_override
    extra_params = {}
    if extra_body_override is not None:
        # Provider decides exactly which extra body to send (e.g. Qwen setting
        # enable_thinking: False on hybrid models, or nothing for -instruct).
        extra_params["extra_body"] = extra_body_override
    elif thinking_mode:
        if base_url == OPENROUTER_BASE_URL:
            extra_params["extra_body"] = {"reasoning": {"effort": "high"}}
        else:
            extra_params["extra_body"] = {"thinking": {"type": "enabled"}}
            extra_params["reasoning_effort"] = "high"
    if max_tokens:
        extra_params["max_tokens"] = max_tokens

    try:
        response = await client.chat.completions.create(
            model=model_id,
            messages=messages,
            response_format={"type": "json_object"},
            **extra_params
        )
        return response.choices[0].message.content
    except APIStatusError as e:
        status_code = getattr(e, 'status_code', 500)
        error_body = e.response.json() if hasattr(e, 'response') else str(e)

        logger.error(f"{provider_label} API Error {status_code}: {error_body}")

        error_map = {
            400: ("Invalid Format", "Invalid request body format."),
            401: ("Authentication Fails", "Wrong API key."),
            402: ("Insufficient Balance", "Ran out of balance."),
            422: ("Invalid Parameters", "Request contains invalid parameters."),
            429: ("Rate Limit Reached", "Requests too fast."),
            500: ("Server Error", f"{provider_label} server issue."),
            503: ("Server Overloaded", "Server overloaded."),
        }

        desc, solution = error_map.get(status_code, ("Unknown Error", f"Please check {provider_label} API documentation."))
        raise ValueError(f"{provider_label} API Error {status_code} ({desc}): {solution}")
    except Exception as e:
        logger.error(f"Unexpected {provider_label} API error: {str(e)}")
        raise

async def call_deepseek_api(api_key: str, model_id: str, prompt: str, content: Any = None, thinking_mode: bool = False, max_tokens: Optional[int] = None):
    return await call_openai_compatible_api(
        api_key, "https://api.deepseek.com", model_id,
        prompt, content, thinking_mode=thinking_mode, provider_label="DeepSeek",
        max_tokens=max_tokens,
    )

async def call_openrouter_api(api_key: str, model_id: str, prompt: str, content: Any = None, thinking_mode: bool = False, max_tokens: Optional[int] = None):
    return await call_openai_compatible_api(
        api_key, OPENROUTER_BASE_URL, model_id,
        prompt, content, thinking_mode=thinking_mode, provider_label="OpenRouter",
        max_tokens=max_tokens,
    )

async def call_qwen_api(api_key: str, model_id: str, prompt: str, content: Any = None, thinking_mode: bool = False, max_tokens: Optional[int] = None):
    """Alibaba Qwen (DashScope) OpenAI-compatible chat call.

    DashScope hybrid-thinking models (qwen3-vl-flash, qwen3-vl-plus,
    qwen3.6-flash, qwen3.7-plus) accept an explicit `enable_thinking` toggle;
    send False unless the user opted in so JSON output stays deterministic.
    `-instruct` models don't support the parameter at all, so omit it.
    """
    extra_body = None
    if not (model_id and model_id.endswith("-instruct")):
        extra_body = {"enable_thinking": bool(thinking_mode)}
    return await call_openai_compatible_api(
        api_key, DASHSCOPE_BASE_URL, model_id,
        prompt, content, thinking_mode=thinking_mode,
        provider_label="Alibaba Qwen",
        extra_body_override=extra_body,
        max_tokens=max_tokens,
    )

def sanitize_numeric(value: Any) -> str:
    """Strip all characters except digits and decimal point."""
    if value is None: return "0"
    # Remove everything except digits and dot
    sanitized = "".join(c for c in str(value) if c.isdigit() or c == '.')
    return sanitized if sanitized and sanitized != '.' else "0"


def _parse_extracted_items(raw_items) -> list:
    """Build the sanitized item list an AI response.

    Deliberately does NOT carry over per-item tax or discount: AI-invented
    tax/discount amounts distort line totals (qty * (price + tax) * (1 -
    discount/100)) relative to the VAT-inclusive printed total and force the
    user to clear them item by item. Items keep only name, quantity, price,
    and isZeroRated; tax is captured at the receipt level only.
    """
    items = []
    for item in (raw_items or []):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "N/A").strip() or "N/A"
        try:
            quantity = float(item.get("quantity", 1))
        except (TypeError, ValueError):
            quantity = 1
        items.append({
            "name": name,
            "quantity": quantity,
            "price": sanitize_numeric(item.get("price")),
            "isZeroRated": bool(item.get("isZeroRated", False)),
        })
    return items

from app.schemas.receipt import ReceiptCreate, ReceiptItem, ReceiptStatus
from app.services.data_adapter import DataService
from app.core.encryption import decrypt_api_key

logger = logging.getLogger(__name__)

# genai.configure() modifies global state. Serialize all Gemini SDK calls
# that depend on it so concurrent requests with different per-user API keys
# cannot leak one user's data to another user's API key.
# Track current configured key to avoid redundant global re-configs
_current_configured_key: Optional[str] = None
_gemini_lock = asyncio.Lock()


async def _gemini_generate_content(
    api_key: str,
    model_id: str,
    contents,
    generation_config=None,
):
    """Atomically configure genai and generate content via a worker thread.

    Why to_thread, not generate_content_async:
    The google-generativeai SDK initializes its async gRPC transport bound to
    whichever event loop is current at first import/use. In a Celery prefork
    worker each task runs under a brand-new asyncio.run() loop, but the SDK
    still holds references to the parent process's (now-closed) loop —
    resulting in 'Event loop is closed' on every extraction call. Running the
    sync API inside asyncio.to_thread sidesteps the SDK's asyncio internals
    entirely and is loop-agnostic, which makes it the right primitive for
    both FastAPI request handlers and Celery workers.
    """
    global _current_configured_key

    def _sync_call():
        model = genai.GenerativeModel(model_id)
        return model.generate_content(contents, generation_config=generation_config)

    # Hot path: same key as currently configured, no lock needed.
    if _current_configured_key == api_key:
        return await asyncio.to_thread(_sync_call)

    # Cold path: key change requires serialized re-configure of global SDK state.
    async with _gemini_lock:
        if _current_configured_key != api_key:
            logger.info("Re-configuring Gemini SDK with new API key")
            genai.configure(api_key=api_key)
            _current_configured_key = api_key
        return await asyncio.to_thread(_sync_call)


async def get_gemini_config(user_id: Optional[str]) -> Tuple[str, str, str]:
    """
    Resolve the active (api_key, model_id, provider) for an extraction.

    Resolution is explicit — there is NO implicit fallback to a default
    provider/key, because that silently bills a shared account:

      1. the user's own key for their active provider (if configured)
      2. the admin-provided shared key for that provider (if enabled)
      3. raises ValueError with a clear, user-actionable message

    Admin keys are managed in the admin UI (admin/settings/ai-providers).
    """

    def _is_valid_model(provider: str, model_id: str) -> bool:
        from app.services.model_registry import MODELS

        return any(m["id"] == model_id for m in MODELS.get(provider, []))

    from app.services import admin_keys_service

    provider = "gemini"
    user_api_key: Optional[str] = None
    ai_settings = None

    if user_id:
        try:
            ai_settings = await DataService.get_user_settings(user_id, "ai_config")
        except Exception as e:
            logger.error(f"Failed to load user AI settings: {e}")

    if ai_settings:
        provider = ai_settings.get("provider", "gemini")
        configs = ai_settings.get("configs", {}) or {}
        provider_cfg = configs.get(provider, {}) if isinstance(configs, dict) else {}
        raw_key = provider_cfg.get("api_key")
        if raw_key:
            user_api_key = decrypt_api_key(raw_key)

    # Default model must be derived from the *active* provider, not the gemini
    # default — a deepseek user must never silently run a gemini model id.
    model_id = admin_keys_service.default_model_for(provider)
    if ai_settings:
        # Only honor the user's model when it actually belongs to the active
        # provider — legacy/stale defaults (e.g. "gemini-3-flash-preview" for a
        # deepseek user) must never leak across providers.
        user_model = ai_settings.get("model_id")
        if user_model and _is_valid_model(provider, user_model):
            model_id = user_model

    api_key = user_api_key
    admin = await admin_keys_service.get_provider_override(provider)
    if not api_key and admin and admin.get("enabled") and admin.get("api_key"):
        api_key = admin["api_key"]
        if model_id == admin_keys_service.default_model_for(provider):
            model_id = admin.get("model_id") or admin_keys_service.default_model_for(provider)

    if not api_key:
        raise ValueError(
            f"No API key configured for provider '{provider}'. "
            "Add your own key in Settings, or ask your administrator to enable a shared key."
        )

    return api_key, model_id, provider

def get_model(api_key: str, model_id: str):
    """Get a configured GenerativeModel instance."""
    # Note: genai.configure is global, but we can pass api_key to GenerativeModel?
    # Actually, the best way with the current SDK is to use a specific client or just re-configure.
    # For multi-tenant, we should ideally use different client instances if possible.
    # In current google-generativeai, it's mostly global.
    # However, we can use the 'google.generativeai.GenerativeModel' constructor.
    
    # Let's use a simple approach: re-configure if key changed (not ideal for high concurrency)
    # Better: use the underlying client or hope it doesn't cause race conditions.
    # Actually, genai.configure is not strictly global if we use the right objects.
    
    # REVISED: genai.configure IS global. For a truly multi-tenant app with different keys
    # per request, we should use the Vertex AI SDK or the Discovery API directly.
    # But for now, we'll re-configure.
    genai.configure(api_key=api_key)
    return genai.GenerativeModel(model_id)

# Pricing for Gemini models
MODEL_PRICING = {
    "gemini-2.0-flash": {"input": 0.075, "cachedInput": 0.0225, "output": 0.3},
    "gemini-3.1-flash-lite-preview": {"input": 0.075, "cachedInput": 0.0225, "output": 0.3},
}

# Category list (reusable for caching)
CATEGORIES = [
    "Building Materials", "Hardware & Tools", "Paint & Finishes",
    "Plumbing & Sanitary", "Electrical Supplies",
    "Fuel & Lubricants", "Vehicle Maintenance", "Transport Services",
    "Energy & Utilities",
    "Seeds & Inputs", "Fertilizers & Chemicals", "Irrigation Supplies",
    "Farm Tools & Equipment", "Animal Feed & Supplements", "Veterinary Services",
    "Livestock & Poultry", "Crop Harvesting & Processing", "Greenhouse Supplies",
    "Agro Consultancy & Training",
    "Furniture & Fixtures", "Electronics & Appliances", "Utensils & Cutlery",
    "Cleaning Supplies", "Stationery & Office Supplies",
    "Groceries & Provisions", "Perishables", "Beverages", "Restaurant & Catering",
    "Clothing & Footwear", "Personal Care & Beauty", "Health & Medicine",
    "Baby & Kids Supplies",
    "Phones & Accessories", "Computers & IT Equipment", "Internet & Airtime",
    "Gifts & Donations", "Entertainment & Leisure", "Education & Learning",
    "Subscriptions & Memberships",
    "Raw Materials", "Packaging Supplies", "Marketing & Branding",
    "Employee Salaries & Wages", "Professional Services", "Licenses & Permits",
    "Rent & Lease", "Land & Property Purchases", "Security & Surveillance",
    "Repairs & Maintenance", "Emergency Purchases"
]

# ── Global extraction prompt (shared by single & batch) ──────────────
# {batch_instruction} is replaced at call-site:
#   • single mode  → asks for ONE JSON object
#   • batch mode   → asks for a JSON ARRAY
RECEIPT_EXTRACTION_PROMPT = """
{batch_instruction}

INSTRUCTIONS:
- exclude symbols like currency symbols if present
- totalAmount should be without currency symbol
- taxAmount should be without currency symbol
-try and identify commas and decimal points in the numeric values
- Use 'N/A' for missing fields
- Dates in MM/DD/YYYY format
- For the category field, analyze the supplier and items, then choose EXACTLY ONE:
  """ + ', '.join(CATEGORIES) + """
  Return ONLY the exact category name from the list.
- KRA PINs: Always start with 'P' or 'A' followed by digits and end with a letter
  (e.g. 'P05115959U'). The SELLER PIN (kraPin) belongs to the supplier.
  The BUYER PIN (buyerKraPin) belongs to the customer/your company.
  Often one appears near the top (seller) and one near the bottom (buyer).
- cuInvoice: The KRA-issued control unit number, often a long numeric
  string (e.g. '004084202207080184'), labeled 'CU Invoice', 'CU No',
  'Control Unit', or similar. This is NOT the supplier's own invoice number.
- Items: include ONLY the item name, quantity, unit price, and isZeroRated.
  Do NOT extract per-item tax amounts or discount percentages — leave them
  out entirely. Tax is captured at the receipt level (taxAmount) only.

{response_schema}
"""

_SINGLE_RESPONSE_SCHEMA = """Return ONLY a JSON object matching this structure:
{{
  "supplier": "string",
  "totalAmount": "string",
  "taxAmount": "string or N/A",
  "receiptDate": "MM/DD/YYYY",
  "category": "category name",
  "invoiceNumber": "string or N/A",
  "kraPin": "seller KRA PIN or N/A",
  "buyerKraPin": "buyer KRA PIN or N/A",
  "cuInvoice": "KRA CU invoice number or N/A",
  "items": [
    {{"name": "string", "quantity": number, "price": "string", "isZeroRated": boolean}}
  ]
}}"""

_BATCH_RESPONSE_SCHEMA = """Return ONLY ONE JSON object matching this structure:
{{
  "receipts": [
    {{
      "imageIndex": 0,
      "supplier": "string",
      "totalAmount": "string",
      "taxAmount": "string or N/A",
      "receiptDate": "MM/DD/YYYY",
      "category": "category name",
      "invoiceNumber": "string or N/A",
      "kraPin": "seller KRA PIN or N/A",
      "buyerKraPin": "buyer KRA PIN or N/A",
      "cuInvoice": "KRA CU invoice number or N/A",
      "items": [
        {{"name": "string", "quantity": number, "price": "string", "isZeroRated": boolean}}
      ]
    }},
    ...
  ]
}}"""


def _clean_json_response(text: str) -> str:
    """Strip markdown code blocks and whitespace from AI response."""
    text = text.strip()
    if text.startswith("```"):
        # Split by ``` and take the content between them
        parts = text.split("```")
        if len(parts) >= 3:
            text = parts[1]
            # Remove "json" language identifier if present
            if text.lower().startswith("json"):
                text = text[4:]
    return text.strip()


async def resolve_thinking_mode(user_id: Optional[str], provider: str) -> bool:
    """
    Resolve thinking mode for a provider.

    Precedence (mirrors key resolution — user settings win, admin is the
    fallback):
      1. the user's explicit thinking_mode for this provider
      2. the admin's shared thinking_mode (used when the admin key applies)
      3. off
    """
    from app.services import admin_keys_service

    if user_id:
        try:
            ai_settings = await DataService.get_user_settings(user_id, "ai_config")
            if ai_settings:
                pcfg = ai_settings.get("configs", {}) or {}
                provider_cfg = pcfg.get(provider, {}) if isinstance(pcfg, dict) else {}
                if "thinking_mode" in provider_cfg:
                    return bool(provider_cfg["thinking_mode"])
        except Exception as e:
            logger.error(f"Failed to load user AI settings for thinking mode: {e}")

    admin = await admin_keys_service.get_provider_override(provider)
    if admin:
        return bool(admin.get("thinking_mode", False))
    return False


async def extract_receipt_data(
    image_base64: str,
    mime_type: str,
    user_id: Optional[str] = None,
) -> ReceiptCreate:
    """
    Extract structured receipt data from image using Gemini Vision.

    Args:
        image_base64: Base64-encoded image data
        mime_type: MIME type of image (image/jpeg, image/png, etc.)
        user_id: User ID for custom AI settings

    Returns:
        ReceiptCreate schema with extracted data

    Raises:
        ValueError: If extraction fails or response is malformed
    """
    try:
        # Get user-specific config
        api_key, model_id, provider = await get_gemini_config(user_id)
        thinking_mode = await resolve_thinking_mode(user_id, provider)

        prompt = RECEIPT_EXTRACTION_PROMPT.format(
            batch_instruction="Extract receipt details from this image and return ONLY valid JSON.",
            response_schema=_SINGLE_RESPONSE_SCHEMA,
        )

        if provider == "deepseek":
            content = [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{image_base64}"}}
            ]
            response_text = await call_deepseek_api(api_key, model_id, prompt, content, thinking_mode=thinking_mode)
        elif provider == "openrouter":
            content = [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{image_base64}"}}
            ]
            response_text = await call_openrouter_api(api_key, model_id, prompt, content, thinking_mode=thinking_mode)
        elif provider == "qwen":
            content = [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{image_base64}"}}
            ]
            response_text = await call_qwen_api(api_key, model_id, prompt, content, thinking_mode=thinking_mode)
        else:
            image_part = {
                "mime_type": mime_type,
                "data": image_base64
            }
            response = await _gemini_generate_content(
                api_key, model_id,
                [image_part, prompt],
                generation_config=genai.types.GenerationConfig(
                    response_mime_type="application/json",
                    temperature=0.1,
                )
            )
            response_text = response.text
            
        response_text = _clean_json_response(response_text)
        data = json.loads(response_text)

        # Validate and sanitize
        items = _parse_extracted_items(data.get("items"))

        # Flag all scans for review
        status = ReceiptStatus.NEEDS_REVIEW

        receipt = ReceiptCreate(
            supplier=data.get("supplier", "Unknown"),
            totalAmount=sanitize_numeric(data.get("totalAmount")),
            taxAmount=sanitize_numeric(data.get("taxAmount")),
            receiptDate=data.get("receiptDate", ""),
            category=data.get("category", "Other"),
            invoiceNumber=data.get("invoiceNumber"),
            kraPin=data.get("kraPin"),
            buyerKraPin=data.get("buyerKraPin"),
            cuInvoice=data.get("cuInvoice"),
            items=items,
            status=status
        )

        logger.info(f"Extracted receipt from {receipt.supplier}")
        return receipt

    except json.JSONDecodeError as e:
        logger.exception("Failed to parse Gemini response as JSON")
        raise ValueError(f"Invalid response from Gemini: {str(e)}")
    except Exception as e:
        logger.exception("Receipt extraction failed")
        raise ValueError(f"Receipt extraction failed: {str(e)}")


async def extract_receipt_batch(
    images: list[tuple[str, str]],  # [(base64, mime_type), ...]
    api_key: str,
    model_id: str,
    provider: str,
    user_id: Optional[str] = None,
) -> list[Optional[ReceiptCreate]]:
    """
    Extract structured data from MULTIPLE receipts in one AI call.
    Maximum efficiency for batch processing.
    """
    if not images:
        return []

    try:
        thinking_mode = await resolve_thinking_mode(user_id, provider)

        # Why a wrapper object and not a top-level array: DashScope/OpenAI-
        # compatible `response_format={"type": "json_object"}` constrains the
        # output to a SINGLE JSON object. Qwen3-VL silently collapses a
        # requested top-level array down to one element ("10 images → 1
        # receipt"). Nesting the array inside an object is the sanctioned
        # pattern and yields all receipts reliably.
        prompt = RECEIPT_EXTRACTION_PROMPT.format(
            batch_instruction=(
                f"Extract receipt details from these {len(images)} images. Each image is "
                "preceded by its index (Image index 0, Image index 1, ...).\n"
                f"Return ONE JSON object with a \"receipts\" array containing EXACTLY {len(images)} "
                "receipt objects, one per image.\n"
                "CRITICAL: every receipt object MUST include \"imageIndex\" — the 0-based number "
                "of the image it was extracted from. imageIndex values must be unique and each "
                "must appear exactly once. You may list receipts in ANY order as long as every "
                "imageIndex is correct."
            ),
            response_schema=_BATCH_RESPONSE_SCHEMA,
        )
        # Headroom so a 10-image batch can't get truncated mid-array (truncation
        # would otherwise show up as a fake short array).
        max_tokens = min(8192, max(2048, 1024 * len(images)))

        if provider == "deepseek":
            content = []
            for i, (b64, mime) in enumerate(images):
                content.append({"type": "text", "text": f"Image index {i}:"})
                content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
            content.append({"type": "text", "text": prompt})
            response_text = await call_deepseek_api(api_key, model_id, prompt, content, thinking_mode=thinking_mode, max_tokens=max_tokens)
        elif provider == "openrouter":
            content = []
            for i, (b64, mime) in enumerate(images):
                content.append({"type": "text", "text": f"Image index {i}:"})
                content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
            content.append({"type": "text", "text": prompt})
            response_text = await call_openrouter_api(api_key, model_id, prompt, content, thinking_mode=thinking_mode, max_tokens=max_tokens)
        elif provider == "qwen":
            content = []
            for i, (b64, mime) in enumerate(images):
                content.append({"type": "text", "text": f"Image index {i}:"})
                content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
            content.append({"type": "text", "text": prompt})
            response_text = await call_qwen_api(api_key, model_id, prompt, content, thinking_mode=thinking_mode, max_tokens=max_tokens)
        else:
            # Prepare multimodal content
            content = []
            for i, (b64, mime) in enumerate(images):
                content.append({
                    "mime_type": mime,
                    "data": b64
                })
                content.append({
                    "text": f"This is image index {i}. Extract its details."
                })
            content.append({"text": prompt})

            response = await _gemini_generate_content(
                api_key, model_id,
                content,
                generation_config=genai.types.GenerationConfig(
                    response_mime_type="application/json",
                    temperature=0.1,
                )
            )
            response_text = response.text

        response_text = _clean_json_response(response_text)
        try:
            payload = json.loads(response_text)
        except json.JSONDecodeError as e:
            raise ValueError(f"AI returned malformed JSON (decode failed): {str(e)}") from e

        # Normalize: expect ONE object wrapping a "receipts" array. Bare arrays
        # and bare single objects are accepted for backwards compatibility.
        if isinstance(payload, dict) and "receipts" in payload:
            data_list = payload["receipts"]
        elif isinstance(payload, list):
            data_list = payload
        elif isinstance(payload, dict):
            data_list = [payload]
        else:
            raise ValueError("AI returned malformed JSON (parse error: unexpected top-level type)")

        # The whole point: a short array means the model dropped images. Treat
        # it as malformed so the worker fans out to per-image extraction
        # instead of silently marking N images failed.
        if not isinstance(data_list, list) or len(data_list) != len(images):
            received = len(data_list) if isinstance(data_list, list) else "a non-array"
            raise ValueError(
                f"AI returned malformed JSON (parse error: expecting {len(images)} "
                f"receipts but received {received})"
            )

        # ── Anti-mixing: a model may return the receipts array in a DIFFERENT
        # order than the images were presented (qwen3-vl-flash has swapped 2 of
        # 4 entries). The worker persists result i onto image i, so a shuffled
        # array would silently attach receipts to the wrong images. Each receipt
        # therefore declares which image it came from via "imageIndex"; we
        # re-sort by it so the returned list always matches image order.
        #
        #   - every entry has a valid, unique, in-range imageIndex → re-sort
        #   - no entry has imageIndex → positional fallback (older providers /
        #     gemini that ignore the field keep the old behavior)
        #   - some but not all (or invalid / duplicate / out-of-range) → the
        #     model's ordering cannot be trusted → malformed, worker fans out
        #     to per-image extraction where order is guaranteed by construction
        indexed = []
        seen = set()
        missing = 0
        for i, data in enumerate(data_list):
            if not isinstance(data, dict):
                raise ValueError(
                    f"AI returned malformed JSON (parse error: entry {i} is not an object)"
                )
            raw = data.get("imageIndex")
            if raw is None:
                missing += 1
                continue
            try:
                idx = int(raw)
            except (TypeError, ValueError):
                raise ValueError(
                    f"AI returned malformed JSON (parse error: entry {i} has a non-numeric imageIndex)"
                )
            if idx < 0 or idx >= len(images) or idx in seen:
                raise ValueError(
                    f"AI returned malformed JSON (parse error: entry {i} has an invalid or duplicate imageIndex {idx})"
                )
            seen.add(idx)
            indexed.append((idx, data))

        if indexed and missing:
            raise ValueError(
                "AI returned malformed JSON (parse error: inconsistent imageIndex — "
                "some receipts declared an image but others did not)"
            )
        if indexed:
            data_list = [data for _, data in sorted(indexed, key=lambda t: t[0])]

        results = []
        for i, data in enumerate(data_list):
            if not isinstance(data, dict):
                raise ValueError(
                    f"AI returned malformed JSON (parse error: entry {i} is not an object)"
                )
            try:
                # Sanitize items (no per-item tax/discount — see _parse_extracted_items)
                items = _parse_extracted_items(data.get("items"))

                # Flag all scans for review
                status = ReceiptStatus.NEEDS_REVIEW

                results.append(ReceiptCreate(
                    supplier=data.get("supplier", "Unknown"),
                    totalAmount=sanitize_numeric(data.get("totalAmount")),
                    taxAmount=sanitize_numeric(data.get("taxAmount")),
                    receiptDate=data.get("receiptDate", ""),
                    category=data.get("category", "Other"),
                    invoiceNumber=data.get("invoiceNumber"),
                    kraPin=data.get("kraPin"),
                    buyerKraPin=data.get("buyerKraPin"),
                    cuInvoice=data.get("cuInvoice"),
                    items=items,
                    status=status
                ))
            except Exception as e:
                logger.error(f"Failed to parse item {i} in batch: {e}")
                results.append(None)

        return results

    except Exception as e:
        logger.exception("Batch extraction failed")
        raise ValueError(f"Batch extraction failed: {str(e)}")


async def generate_ai_summary(receipts_data: str, api_key: Optional[str] = None) -> str:
    try:
        if not api_key:
            from app.services import admin_keys_service
            admin = await admin_keys_service.get_provider_override("gemini")
            if admin and admin.get("enabled") and admin.get("api_key"):
                api_key = admin["api_key"]
        if not api_key:
            return "AI summary unavailable."
        key = api_key
        prompt = f"""You are a financial analyst. Analyze these receipt records and generate a concise spending summary.

Receipt data:
{receipts_data}

Provide:
1. Total spending overview
2. Spending by category (with percentages)
3. Top suppliers by spend
4. Notable patterns or observations

Use bullet points. Be concise but insightful."""
        response = await _gemini_generate_content(
            key, "gemini-3.1-flash-lite-preview",
            prompt,
            generation_config=genai.types.GenerationConfig(
                temperature=0.2,
                max_output_tokens=500,
            )
        )
        return response.text.strip()
    except Exception as e:
        logger.error(f"AI summary generation failed: {e}")
        return "AI summary unavailable."


async def test_api_key(api_key: str, model_id: str = "gemini-3-flash-preview", provider: str = "gemini") -> Tuple[bool, Optional[str]]:
    """
    Test if an API key is valid by making a minimal request.

    Returns (ok, error_detail) so callers can surface/log the specific failure
    (e.g. payment/quota 402, 401, 429) instead of a generic message.
    """
    try:
        if provider == "gemini":
            response = await _gemini_generate_content(api_key, model_id, "ping")
            if response.text:
                return True, None
            return False, "Empty response from model"
        elif provider == "deepseek":
            # Actual DeepSeek auth test
            client = get_deepseek_client(api_key)
            # Minimal model list request to test auth
            await client.models.list()
            return True, None
        elif provider == "openrouter":
            # OpenRouter is OpenAI-compatible — auth test via model list
            client = get_openrouter_client(api_key)
            await client.models.list()
            return True, None
        elif provider == "qwen":
            # DashScope compatible-mode — a tiny chat completion is the most
            # reliable auth check (the /models endpoint is not guaranteed).
            client = get_qwen_client(api_key)
            resp = await client.chat.completions.create(
                model=model_id,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=1,
            )
            if resp.choices:
                return True, None
            return False, "Empty response from model"
        return False, "Unsupported provider config"
    except Exception as e:
        logger.error(f"API Key test failed: {e}")
        return False, str(e)[:600]
