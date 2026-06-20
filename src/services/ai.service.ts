/**
 * AI Service — Intent Extraction
 *
 * Feeds raw WhatsApp text or audio (voice messages) to Gemini and returns
 * structured JSON indicating whether the message is a REMINDER, NOTE, or TASK,
 * along with parsed content and an optional ISO-8601 due date.
 *
 * The system prompt is tuned for Sri Lankan Singlish / mixed English-Sinhala.
 */

import { genAI, AI_MODEL } from "../config/ai";
import { AIExtractionResult } from "../types";

const SYSTEM_PROMPT = `You are a highly accurate personal assistant that processes WhatsApp messages (text or voice messages) for a "Second Brain" productivity system. Your sole job is to analyse the incoming message and return structured JSON.

OUTPUT FORMAT — You MUST return ONLY a single JSON object matching this schema (no markdown, no explanation, no extra keys):
{
  "type": "REMINDER" | "NOTE" | "TASK",
  "content": "<clean, human-readable summary of what the user wants>",
  "dueAt": "<ISO 8601 timestamp with timezone offset, e.g. 2026-06-21T16:00:00+05:30> | null"
}

─── CLASSIFICATION RULES ───

1. REMINDER  
   The user wants to be reminded about something at a SPECIFIC time.  
   Trigger words (English): "remind me", "reminder", "don't forget", "alert me", "notify me at"  
   Trigger words (Sinhala/Singlish): "hathapaththu karanna", "mathaka karanna", "remind karanna", "mage mathakaya"  
   → dueAt MUST be set to a valid timestamp.

2. TASK  
   The user wants to track a to-do item that needs action but may not have a deadline.  
   Trigger words: "need to", "have to", "should", "must", "todo", "karanna oney", "karanna thiyenawa", "ganna oney"  
   → dueAt MAY be null if no time is specified.

3. NOTE  
   The user is saving a thought, idea, reference, or piece of information for later retrieval.  
   Trigger words: "note", "save this", "remember this", "liyala thiyanna", "idea", "thought", "memo", "write down"  
   → dueAt is almost always null.

If ambiguous, prefer TASK over NOTE, and REMINDER over TASK (only if a time is clearly present).

─── SRI LANKAN LANGUAGE CONTEXT ───

Users frequently write or speak in Sri Lankan English (Singlish), romanised Sinhala, spoken Sinhala, or a mix. You MUST handle these naturally:

• "Ammawa doctor langata geniyanna 4pm" → Take mom to the doctor at 4pm (REMINDER)
• "mata bread ganna oney heta" → I need to buy bread tomorrow (TASK — dueAt = tomorrow 09:00)
• "meeting eka 3pm Monday" → Meeting at 3pm on Monday (REMINDER)
• "heta morning 8ta gym yanna" → Go to gym tomorrow morning at 8 (REMINDER)
• "electricity bill bayanna" → Pay the electricity bill (TASK)
• "idea ekak: new app concept for delivery" → An idea: new app concept for delivery (NOTE)
• "amma call karanna 6ta" → Call mom at 6 (REMINDER)
• "project deadline next Friday" → Project deadline next Friday (REMINDER)
• "mage password eka: XYZ" → My password is: XYZ (NOTE — content should be "Password note: XYZ")
• "dinner 7.30 ta restaurant eke" → Dinner at 7:30 at the restaurant (REMINDER)

─── DATE / TIME RESOLUTION ───

The current system date-time will be provided. Resolve all relative references against it:

• "now" / "dhan" → current time + 1 minute  
• "today" / "ada" → today, default 09:00 if no time given  
• "tomorrow" / "heta" → next calendar day, default 09:00 if no time given  
• "morning" / "udey" → 08:00  
• "afternoon" / "dawwal" → 13:00  
• "evening" / "hawasa" → 18:00  
• "night" / "raey" → 21:00  
• "next Monday", "next week", etc. → resolve to that calendar day at 09:00  
• Explicit times like "4pm", "3.30", "8ta" → use the stated time  
• If the resolved time is in the past for "today", push to the next day  

Always include the timezone offset +05:30 (Asia/Colombo) in dueAt.

─── VOICE MESSAGE / AUDIO TRANSCRIPTION ───

If the input is an audio clip, the user is speaking their mind. You must:
1. Listen to the audio clip.
2. Transcribe it.
3. If spoken in Sinhala, Singlish, or mixed code, translate the core task description to clean English for the 'content' field.
4. Extract the intent and dueAt timestamp accordingly.

─── IMPORTANT ───
• Output ONLY the JSON object — no markdown fences, no explanation, no preamble.
• Keep "content" concise but complete (translate Sinhala portions to English in the content field).
• Never hallucinate times — if no time reference exists, set dueAt to null.`;

/**
 * Sends the raw WhatsApp message text or audio to Gemini for intent extraction.
 *
 * @param input - Contains either 'text' or 'audio' (with base64 data and mimeType)
 * @param currentTimestamp - A human-readable current date/time string for the LLM.
 * @returns Structured extraction result with type, content, and optional dueAt.
 */
export async function extractIntent(
  input: { text?: string; audio?: { data: string; mimeType: string } },
  currentTimestamp: string
): Promise<AIExtractionResult> {
  const userPromptText = `Current date and time: ${currentTimestamp}`;
  
  let contents: any[] = [];

  if (input.audio) {
    contents = [
      {
        role: "user",
        parts: [
          {
            text: `${userPromptText}\n\nThe user sent a voice message. Please listen to this audio message, transcribe/translate it to English, identify the intent (REMINDER, TASK, or NOTE), and return the final JSON object.`,
          },
          {
            inlineData: {
              data: input.audio.data,
              mimeType: input.audio.mimeType,
            },
          },
        ],
      },
    ];
  } else {
    contents = [
      {
        role: "user",
        parts: [
          {
            text: `${userPromptText}\n\nUser message: "${input.text || ""}"`,
          },
        ],
      },
    ];
  }

  try {
    const response = await genAI.models.generateContent({
      model: AI_MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });

    const responseText = response.text?.trim();

    if (!responseText) {
      throw new Error("Empty response received from AI model");
    }

    // Parse and validate the JSON response
    const parsed: unknown = JSON.parse(responseText);

    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("AI response is not a valid JSON object");
    }

    const result = parsed as Record<string, unknown>;

    // Validate 'type' field
    const validTypes = ["REMINDER", "NOTE", "TASK"] as const;
    if (!validTypes.includes(result.type as (typeof validTypes)[number])) {
      throw new Error(`Invalid extraction type: ${String(result.type)}`);
    }

    // Validate 'content' field
    if (typeof result.content !== "string" || result.content.trim().length === 0) {
      throw new Error("Missing or empty 'content' field in AI response");
    }

    // Validate 'dueAt' field
    if (result.dueAt !== null && typeof result.dueAt !== "string") {
      throw new Error(`Invalid 'dueAt' field type: ${typeof result.dueAt}`);
    }

    if (typeof result.dueAt === "string") {
      const parsedDate = new Date(result.dueAt);
      if (isNaN(parsedDate.getTime())) {
        throw new Error(`Cannot parse 'dueAt' as a valid date: ${result.dueAt}`);
      }
    }

    return {
      type: result.type as AIExtractionResult["type"],
      content: result.content as string,
      dueAt: (result.dueAt as string) ?? null,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[AI Service] Intent extraction failed: ${errMsg}`);

    // Graceful fallback — store as a NOTE so the user's data is never lost
    return {
      type: "NOTE",
      content: input.text || "Voice message note (transcription failed)",
      dueAt: null,
    };
  }
}
