/**
 * Google Services Integration
 *
 * Integrates Google Calendar (for scheduling task events) and Gmail
 * (for sending alerts, summaries, and notifications).
 *
 * Uses OAuth2 credentials provided via environment variables. If they
 * are not set, it fails gracefully with warnings, allowing the bot to
 * function without Google services active.
 */

import { google } from "googleapis";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const USER_EMAIL = process.env.USER_EMAIL; // Default email to send summaries to

const isConfigured = !!(
  GOOGLE_CLIENT_ID &&
  GOOGLE_CLIENT_SECRET &&
  GOOGLE_REFRESH_TOKEN
);

let oauth2Client: any = null;

if (isConfigured) {
  oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI || "urn:ietf:wg:oauth:2.0:oob"
  );

  oauth2Client.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN,
  });
  
  console.log("[Google Service] ✅ OAuth2 client initialised successfully");
} else {
  console.warn(
    "[Google Service] ⚠️ Credentials missing (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN). " +
      "Google Calendar and Gmail integrations will run in simulation mode."
  );
}

/**
 * Creates an event in the user's primary Google Calendar.
 *
 * @param title - Event title.
 * @param dueAt - The scheduled time.
 * @param description - Additional task details.
 */
export async function createGoogleCalendarEvent(
  title: string,
  dueAt: Date,
  description?: string
): Promise<void> {
  if (!isConfigured || !oauth2Client) {
    console.warn(`[Google Calendar] Simulating event creation: "${title}" at ${dueAt.toISOString()}`);
    return;
  }

  try {
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    
    // Set event duration to 30 minutes by default
    const endTime = new Date(dueAt.getTime() + 30 * 60 * 1000);

    const event = {
      summary: title,
      description: description || "Created by Sera Second Brain 🧠",
      start: {
        dateTime: dueAt.toISOString(),
        timeZone: process.env.TIMEZONE || "Asia/Colombo",
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: process.env.TIMEZONE || "Asia/Colombo",
      },
      reminders: {
        useDefault: true,
      },
    };

    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: event,
    });

    console.log(`[Google Calendar] ✅ Event created: ${res.data.htmlLink}`);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Google Calendar] ❌ Failed to create event: ${errMsg}`);
  }
}

/**
 * Sends an email using Gmail API.
 *
 * @param to - Recipient email.
 * @param subject - Email subject.
 * @param body - HTML or text body of the email.
 */
export async function sendGmail(
  to: string,
  subject: string,
  body: string
): Promise<void> {
  const recipient = to || USER_EMAIL;
  
  if (!recipient) {
    console.warn("[Gmail] No recipient email specified. Skipping send.");
    return;
  }

  if (!isConfigured || !oauth2Client) {
    console.warn(`[Gmail] Simulating email to ${recipient}: Subject: "${subject}"`);
    return;
  }

  try {
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    
    // Create base64 RFC 2822 email format
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`;
    const messageParts = [
      `To: ${recipient}`,
      "Content-Type: text/html; charset=utf-8",
      "MIME-Version: 1.0",
      `Subject: ${utf8Subject}`,
      "",
      body,
    ];
    const message = messageParts.join("\n");
    const encodedMessage = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodedMessage,
      },
    });

    console.log(`[Gmail] ✅ Email successfully sent to ${recipient}`);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Gmail] ❌ Failed to send email: ${errMsg}`);
  }
}
