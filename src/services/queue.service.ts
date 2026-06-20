/**
 * Queue Service — BullMQ Reminder Scheduling
 *
 * Creates a durable "reminder-queue" backed by Redis.
 * Reminders are scheduled using BullMQ's built-in `delay` option so the
 * job only becomes processable once the target time arrives.
 */

import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis";
import { ReminderJobData } from "../types";

const REMINDER_QUEUE_NAME = "reminder-queue";

/** Singleton reminder queue instance. */
export const reminderQueue = new Queue<ReminderJobData>(REMINDER_QUEUE_NAME, {
  connection: createRedisConnection() as any,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },   // Keep last 100 completed for debugging
    removeOnFail: { count: 50 },        // Keep last 50 failed for inspection
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000, // 5s → 10s → 20s
    },
  },
});

reminderQueue.on("error", (err: Error) => {
  console.error("[Queue] Reminder queue error:", err.message);
});

/**
 * Schedules a reminder to be sent at a specific future date.
 *
 * @param taskId    - The Prisma Task ID (used as idempotency key).
 * @param executeAt - The exact Date when the reminder should fire.
 * @param targetJid - The WhatsApp JID to send the reminder to.
 * @param message   - The human-readable reminder text.
 * @returns The BullMQ job ID.
 */
export async function scheduleReminder(
  taskId: string,
  executeAt: Date,
  targetJid: string,
  message: string
): Promise<string> {
  const now = Date.now();
  const delayMs = Math.max(0, executeAt.getTime() - now);

  const job = await reminderQueue.add(
    "send-reminder" as any,
    {
      taskId,
      targetJid,
      message,
    },
    {
      delay: delayMs,
      jobId: `reminder-${taskId}`, // Prevents duplicate scheduling for the same task
    }
  );

  const readableDelay =
    delayMs < 60_000
      ? `${Math.round(delayMs / 1000)}s`
      : delayMs < 3_600_000
        ? `${Math.round(delayMs / 60_000)}m`
        : `${(delayMs / 3_600_000).toFixed(1)}h`;

  console.log(
    `[Queue] Scheduled reminder "${message}" → ${executeAt.toISOString()} (fires in ~${readableDelay})`
  );

  return job.id!;
}
