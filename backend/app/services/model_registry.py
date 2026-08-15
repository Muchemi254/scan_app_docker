import logging

# Define model registries (In a real scenario, these could be fetched dynamically from APIs)
# We structure this to be easily extended or replaced by dynamic fetching later.

MODELS = {
    "gemini": [
        {"id": "gemini-3.1-pro-preview", "name": "Gemini 3.1 Pro", "description": "Google's most intelligent model, built on state-of-the-art reasoning", "supports_thinking": False},
        {"id": "gemini-3-flash-preview", "name": "Gemini 3 Flash", "description": "Frontier-class performance optimized for speed and efficiency", "supports_thinking": False},
        {"id": "gemini-3.1-flash-lite-preview", "name": "Gemini 3.1 Flash-Lite", "description": "Highly efficient, low-cost model for massive-scale tasks", "supports_thinking": False},
        {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "description": "High-capability reasoning and coding model with 1M context", "supports_thinking": False},
        {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "description": "Lightning-fast and versatile for low latency applications", "supports_thinking": False},
        {"id": "gemini-2.5-flash-lite", "name": "Gemini 2.5 Flash-Lite", "description": "Streamlined, budget-friendly model balancing cost and performance", "supports_thinking": False},
    ],
    "deepseek": [
        {"id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "description": "High-performance flash model by DeepSeek", "supports_thinking": True},
        {"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro", "description": "Advanced reasoning pro model by DeepSeek", "supports_thinking": True},
    ],
    "openrouter": [
        {"id": "qwen/qwen3-vl-8b-instruct", "name": "Qwen3 VL 8B Instruct", "description": "Fast, low-cost vision model for high-volume scanning", "supports_thinking": False},
        {"id": "qwen/qwen3-vl-8b-thinking", "name": "Qwen3 VL 8B Thinking", "description": "Reasoning variant of Qwen3 VL 8B for harder receipts", "supports_thinking": True},
        {"id": "qwen/qwen3-vl-30b-a3b-instruct", "name": "Qwen3 VL 30B A3B Instruct", "description": "Bigger but still cheap MoE vision model", "supports_thinking": False},
        {"id": "qwen/qwen3-vl-32b-instruct", "name": "Qwen3 VL 32B Instruct", "description": "Mid-size vision model balancing cost and OCR quality", "supports_thinking": False},
        {"id": "qwen/qwen3-vl-235b-a22b-instruct", "name": "Qwen3 VL 235B Instruct", "description": "Large vision-language model for hardest documents", "supports_thinking": False},
    ],
    "qwen": [
        {"id": "qwen3-vl-flash", "name": "Qwen3 VL Flash", "description": "Fast, low-cost Alibaba vision model for high-volume scanning", "supports_thinking": True},
        {"id": "qwen3-vl-plus", "name": "Qwen3 VL Plus", "description": "Higher-accuracy hybrid-thinking vision model", "supports_thinking": True},
        {"id": "qwen3-vl-235b-a22b-instruct", "name": "Qwen3 VL 235B Instruct", "description": "Large MoE vision-language model for hardest documents", "supports_thinking": False},
        {"id": "qwen3-vl-235b-a22b-thinking", "name": "Qwen3 VL 235B Thinking", "description": "Large MoE vision model that always reasons before answering", "supports_thinking": True},
        {"id": "qwen3.6-flash", "name": "Qwen3.6 Flash", "description": "Fast multimodal flash model — successor to Qwen3-VL-Flash", "supports_thinking": True},
        {"id": "qwen3.7-plus", "name": "Qwen3.7 Plus", "description": "Flagship value multimodal model with vision", "supports_thinking": True},
        {"id": "qwen-vl-ocr", "name": "Qwen VL OCR", "description": "Specialized Alibaba OCR model for receipt/document text extraction", "supports_thinking": False, "caveat": "Raw OCR model: reads text but does NOT reliably structure receipts. Supplier is often blank or misread, item lines are missed, and output can be very long or truncated. Expect to fix fields in review — prefer Qwen3 VL Plus/Flash or Gemini for accurate structured data."},
    ]
}

def get_models_for_provider(provider: str):
    """Retrieve models for a given provider."""
    return MODELS.get(provider, [])

def get_all_models():
    """Retrieve all available models."""
    return MODELS
