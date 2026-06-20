/**
 * Application Entry Point
 *
 * Bootstraps the entire Sera Second Brain system:
 *   1. Loads environment variables from .env
 *   2. Connects to MongoDB via Prisma
 *   3. Starts the Dashboard Web Server
 *   4. Starts the BullMQ reminder worker (Redis)
 *   5. Initialises the Baileys WhatsApp socket connection
 *
 * Includes graceful shutdown handling for SIGINT / SIGTERM.
 */

import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { WhitelistedNumber } from "./models";
import { startWhatsApp } from "./whatsapp/connection";
import { startReminderWorker } from "./workers/reminder.worker";
import { startBriefingWorker } from "./workers/briefing.worker";
import { setupBriefingCron } from "./services/queue.service";
import { startWebServer } from "./server";
import { Worker } from "bullmq";
import { ReminderJobData } from "./types";

import { checkRedisConnection } from "./config/redis";


let reminderWorker: Worker<ReminderJobData> | null = null;
let briefingWorker: Worker | null = null;

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   🧠  Sera Second Brain — Starting up   ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // ── Step 1: Database ──────────────────────────────────────────────────
  try {
    await mongoose.connect(process.env.DATABASE_URL as string);
    console.log("[Database] ✅ MongoDB connected via Mongoose");

    // Seed Owner from environment variables
    if (process.env.ADMIN_JID) {
      const adminJids = process.env.ADMIN_JID.split(",").map(j => j.trim());
      for (const aJid of adminJids) {
        const adminPhone = aJid.split("@")[0];
        const existingAdmin = await WhitelistedNumber.findOne({ phone: adminPhone });

        if (existingAdmin) {
          await WhitelistedNumber.updateOne(
            { phone: adminPhone },
            { role: "OWNER", label: "Super Admin (Owner)" }
          );
        } else {
          await WhitelistedNumber.create({
            phone: adminPhone,
            role: "OWNER",
            label: "Super Admin (Owner)",
          });
        }
        console.log(`[Database] ✅ Seeded Admin/Owner number: +${adminPhone}`);
      }
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Database] ❌ Failed to connect: ${errMsg}`);
    console.error(
      "[Database] Make sure MongoDB is running and DATABASE_URL is correct in .env"
    );
    process.exit(1);
  }

  // ── Step 2: Web Server Dashboard ──────────────────────────────────────
  try {
    startWebServer();
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Web Server] ❌ Failed to start dashboard: ${errMsg}`);
  }

  // ── Step 3: BullMQ Workers (Optional — fails gracefully if Redis unavailable) ──
  const redisUp = await checkRedisConnection();
  if (redisUp) {
    try {
      reminderWorker = startReminderWorker();
      briefingWorker = startBriefingWorker();
      await setupBriefingCron();
      console.log("[Worker] ✅ BullMQ workers and cron jobs initialised");
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[Worker] ⚠️ Workers failed to initialize: ${errMsg}`);
    }
  } else {
    console.warn("[Worker] ⚠️ Redis is down or unavailable. Workers disabled.");
  }

  // ── Step 4: WhatsApp ──────────────────────────────────────────────────
  try {
    await startWhatsApp();
    console.log("[WhatsApp] ✅ Baileys connection initialised");
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[WhatsApp] ❌ Failed to start: ${errMsg}`);
    process.exit(1);
  }

  console.log("\n🟢 Sera Second Brain is running. Waiting for messages...\n");
}

// ── Graceful shutdown ──────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[Shutdown] Received ${signal}. Cleaning up...`);

  try {
    if (reminderWorker) {
      await reminderWorker.close();
      console.log("[Shutdown] Reminder worker closed");
    }
  } catch (err) {
    console.error("[Shutdown] Error closing worker:", err);
  }

  try {
    await mongoose.disconnect();
    console.log("[Shutdown] Database disconnected");
  } catch (err) {
    console.error("[Shutdown] Error disconnecting database:", err);
  }

  console.log("[Shutdown] Goodbye! 👋");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── Launch ─────────────────────────────────────────────────────────────

main().catch((error: unknown) => {
  console.error("[Fatal]", error);
  process.exit(1);
});
