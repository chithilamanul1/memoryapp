/**
 * Reminder Worker — BullMQ Job Processor
 *
 * Listens on the "reminder-queue" and processes matured jobs by:
 *   1. Retrieving the active Baileys socket.
 *   2. Sending the reminder message back to the user's WhatsApp.
 *   3. Marking the corresponding Task as completed in Prisma.
 */

import { Worker, Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { createRedisConnection } from "../config/redis";
import { ReminderJobData } from "../types";
import { getSocket } from "../whatsapp/connection";

const prisma = new PrismaClient();

/**
 * Starts the BullMQ worker that processes reminder jobs.
 * Should be called once during application bootstrap.
 *
 * @returns The Worker instance (can be used for graceful shutdown).
 */
export function startReminderWorker(): Worker<ReminderJobData> {
  const worker = new Worker<ReminderJobData>(
    "reminder-queue",
    async (job: Job<ReminderJobData>) => {
      const { taskId, targetJid, message } = job.data;

      console.log(
        `[Worker] Processing reminder job ${job.id}: "${message}" → ${targetJid}`
      );

      const sock = getSocket();
      if (!sock) {
        throw new Error(
          "WhatsApp socket is not available. Will retry on next attempt."
        );
      }

      try {
        // Send the reminder to the user on WhatsApp
        await sock.sendMessage(targetJid, {
          text:
            `⏰ *Reminder*\n\n` +
            `${message}\n\n` +
            `_— Your Second Brain 🧠_`,
        });

        // Mark the task as completed in the database
        await prisma.task.update({
          where: { id: taskId },
          data: { completed: true },
        });

        console.log(`[Worker] ✅ Reminder delivered: "${message}"`);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[Worker] ❌ Failed to deliver reminder: ${errMsg}`);
        throw error; // Re-throw so BullMQ triggers the retry/backoff strategy
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 10_000, // Max 10 jobs per 10 seconds to avoid WhatsApp rate-limits
      },
    }
  );

  worker.on("completed", (job: Job<ReminderJobData>) => {
    console.log(`[Worker] Job ${job.id} completed successfully`);
  });

  worker.on("failed", (job: Job<ReminderJobData> | undefined, err: Error) => {
    console.error(
      `[Worker] Job ${job?.id ?? "unknown"} failed: ${err.message}`
    );
  });

  worker.on("error", (err: Error) => {
    console.error("[Worker] Worker error:", err.message);
  });

  console.log("[Worker] 🚀 Reminder worker started and listening for jobs");
  return worker;
}
