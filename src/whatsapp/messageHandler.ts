/**
 * WhatsApp Message Handler
 *
 * Listens to `messages.upsert` events from Baileys and orchestrates:
 *   1. Filtering (skip self-messages, group messages, non-supported media).
 *   2. Handling voice/audio messages by downloading from WA Web servers.
 *   3. Presence simulation ("composing…" indicator for a natural feel).
 *   4. AI intent extraction via Gemini (supports raw text & raw voice inputs).
 *   5. Prisma persistence (upsert User, create Task).
 *   6. BullMQ scheduling (if the intent is a REMINDER with a dueAt).
 *   7. Sending a human-like confirmation reply.
 */

import { WASocket, WAMessage, downloadContentFromMessage } from "@whiskeysockets/baileys";
import { PrismaClient, TaskCategory } from "@prisma/client";
import { extractIntent } from "../services/ai.service";
import { scheduleReminder } from "../services/queue.service";

const prisma = new PrismaClient();

const TIMEZONE: string = process.env.TIMEZONE || "Asia/Colombo";

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

  // Resolve audio/voice messages (handles standard audio, push-to-talk, ephemeral, and view-once)
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
  dueAt: string | null
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
    // Only process real-time notifications, not history sync
    if (type !== "notify") return;

    for (const message of messages) {
      try {
        // ── Gate checks ──
        if (isFromMe(message)) continue;

        const jid = getJid(message);
        if (!jid) continue;

        // Skip group messages — only handle DMs
        if (jid.endsWith("@g.us")) continue;

        const text = getMessageText(message);
        const audio = await downloadAudioMessage(message);

        // If neither text nor audio is present, skip (unsupported message type like contact, location, sticker)
        if (!text && !audio) continue;

        if (text) {
          console.log(`[Message] 📩 From ${jid} (Text): "${text}"`);
        } else if (audio) {
          console.log(`[Message] 🎙️ From ${jid} (Audio): [Downloaded ${audio.data.length} bytes]`);
        }

        // ── Humanise: show "composing…" presence ──
        await sock.sendPresenceUpdate("composing", jid);
        await sleep(1500 + Math.random() * 1000); // 1.5–2.5s natural delay

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
        } else {
          extraction = await extractIntent({ text: text! }, currentTimestamp);
        }

        console.log("[AI Result]", JSON.stringify(extraction, null, 2));

        // ── Persist to database ──

        // Upsert the user (create on first contact, update name on subsequent)
        const user = await prisma.user.upsert({
          where: { whatsappJid: jid },
          update: { name: message.pushName || undefined },
          create: {
            whatsappJid: jid,
            name: message.pushName || null,
          },
        });

        // Create the task/note/reminder record
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

        // ── Send confirmation reply ──
        await sock.sendPresenceUpdate("paused", jid);

        const reply = buildConfirmation(
          extraction.type as TaskCategory,
          extraction.content,
          extraction.dueAt
        );

        await sock.sendMessage(jid, { text: reply }, { quoted: message });

        console.log(`[Reply] ✅ Confirmation sent to ${jid}`);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[MessageHandler] ❌ Error processing message: ${errMsg}`);

        // Attempt to send a friendly error reply
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
