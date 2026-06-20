/**
 * Queue Service — BullMQ Reminder Scheduling
 *
 * Creates a durable "reminder-queue" backed by Redis.
 * Reminders are scheduled using BullMQ's built-in `delay` option so the
 * job only becomes processable once the target time arrives.
 *
 * If Redis is not available, scheduling is silently skipped.
 */

import { Queue } from "bullmq";
import { createRedisConnection, isRedisAvailable } from "../config/redis";
import { ReminderJobData } from "../types";

const REMINDER_QUEUE_NAME = "reminder-queue";

/** Lazily initialised queue — null if Redis is unavailable. */
let reminderQueue: Queue<ReminderJobData> | null = null;
let queueInitFailed = false;

/**
 * Returns the reminder queue, creating it on first call.
 * Returns null if Redis is not available.
 */
function getQueue(): Queue<ReminderJobData> | null {
  if (queueInitFailed || !isRedisAvailable()) return null;
  if (reminderQueue) return reminderQueue;

  try {
    reminderQueue = new Queue<ReminderJobData>(REMINDER_QUEUE_NAME, {
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

    return reminderQueue;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[Queue] ⚠️ Could not create reminder queue: ${errMsg}`);
    queueInitFailed = true;
    return null;
  }
}

/**
 * Schedules a reminder to be sent at a specific future date.
 *
 * @param taskId    - The Prisma Task ID (used as idempotency key).
 * @param executeAt - The exact Date when the reminder should fire.
 * @param targetJid - The WhatsApp JID to send the reminder to.
 * @param message   - The human-readable reminder text.
 * @returns The BullMQ job ID, or null if Redis is unavailable.
 */
export async function scheduleReminder(
  taskId: string,
  executeAt: Date,
  targetJid: string,
  message: string
): Promise<string | null> {
  const queue = getQueue();

  if (!queue) {
    console.warn(`[Queue] ⚠️ Skipped scheduling reminder "${message}" — Redis not available`);
    return null;
  }

  const now = Date.now();
  const delayMs = Math.max(0, executeAt.getTime() - now);

  const job = await queue.add(
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

// ── Daily Briefing Queue ──
const BRIEFING_QUEUE_NAME = "briefing-queue";
let briefingQueue: Queue | null = null;

export async function setupBriefingCron(): Promise<void> {
  if (!isRedisAvailable()) return;

  if (!briefingQueue) {
    briefingQueue = new Queue(BRIEFING_QUEUE_NAME, {
      connection: createRedisConnection() as any,
    });
  }

  // Clear existing repeatable jobs to avoid duplicates on restart
  const repeatableJobs = await briefingQueue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await briefingQueue.removeRepeatableByKey(job.key);
  }

  // Add the daily 7:30 AM (Colombo time) briefing job
  await briefingQueue.add(
    "morning-briefing" as any,
    {},
    {
      repeat: {
        pattern: "30 7 * * *",
        tz: "Asia/Colombo",
      },
    }
  );

  console.log("[Queue] 📅 Scheduled daily morning briefing at 07:30 Asia/Colombo");
}

export { getQueue as getReminderQueue, briefingQueue };
