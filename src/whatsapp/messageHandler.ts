/**
 * WhatsApp Message Handler
 *
 * Listens to `messages.upsert` events from Baileys and orchestrates:
 *   1. Filtering (skip self-messages, group messages, non-supported media).
 *   2. Handling special command triggers like "link google".
 *   3. Handling voice/audio & image messages by downloading from WA Web servers.
 *   4. Presence simulation ("composing…" indicator for a natural feel).
 *   5. AI intent extraction via OpenRouter (supports text, voice & image inputs).
 *   6. Prisma persistence (upsert User, create Task).
 *   7. BullMQ scheduling (if the intent is a REMINDER with a dueAt).
 *   8. Google Calendar and Gmail sync (if the user has linked their account).
 *   9. Sending a human-like confirmation reply.
 */

import { WASocket, WAMessage, downloadContentFromMessage } from "@whiskeysockets/baileys";
import { PrismaClient, TaskCategory } from "@prisma/client";
import { extractIntent } from "../services/ai.service";
import { scheduleReminder } from "../services/queue.service";
import { createGoogleCalendarEvent, sendGmail, getGoogleAuthUrl } from "../services/google.service";

const prisma = new PrismaClient();

const TIMEZONE: string = process.env.TIMEZONE || "Asia/Colombo";
const ADMIN_JID: string = process.env.ADMIN_JID || "";

/**
 * Checks if a WhatsApp JID is whitelisted.
 * The ADMIN_JID is always allowed. Otherwise, the phone portion
 * of the JID is looked up in the whitelisted_numbers collection.
 */
async function isWhitelisted(jid: string): Promise<boolean> {
  const phone = jid.split("@")[0];

  // Admin is always whitelisted
  if (ADMIN_JID) {
    const adminPhone = ADMIN_JID.split("@")[0];
    if (phone === adminPhone) return true;
  }

  const entry = await prisma.whitelistedNumber.findUnique({
    where: { phone },
  });

  return !!entry && entry.active;
}

// ── Utility helpers ────────────────────────────────────────────────────

/** Extracts the text body from various WhatsApp message types. */
function getMessageText(message: WAMessage): string | null {
  const msg = message.message;
  if (!msg) return null;

  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    null
  );
}

/** Downloads and buffers an audio/voice message from WhatsApp. */
async function downloadAudioMessage(
  message: WAMessage
): Promise<{ data: Buffer; mimeType: string } | null> {
  const msg = message.message;
  if (!msg) return null;

  const audioMessage =
    msg.audioMessage ||
    msg.ephemeralMessage?.message?.audioMessage ||
    msg.viewOnceMessage?.message?.audioMessage ||
    msg.viewOnceMessageV2?.message?.audioMessage;

  if (!audioMessage) return null;

  const mimeType = audioMessage.mimetype || "audio/ogg";

  console.log(`[Message] Downloading audio message (${mimeType}, size: ${audioMessage.fileLength} bytes)...`);

  const stream = await downloadContentFromMessage(audioMessage, "audio");
  
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }

  return { data: buffer, mimeType };
}

/** Downloads and buffers an image message from WhatsApp. */
async function downloadImageMessage(
  message: WAMessage
): Promise<{ data: Buffer; mimeType: string } | null> {
  const msg = message.message;
  if (!msg) return null;

  const imageMessage =
    msg.imageMessage ||
    msg.ephemeralMessage?.message?.imageMessage ||
    msg.viewOnceMessage?.message?.imageMessage ||
    msg.viewOnceMessageV2?.message?.imageMessage;

  if (!imageMessage) return null;

  const mimeType = imageMessage.mimetype || "image/jpeg";

  console.log(`[Message] Downloading image message (${mimeType}, size: ${imageMessage.fileLength} bytes)...`);

  const stream = await downloadContentFromMessage(imageMessage, "image");
  
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }

  return { data: buffer, mimeType };
}

/** Returns true if the message was sent by the bot itself. */
function isFromMe(message: WAMessage): boolean {
  return message.key.fromMe === true;
}

/** Extracts the sender's JID from the message. */
function getJid(message: WAMessage): string | null {
  return message.key.remoteJid || null;
}

/** Promise-based sleep for humanising response timing. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Formats the current timestamp for the AI prompt context. */
function getCurrentTimestamp(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

// ── Confirmation message builder ───────────────────────────────────────

/** Builds a rich WhatsApp confirmation reply based on the extraction result. */
function buildConfirmation(
  type: TaskCategory,
  content: string,
  dueAt: string | null,
  googleSynced: boolean
): string {
  const icons: Record<TaskCategory, string> = {
    REMINDER: "⏰",
    NOTE: "📝",
    TASK: "✅",
  };

  const labels: Record<TaskCategory, string> = {
    REMINDER: "Reminder Set",
    NOTE: "Note Saved",
    TASK: "Task Added",
  };

  let reply = `${icons[type]} *${labels[type]}*\n\n`;
  reply += `📌 ${content}`;

  if (dueAt) {
    const date = new Date(dueAt);
    const formatted = date.toLocaleString("en-US", {
      timeZone: TIMEZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    reply += `\n🕐 ${formatted}`;
  }

  if (googleSynced) {
    reply += `\n\n📅 _Synced to Google Calendar & Gmail_`;
  }

  reply += `\n\n_Stored in your Second Brain 🧠_`;
  return reply;
}

// ── Main handler registration ──────────────────────────────────────────

/**
 * Registers the `messages.upsert` listener on the given Baileys socket.
 * Should be called once per socket lifecycle (on connect/reconnect).
 */
export function registerMessageHandler(sock: WASocket): void {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const message of messages) {
      try {
        // ── Gate checks ──
        if (isFromMe(message)) continue;

        const jid = getJid(message);
        if (!jid) continue;

        if (jid.endsWith("@g.us")) continue;

        // ── Whitelist gate ──
        const allowed = await isWhitelisted(jid);
        if (!allowed) {
          console.log(`[Whitelist] ⛔ Blocked message from non-whitelisted JID: ${jid}`);
          await sock.sendMessage(jid, {
            text: "🔒 *Access Restricted*\n\nThis bot is private. Your number is not authorized to use this service.\n\nContact the administrator to get access.",
          });
          continue;
        }

        const text = getMessageText(message);
        
        // ── Handle Command Triggers ──
        if (text) {
          const trimmed = text.trim().toLowerCase();
          if (trimmed === "link" || trimmed === "link google" || trimmed === "connect google") {
            await sock.sendPresenceUpdate("composing", jid);
            await sleep(1000);
            
            const authUrl = getGoogleAuthUrl(jid);
            if (authUrl) {
              await sock.sendMessage(jid, {
                text: `🔗 *Link Your Google Account*\n\nClick the link below to grant Second Brain access to your Google Calendar & Gmail:\n\n${authUrl}\n\n_Make sure to return here after authorization!_`
              }, { quoted: message });
            } else {
              await sock.sendMessage(jid, {
                text: `⚠️ Google Integration is not configured on this server. Please add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the .env file.`
              }, { quoted: message });
            }
            continue;
          }
        }

        const audio = await downloadAudioMessage(message);
        const image = await downloadImageMessage(message);

        // If neither text, audio, nor image is present, skip
        if (!text && !audio && !image) continue;

        if (text) {
          console.log(`[Message] 📩 From ${jid} (Text): "${text}"`);
        } else if (audio) {
          console.log(`[Message] 🎙️ From ${jid} (Audio): [Downloaded ${audio.data.length} bytes]`);
        } else if (image) {
          console.log(`[Message] 🖼️ From ${jid} (Image): [Downloaded ${image.data.length} bytes]`);
        }

        // ── Humanise: show "composing…" presence ──
        await sock.sendPresenceUpdate("composing", jid);
        await sleep(1500 + Math.random() * 1000);

        // ── AI intent extraction ──
        const currentTimestamp = getCurrentTimestamp();
        let extraction;
        
        if (audio) {
          extraction = await extractIntent(
            {
              audio: {
                data: audio.data.toString("base64"),
                mimeType: audio.mimeType,
              },
            },
            currentTimestamp
          );
        } else if (image) {
          extraction = await extractIntent(
            {
              image: {
                data: image.data.toString("base64"),
                mimeType: image.mimeType,
              },
            },
            currentTimestamp
          );
        } else {
          extraction = await extractIntent({ text: text! }, currentTimestamp);
        }

        console.log("[AI Result]", JSON.stringify(extraction, null, 2));

        // ── Persist to database ──
        const user = await prisma.user.upsert({
          where: { whatsappJid: jid },
          update: { name: message.pushName || undefined },
          create: {
            whatsappJid: jid,
            name: message.pushName || null,
          },
        });

        const task = await prisma.task.create({
          data: {
            title: extraction.content,
            category: extraction.type as TaskCategory,
            dueAt: extraction.dueAt ? new Date(extraction.dueAt) : null,
            userId: user.id,
          },
        });

        console.log(`[DB] Created ${extraction.type} (id: ${task.id}) for user ${user.id}`);

        // ── Schedule reminder if applicable ──
        if (extraction.type === "REMINDER" && extraction.dueAt) {
          const executeAt = new Date(extraction.dueAt);

          if (executeAt.getTime() > Date.now()) {
            await scheduleReminder(task.id, executeAt, jid, extraction.content);
          } else {
            console.warn(
              `[Queue] Skipped scheduling — dueAt (${extraction.dueAt}) is in the past`
            );
          }
        }

        // ── Google Calendar & Gmail Sync ──
        let googleSynced = false;
        
        if (user.googleRefreshToken && user.googleEmail && extraction.dueAt) {
          const eventDate = new Date(extraction.dueAt);
          
          // 1. Sync event to Google Calendar
          await createGoogleCalendarEvent(
            user.googleRefreshToken,
            extraction.content,
            eventDate,
            `Created via WhatsApp Second Brain 🧠 for Task ID: ${task.id}`
          );

          // 2. Send email notification via Gmail
          const emailSubject = `⏰ Second Brain Alert: ${extraction.content}`;
          const emailBody = `
            <h3>Second Brain Reminder Saved 🧠</h3>
            <p><strong>Task:</strong> ${extraction.content}</p>
            <p><strong>Category:</strong> ${extraction.type}</p>
            <p><strong>Scheduled For:</strong> ${eventDate.toString()}</p>
            <hr />
            <p><em>This event has been automatically synchronized with your Google Calendar.</em></p>
          `;
          
          await sendGmail(user.googleRefreshToken, user.googleEmail, emailSubject, emailBody);
          googleSynced = true;
        }

        // ── Send confirmation reply ──
        await sock.sendPresenceUpdate("paused", jid);

        const reply = buildConfirmation(
          extraction.type as TaskCategory,
          extraction.content,
          extraction.dueAt,
          googleSynced
        );

        await sock.sendMessage(jid, { text: reply }, { quoted: message });

        console.log(`[Reply] ✅ Confirmation sent to ${jid}`);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[MessageHandler] ❌ Error processing message: ${errMsg}`);

        const jid = getJid(message);
        if (jid) {
          try {
            await sock.sendMessage(jid, {
              text: "⚠️ Oops! I couldn't process that message. Please try again in a moment.",
            });
          } catch (sendError: unknown) {
            const sendErrMsg =
              sendError instanceof Error ? sendError.message : String(sendError);
            console.error(
              `[MessageHandler] Failed to send error reply: ${sendErrMsg}`
            );
          }
        }
      }
    }
  });

  console.log("[MessageHandler] ✅ Message handler registered");
}
