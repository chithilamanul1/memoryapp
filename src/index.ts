/**
 * Application Entry Point
 *
 * Bootstraps the entire Sera Second Brain system:
 *   1. Loads environment variables from .env
 *   2. Connects to PostgreSQL via Prisma
 *   3. Starts the BullMQ reminder worker (Redis)
 *   4. Initialises the Baileys WhatsApp socket connection
 *
 * Includes graceful shutdown handling for SIGINT / SIGTERM.
 */

import dotenv from "dotenv";
dotenv.config();

import { PrismaClient } from "@prisma/client";
import { startWhatsApp } from "./whatsapp/connection";
import { startReminderWorker } from "./workers/reminder.worker";
import { Worker } from "bullmq";
import { ReminderJobData } from "./types";

const prisma = new PrismaClient();
let reminderWorker: Worker<ReminderJobData> | null = null;

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   🧠  Sera Second Brain — Starting up   ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // ── Step 1: Database ──────────────────────────────────────────────────
  try {
    await prisma.$connect();
    console.log("[Database] ✅ PostgreSQL connected via Prisma");
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Database] ❌ Failed to connect: ${errMsg}`);
    console.error(
      "[Database] Make sure PostgreSQL is running and DATABASE_URL is correct in .env"
    );
    process.exit(1);
  }

  // ── Step 2: BullMQ Worker ─────────────────────────────────────────────
  try {
    reminderWorker = startReminderWorker();
    console.log("[Worker] ✅ BullMQ reminder worker initialised");
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Worker] ❌ Failed to start reminder worker: ${errMsg}`);
    console.error("[Worker] Make sure Redis is running and REDIS_URL is correct in .env");
    process.exit(1);
  }

  // ── Step 3: WhatsApp ──────────────────────────────────────────────────
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
    await prisma.$disconnect();
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
