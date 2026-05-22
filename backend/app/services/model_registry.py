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
        {"id": "gemini-2.0-flash", "name": "Gemini 2.0 Flash", "description": "Stable and efficient legacy 2.0 vision processing", "supports_thinking": False},
        {"id": "gemini-2.0-flash-lite", "name": "Gemini 2.0 Flash-Lite", "description": "Highly optimized legacy 2.0 model for speed", "supports_thinking": False},
    ],
    "deepseek": [
        {"id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "description": "High-performance flash model by DeepSeek", "supports_thinking": True},
        {"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro", "description": "Advanced reasoning pro model by DeepSeek", "supports_thinking": True},
    ]
}

def get_models_for_provider(provider: str):
    """Retrieve models for a given provider."""
    return MODELS.get(provider, [])

def get_all_models():
    """Retrieve all available models."""
    return MODELS
