/**
 * OpenRouter AI Configuration
 *
 * Validates the OpenRouter API key at startup and exports configuration variables.
 */

const OPENROUTER_API_KEY: string | undefined = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  throw new Error(
    "OPENROUTER_API_KEY is not set. Add it to your .env file. " +
      "Get one at https://openrouter.ai/keys"
  );
}

/** Pre-configured OpenRouter API key. */
export const apiKey = OPENROUTER_API_KEY;

/** Model identifier used for all OpenRouter inference calls. */
export const AI_MODEL: string = process.env.AI_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
