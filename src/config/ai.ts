/**
 * AI Configuration
 *
 * Validates the API key at startup and exports configuration variables.
 */

const API_KEY: string | undefined = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;

if (!API_KEY) {
  throw new Error(
    "API Key is not set. Add OPENROUTER_API_KEY or GEMINI_API_KEY to your .env file."
  );
}

/** Pre-configured API key. */
export const apiKey = API_KEY;

/** Model identifier used for inference calls. */
export const AI_MODEL: string = process.env.AI_MODEL || "gemini-2.5-flash";

/** Base URL for the OpenAI-compatible API endpoint */
export const AI_BASE_URL: string = process.env.AI_BASE_URL || "https://openrouter.ai/api/v1/chat/completions";
