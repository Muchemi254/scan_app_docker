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

# ...

async def call_deepseek_api(api_key: str, model_id: str, prompt: str, content: Any = None, thinking_mode: bool = False):
    client = get_deepseek_client(api_key)
    messages = [{"role": "user", "content": content if content else prompt}]

    # Prepare optional arguments for thinking mode
    extra_params = {}
    if thinking_mode:
        extra_params["extra_body"] = {"thinking": {"type": "enabled"}}
        extra_params["reasoning_effort"] = "high"

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
        # DeepSeek error response body
        error_body = e.response.json() if hasattr(e, 'response') else str(e)
        
        logger.error(f"DeepSeek API Error {status_code}: {error_body}")
        
        error_map = {
            400: ("Invalid Format", "Invalid request body format."),
            401: ("Authentication Fails", "Wrong API key."),
            402: ("Insufficient Balance", "Ran out of balance."),
            422: ("Invalid Parameters", "Request contains invalid parameters."),
            429: ("Rate Limit Reached", "Requests too fast."),
            500: ("Server Error", "DeepSeek server issue."),
            503: ("Server Overloaded", "Server overloaded."),
        }
        
        desc, solution = error_map.get(status_code, ("Unknown Error", "Please check DeepSeek API documentation."))
        raise ValueError(f"DeepSeek API Error {status_code} ({desc}): {solution}")
    except Exception as e:
        logger.error(f"Unexpected DeepSeek API error: {str(e)}")
        raise

def sanitize_numeric(value: Any) -> str:
    """Strip all characters except digits and decimal point."""
    if value is None: return "0"
    # Remove everything except digits and dot
    sanitized = "".join(c for c in str(value) if c.isdigit() or c == '.')
    return sanitized if sanitized and sanitized != '.' else "0"

from app.schemas.receipt import ReceiptCreate, ReceiptItem, ReceiptStatus
from app.services.data_adapter import DataService
from app.core.encryption import decrypt_api_key

logger = logging.getLogger(__name__)

# genai.configure() modifies global state. Serialize all Gemini SDK calls
# that depend on it so concurrent requests with different per-user API keys
# cannot leak one user's data to another user's API key.
_gemini_lock = asyncio.Lock()


async def _gemini_generate_content(
    api_key: str,
    model_id: str,
    contents,
    generation_config=None,
):
    """Atomically configure genai and generate content under lock."""
    async with _gemini_lock:
        model = genai.GenerativeModel(model_id)
        genai.configure(api_key=api_key)
        return model.generate_content(contents, generation_config=generation_config)


async def get_gemini_config(user_id: Optional[str]) -> Tuple[str, str, str]:
    """
    Get configured API key, model ID, and provider for a user.
    """
    # Defaults
    api_key = settings.GEMINI_API_KEY
    model_id = "gemini-3-flash-preview"
    provider = "gemini"
    
    if user_id:
        try:
            ai_settings = await DataService.get_user_settings(user_id, "ai_config")
            if ai_settings:
                # IMPORTANT: use the provider currently active in user settings
                configs = ai_settings.get("configs", {})
                provider = ai_settings.get("provider", "gemini")
                
                if provider in configs and configs[provider].get("api_key"):
                    api_key = decrypt_api_key(configs[provider]["api_key"])
                
                # Check for model ID override if it exists
                if ai_settings.get("model_id"):
                    model_id = ai_settings.get("model_id")
                    
        except Exception as e:
            logger.error(f"Failed to load user AI settings, using defaults: {e}")
            
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
    "gemini-2.5-flash": {"input": 0.075, "cachedInput": 0.0225, "output": 0.3},
    "gemini-1.5-flash": {"input": 0.075, "cachedInput": 0.0225, "output": 0.3},
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

        # Get thinking mode
        thinking_mode = False
        if user_id:
             ai_settings = await DataService.get_user_settings(user_id, "ai_config")
             if ai_settings:
                 provider_config = ai_settings.get("configs", {}).get(provider, {})
                 thinking_mode = provider_config.get("thinking_mode", False)

        # Prepare category instructions
        category_instructions = f"""
        For the category field, analyze the supplier and items, then choose EXACTLY ONE:
        {', '.join(CATEGORIES)}
        Return ONLY the exact category name from the list."""

        prompt = f"""Extract receipt details from this image and return ONLY valid JSON.
        INSTRUCTIONS:
        - Include currency symbols if present
        - Use 'N/A' for missing fields
        - Dates in MM/DD/YYYY format
        - {category_instructions}
        - KRA PINs: Look for 'PIN', 'KRA', 'P051' format (P + 10 digits).
          The SELLER PIN (kraPin) belongs to the shop/supplier issuing the receipt.
          The BUYER PIN (buyerKraPin) belongs to the customer making the purchase.
          Often one appears near the top (seller) and one near the bottom (buyer/your company).
        - cuInvoice: The KRA-issued CU invoice/receipt number, typically labeled
          'CU Invoice', 'KRA CU', 'CU No', or appears as a long alphanumeric string
          starting with 'KRACU' or similar. This is different from the supplier's
          own invoice number.

        Return ONLY JSON object matching this structure:
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
        {{"name": "string", "quantity": number, "price": "string", "tax": "string", "isZeroRated": boolean}}
        ]
        }}"""

        if provider == "deepseek":
            content = [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{image_base64}"}}
            ]
            response_text = await call_deepseek_api(api_key, model_id, prompt, content, thinking_mode=thinking_mode)
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
            response_text = response.text.strip()
        if response_text.startswith("```"):
            response_text = response_text.split("```")[1]
            if response_text.startswith("json"):
                response_text = response_text[4:]
        response_text = response_text.strip()

        data = json.loads(response_text)

        # Validate and sanitize
        items = []
        for item in data.get("items", []):
            items.append({
                "name": item.get("name", "N/A"),
                "quantity": float(item.get("quantity", 1)),
                "price": sanitize_numeric(item.get("price")),
                "tax": sanitize_numeric(item.get("tax", "0")),
                "isZeroRated": item.get("isZeroRated", False)
            })

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
        logger.error(f"Failed to parse Gemini response as JSON: {e}")
        raise ValueError(f"Invalid response from Gemini: {str(e)}")
    except Exception as e:
        logger.error(f"Receipt extraction failed: {e}")
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
        # Get thinking mode
        thinking_mode = False
        if user_id:
             ai_settings = await DataService.get_user_settings(user_id, "ai_config")
             if ai_settings:
                 provider_config = ai_settings.get("configs", {}).get(provider, {})
                 thinking_mode = provider_config.get("thinking_mode", False)

        # Prepare category instructions
        category_instructions = f"""
For the category field, choose EXACTLY ONE from:
{', '.join(CATEGORIES)}
Return ONLY the exact category name from the list."""

        prompt = f"""Extract receipt details from these {len(images)} images.
Return a JSON ARRAY of objects, one for each image in the EXACT order they were provided.

INSTRUCTIONS per object:
- Include currency symbols if present
- Use 'N/A' for missing fields
- Dates in MM/DD/YYYY format
- {category_instructions}
- KRA PINs: The SELLER PIN (kraPin) is the supplier's PIN. The BUYER PIN (buyerKraPin)
  is the customer/your company's PIN. Look for P051 format (P + 10 digits).
- cuInvoice: KRA-issued CU number, often labeled 'CU Invoice' or starting 'KRACU'.

Return ONLY a JSON array matching this structure:
[
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
        {{"name": "string", "quantity": number, "price": "string", "tax": "string", "isZeroRated": boolean}}
    ]
  }},
  ...
]"""
        if provider == "deepseek":
            content = []
            for i, (b64, mime) in enumerate(images):
                content.append({"type": "text", "text": f"Image index {i}:"})
                content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
            content.append({"type": "text", "text": prompt})
            response_text = await call_deepseek_api(api_key, model_id, prompt, content, thinking_mode=thinking_mode)
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
            response_text = response.text.strip()
        data_list = json.loads(response_text)
        
        if not isinstance(data_list, list):
            # Fallback if AI returned single object instead of array
            data_list = [data_list]

        results = []
        for i, data in enumerate(data_list):
            if i >= len(images): break
            
            try:
                # Sanitize items
                items = []
                for item in data.get("items", []):
                    items.append({
                        "name": item.get("name", "N/A"),
                        "quantity": float(item.get("quantity", 1)),
                        "price": sanitize_numeric(item.get("price")),
                        "tax": sanitize_numeric(item.get("tax", "0")),
                        "isZeroRated": item.get("isZeroRated", False)
                    })

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

        # Pad with None if AI missed some images
        while len(results) < len(images):
            results.append(None)

        return results

    except Exception as e:
        logger.error(f"Batch extraction failed: {e}")
        raise ValueError(f"Batch extraction failed: {str(e)}")


async def generate_ai_summary(receipts_data: str, api_key: Optional[str] = None) -> str:
    try:
        key = api_key or settings.GEMINI_API_KEY
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
            key, "gemini-1.5-flash",
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


async def test_api_key(api_key: str, model_id: str = "gemini-3-flash-preview", provider: str = "gemini") -> bool:
    """
    Test if an API key is valid by making a minimal request.
    """
    try:
        if provider == "gemini":
            response = await _gemini_generate_content(api_key, model_id, "ping")
            return True if response.text else False
        elif provider == "deepseek":
            # Actual DeepSeek auth test
            client = get_deepseek_client(api_key)
            # Minimal model list request to test auth
            await client.models.list()
            return True 
        return False
    except Exception as e:
        logger.error(f"API Key test failed: {e}")
        return False
