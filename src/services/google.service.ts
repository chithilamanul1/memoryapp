/**
 * Google Services Integration (Multi-User Capable)
 *
 * Provides functions to generate OAuth login URLs, exchange redirect codes for tokens,
 * and perform calendar event creation / email dispatches per user.
 */

import { google } from "googleapis";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback";

const isConfigured = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

/** Returns true if Google OAuth is configured on the server. */
export function isGoogleConfigured(): boolean {
  return isConfigured;
}

/** Generates Google OAuth Link, storing the user's WhatsApp JID in the state parameter. */
export function getGoogleAuthUrl(whatsappJid: string): string {
  if (!isConfigured) return "";
  
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    state: whatsappJid,
  });
}

/** Exchanges authorization redirect code for credentials. */
export async function getTokensFromCode(code: string): Promise<any> {
  if (!isConfigured) {
    throw new Error("Google OAuth credentials are not configured on this server.");
  }
  
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

/** Retrieves authenticated email address using a refresh token. */
export async function getUserEmail(refreshToken: string): Promise<string | null> {
  if (!isConfigured) return null;

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({ refresh_token: refreshToken });

  try {
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const info = await oauth2.userinfo.get();
    return info.data.email || null;
  } catch (error) {
    console.error("[Google Service] Failed to retrieve user email:", error);
    return null;
  }
}

/** Instantiates a user-specific Google OAuth2 Client. */
function getClientForUser(refreshToken: string) {
  if (!isConfigured) return null;

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return oauth2Client;
}

/**
 * Creates an event in the user's primary Google Calendar.
 */
export async function createGoogleCalendarEvent(
  refreshToken: string,
  title: string,
  dueAt: Date,
  description?: string
): Promise<void> {
  const auth = getClientForUser(refreshToken);
  if (!auth) {
    console.warn(`[Google Calendar] Google auth skipped for "${title}" (not configured)`);
    return;
  }

  try {
    const calendar = google.calendar({ version: "v3", auth });
    
    // Default event to 30 mins
    const endTime = new Date(dueAt.getTime() + 30 * 60 * 1000);

    await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
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
      },
    });

    console.log(`[Google Calendar] ✅ Event created: "${title}"`);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Google Calendar] ❌ Failed to create event: ${errMsg}`);
  }
}

/**
 * Sends a notification email via the user's Gmail account.
 */
export async function sendGmail(
  refreshToken: string,
  recipientEmail: string,
  subject: string,
  body: string
): Promise<void> {
  const auth = getClientForUser(refreshToken);
  if (!auth || !recipientEmail) {
    console.warn(`[Gmail] Email to "${recipientEmail}" skipped (not configured)`);
    return;
  }

  try {
    const gmail = google.gmail({ version: "v1", auth });
    
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`;
    const messageParts = [
      `To: ${recipientEmail}`,
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

    console.log(`[Gmail] ✅ Email successfully sent to ${recipientEmail}`);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Gmail] ❌ Failed to send email: ${errMsg}`);
  }
}
