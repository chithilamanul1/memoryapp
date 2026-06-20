import { Worker, Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { createRedisConnection } from "../config/redis";
import { getSocket } from "../whatsapp/connection";
import { generateMorningBriefing } from "../services/ai.service";

const prisma = new PrismaClient();

/**
 * Starts the BullMQ worker that processes the daily morning briefing.
 */
export function startBriefingWorker(): Worker {
  const worker = new Worker(
    "briefing-queue",
    async (job: Job) => {
      console.log(`[BriefingWorker] Starting daily morning briefing job ${job.id}`);

      const sock = getSocket();
      if (!sock) {
        throw new Error("WhatsApp socket is not available. Will retry.");
      }

      // Get start and end of today in Asia/Colombo time
      const now = new Date();
      const colomboDateStr = now.toLocaleString("en-US", { timeZone: "Asia/Colombo" });
      const colomboDate = new Date(colomboDateStr);
      
      const startOfDay = new Date(colomboDate);
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date(colomboDate);
      endOfDay.setHours(23, 59, 59, 999);

      try {
        const users = await prisma.user.findMany({
          include: {
            tasks: {
              where: {
                completed: false,
                dueAt: {
                  gte: startOfDay,
                  lte: endOfDay,
                },
              },
            },
          },
        });

        console.log(`[BriefingWorker] Found ${users.length} active users to check for briefings.`);

        for (const user of users) {
          if (user.tasks.length === 0) {
            continue; // No tasks due today, skip briefing
          }

          const taskDescriptions = user.tasks.map(t => t.title);
          const userName = user.name || "friend";

          console.log(`[BriefingWorker] Generating briefing for ${user.whatsappJid} with ${taskDescriptions.length} tasks...`);
          
          const briefingMessage = await generateMorningBriefing(userName, taskDescriptions);

          await sock.sendMessage(user.whatsappJid, { text: briefingMessage });
          
          // Slight delay between messages to prevent rate-limits
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log(`[BriefingWorker] ✅ Daily briefing completed successfully`);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[BriefingWorker] ❌ Failed to process briefing: ${errMsg}`);
        throw error;
      }
    },
    {
      connection: createRedisConnection() as any,
      concurrency: 1,
    }
  );

  worker.on("failed", (job: Job | undefined, err: Error) => {
    console.error(`[BriefingWorker] Job ${job?.id ?? "unknown"} failed: ${err.message}`);
  });

  worker.on("error", (err: Error) => {
    console.error("[BriefingWorker] Worker error:", err.message);
  });

  console.log("[BriefingWorker] 🚀 Morning briefing worker started");
  return worker;
}
