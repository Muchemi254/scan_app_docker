/**
 * Gemini Prompt Caching Utility
 *
 * This module provides helpers for implementing Gemini's prompt caching feature,
 * which reduces input token costs by 90% for cached content after the first request.
 *
 * How it works:
 * 1. First request: Full input tokens charged (normal rate)
 * 2. Subsequent requests: Cached input = 10% of normal rate
 * 3. Cache TTL: 5 minutes
 * 4. Min cached content: 1024 tokens (Gemini requirement)
 *
 * Cost example with prompt caching:
 * - 100 requests with 2000-token cached system prompt
 * - First: 2000 tokens @ $0.075/M = $0.00015
 * - Remaining 99: 2000 tokens @ $0.0225/M = $0.000045 each = $0.004455 total
 * - Savings: ~90% on cached portion
 */

export interface CachedPromptConfig {
  systemInstructions: string;
  userPrompt: string;
  model: 'gemini-1.5-flash' | 'gemini-2.5-flash';
  temperature?: number;
  maxOutputTokens?: number;
}

export interface CacheStats {
  totalRequests: number;
  cachedRequests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

class GeminiCacheManager {
  private stats: CacheStats = {
    totalRequests: 0,
    cachedRequests: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
  };

  /**
   * Build a request payload with caching enabled
   */
  buildCachedPayload(config: CachedPromptConfig) {
    return {
      systemInstruction: {
        parts: [{ text: config.systemInstructions }],
        cachedContent: true
      },
      contents: [
        {
          role: "user",
          parts: [{ text: config.userPrompt }]
        }
      ],
      generationConfig: {
        temperature: config.temperature ?? 0.1,
        maxOutputTokens: config.maxOutputTokens ?? 256
      }
    };
  }

  /**
   * Update cache stats from API response
   */
  updateStats(usage: any) {
    this.stats.totalRequests++;

    if (usage.cacheReadTokens > 0) {
      this.stats.cachedRequests++;
    }

    this.stats.inputTokens += usage.promptTokens || 0;
    this.stats.cachedTokens += usage.cacheReadTokens || 0;
    this.stats.outputTokens += usage.outputTokens || 0;

    // Rough cost estimate
    const inputCost = ((usage.promptTokens || 0) * 0.075) / 1_000_000;
    const cachedCost = ((usage.cacheReadTokens || 0) * 0.0225) / 1_000_000;
    const outputCost = ((usage.outputTokens || 0) * 0.3) / 1_000_000;

    this.stats.estimatedCost += inputCost + cachedCost + outputCost;
  }

  getStats() {
    return { ...this.stats };
  }

  getCostReduction() {
    if (this.stats.totalRequests === 0) return 0;
    const costWithoutCache = (this.stats.inputTokens + this.stats.cachedTokens) * 0.075 / 1_000_000;
    const costWithCache = (this.stats.inputTokens * 0.075 + this.stats.cachedTokens * 0.0225) / 1_000_000;
    return ((costWithoutCache - costWithCache) / costWithoutCache * 100).toFixed(1);
  }

  reset() {
    this.stats = {
      totalRequests: 0,
      cachedRequests: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    };
  }
}

export const geminiCacheManager = new GeminiCacheManager();
