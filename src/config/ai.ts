/**
 * Google Generative AI (Gemini) client initialisation.
 * Validates the API key at startup and exports a reusable client instance.
 */

import { GoogleGenAI } from "@google/genai";

const GEMINI_API_KEY: string | undefined = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error(
    "GEMINI_API_KEY is not set. Add it to your .env file. " +
      "Get one at https://aistudio.google.com/apikey"
  );
}

/** Pre-configured Google GenAI client. */
export const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

/** Model identifier used for all inference calls. */
export const AI_MODEL: string = process.env.AI_MODEL || "gemini-2.0-flash";
