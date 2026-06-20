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
import { User, Task, WhitelistedNumber, WhitelistRole, TaskCategory } from "../models";
import { extractIntent } from "../services/ai.service";
import { scheduleReminder } from "../services/queue.service";
import { createGoogleCalendarEvent, sendGmail, getGoogleAuthUrl } from "../services/google.service";

const TIMEZONE: string = process.env.TIMEZONE || "Asia/Colombo";
const ADMIN_JID: string = process.env.ADMIN_JID || "";

// ── Blocked Attempts Store ─────────────────────────────────────────────
export interface BlockedAttempt {
  jid: string;
  name: string;
  time: Date;
}

export const blockedAttempts: BlockedAttempt[] = [];

export function addToBlockedAttempts(jid: string, name: string): void {
  const index = blockedAttempts.findIndex((a) => a.jid === jid);
  if (index !== -1) {
    blockedAttempts.splice(index, 1);
  }
  blockedAttempts.unshift({ jid, name, time: new Date() });
  if (blockedAttempts.length > 20) {
    blockedAttempts.pop();
  }
}

/**
 * Retrieves the WhitelistRole for a JID, fallback checking phone number part.
 */
export async function getJidRole(jid: string): Promise<WhitelistRole | null> {
  const phoneOnly = jid.split("@")[0];

  // Admin is always OWNER
  if (ADMIN_JID) {
    const adminJids = ADMIN_JID.split(",").map(j => j.trim());
    for (const aJid of adminJids) {
      const adminPhone = aJid.split("@")[0];
      if (phoneOnly === adminPhone || jid === aJid) {
        return "OWNER";
      }
    }
  }

  const entry = await WhitelistedNumber.findOne({
    $or: [
      { phone: phoneOnly },
      { phone: jid }
    ]
  });

  if (!entry || !entry.active) return null;
  return entry.role;
}

/**
 * Checks if a JID is whitelisted.
 */
async function isWhitelisted(jid: string): Promise<boolean> {
  const role = await getJidRole(jid);
  return role !== null;
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
  googleSynced: boolean,
  assignee: string | null = null
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

  if (assignee) {
    reply += `\n👤 Delegated to: *${assignee}*`;
  }

  if (googleSynced) {
    reply += `\n\n📅 _Synced to Google Calendar & Gmail_`;
  }

  reply += `\n\n_Stored in your Second Brain 🧠_`;

  if (assignee) {
    const forwardText = encodeURIComponent(`Hi ${assignee},\n\nReminder: ${content}`);
    reply += `\n\n👉 *Forward to ${assignee}:*\nhttps://wa.me/?text=${forwardText}`;
  }

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

        // Skip groups and status updates
        if (jid.endsWith("@g.us") || jid === "status@broadcast") continue;

        const role = await getJidRole(jid);
        const text = getMessageText(message);

        // ── WhatsApp Admin Commands ──
        if (text && text.trim().startsWith("!whitelist")) {
          if (role === "OWNER" || role === "ADMIN") {
            const parts = text.trim().split(/\s+/);
            const cmd = parts[1]?.toLowerCase();

            if (cmd === "add") {
              const targetPhone = parts[2];
              if (!targetPhone) {
                await sock.sendMessage(jid, {
                  text: "❌ *Usage:*\n`!whitelist add <phone/JID> [label] [role]`\n\nExample:\n`!whitelist add 94771112222 Alice ADMIN`",
                }, { quoted: message });
                continue;
              }

              let targetRole: WhitelistRole = "MEMBER";
              let label = "";

              if (parts.length > 3) {
                const lastWord = parts[parts.length - 1].toUpperCase();
                if (lastWord === "MEMBER" || lastWord === "ADMIN" || lastWord === "OWNER") {
                  targetRole = lastWord as WhitelistRole;
                  label = parts.slice(3, parts.length - 1).join(" ");
                } else {
                  label = parts.slice(3).join(" ");
                }
              }

              // Access check: only OWNER can add/promote to OWNER or ADMIN
              if (targetRole === "OWNER" && role !== "OWNER") {
                await sock.sendMessage(jid, { text: "❌ Only the Owner can create other Owners." }, { quoted: message });
                continue;
              }
              if (targetRole === "ADMIN" && role !== "OWNER") {
                await sock.sendMessage(jid, { text: "❌ Only the Owner can create Admins." }, { quoted: message });
                continue;
              }

              const cleanPhone = targetPhone.replace(/\+/g, "");

              const existingWhitelist = await WhitelistedNumber.findOne({ phone: cleanPhone });

              if (existingWhitelist) {
                await WhitelistedNumber.updateOne(
                  { phone: cleanPhone },
                  { label: label || null, role: targetRole, active: true }
                );
              } else {
                await WhitelistedNumber.create({
                  phone: cleanPhone, label: label || null, role: targetRole
                });
              }

              await sock.sendMessage(jid, {
                text: `✅ *Success*\n\nNumber/JID *+${cleanPhone}* has been whitelisted as *${targetRole}*.\nLabel: ${label || "none"}`,
              }, { quoted: message });
              continue;
            }

            if (cmd === "remove") {
              const targetPhone = parts[2];
              if (!targetPhone) {
                await sock.sendMessage(jid, { text: "❌ *Usage:*\n`!whitelist remove <phone/JID>`" }, { quoted: message });
                continue;
              }

              const cleanPhone = targetPhone.replace(/\+/g, "");

              const existing = await WhitelistedNumber.findOne({ phone: cleanPhone });
              if (!existing) {
                await sock.sendMessage(jid, { text: `⚠️ Number *+${cleanPhone}* is not whitelisted.` }, { quoted: message });
                continue;
              }

              if (existing.role === "OWNER") {
                await sock.sendMessage(jid, { text: `❌ Cannot remove the OWNER.` }, { quoted: message });
                continue;
              }
              if (existing.role === "ADMIN" && role !== "OWNER") {
                await sock.sendMessage(jid, { text: "❌ Only the Owner can remove Admins." }, { quoted: message });
                continue;
              }

              await WhitelistedNumber.deleteOne({ phone: cleanPhone });

              await sock.sendMessage(jid, {
                text: `✅ *Removed*\n\nNumber/JID *${cleanPhone}* has been removed from the whitelist.`,
              }, { quoted: message });
              continue;
            }

            if (cmd === "list") {
              const all = await WhitelistedNumber.find().sort({ role: 1, phone: 1 });

              let listText = "📋 *Whitelisted Numbers & JIDs:*\n\n";
              for (const item of all) {
                listText += `• *+${item.phone}* [${item.role}] - ${item.label || "No label"} (${item.active ? "Active" : "Disabled"})\n`;
              }

              await sock.sendMessage(jid, { text: listText }, { quoted: message });
              continue;
            }

            await sock.sendMessage(jid, {
              text: "❌ *Unknown Whitelist Command*\n\nAvailable commands:\n• `!whitelist list`\n• `!whitelist add <phone/JID> [label] [role]`\n• `!whitelist remove <phone/JID>`",
            }, { quoted: message });
            continue;
          }
        }

        // ── Whitelist gate ──
        if (role === null) {
          console.log(`[Whitelist] ⛔ Blocked message from non-whitelisted JID: ${jid}`);
          addToBlockedAttempts(jid, message.pushName || "Unknown");

          await sock.sendMessage(jid, {
            text: "🔒 *Access Restricted*\n\nThis bot is private. Your number is not authorized to use this service.\n\nContact the administrator to get access.",
          });
          continue;
        }

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

        // ── Pre-fetch user and memory for context ──
        let user = await User.findOne({ whatsappJid: jid });

        if (user) {
          if (message.pushName && message.pushName !== user.name) {
            user = await User.findOneAndUpdate(
              { whatsappJid: jid },
              { name: message.pushName },
              { new: true }
            );
          }
        } else {
          user = await User.create({
            whatsappJid: jid,
            name: message.pushName || null,
          });
        }

        // Fetch up to 30 most recent active tasks/notes to inject into AI memory
        const activeMemories = await Task.find({
          userId: user._id,
          status: "PENDING",
        })
          .sort({ createdAt: -1 })
          .limit(30);

        let userContext = "";
        if (activeMemories.length > 0) {
          userContext = activeMemories
            .map((m) => `[${m.category}] ${m.title}${m.dueAt ? ` (Due: ${m.dueAt.toISOString()})` : ""}`)
            .join("\n");
        }

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
            currentTimestamp,
            userContext
          );
        } else if (image) {
          extraction = await extractIntent(
            {
              image: {
                data: image.data.toString("base64"),
                mimeType: image.mimeType,
              },
            },
            currentTimestamp,
            userContext
          );
        } else {
          extraction = await extractIntent({ text: text! }, currentTimestamp, userContext);
        }

        console.log("[AI Result]", JSON.stringify(extraction, null, 2));

        if (extraction.type === "CHAT") {
          await sock.sendPresenceUpdate("paused", jid);
          await sock.sendMessage(jid, { text: extraction.content }, { quoted: message });
          console.log(`[Reply] ✅ Chat response sent to ${jid}`);
        } else {
          const task = await Task.create({
            title: extraction.content,
            category: extraction.type as TaskCategory,
            dueAt: extraction.dueAt ? new Date(extraction.dueAt) : null,
            userId: user!._id,
          });

          console.log(`[DB] Created ${extraction.type} (id: ${task.id}) for user ${user.id}`);

          // ── Schedule reminder if applicable ──
          if (extraction.type === "REMINDER" && extraction.dueAt) {
            const executeAt = new Date(extraction.dueAt);

            if (executeAt.getTime() > Date.now()) {
              await scheduleReminder(task._id.toString(), executeAt, jid, extraction.content);
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
              `Created via WhatsApp Second Brain 🧠 for Task ID: ${task._id}`
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
            googleSynced,
            extraction.assignee
          );

          await sock.sendMessage(jid, { text: reply }, { quoted: message });
          console.log(`[Reply] ✅ Confirmation sent to ${jid}`);
        }
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
