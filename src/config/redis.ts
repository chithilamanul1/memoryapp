/**
 * Redis connection factory for BullMQ queues and workers.
 * Each consumer (queue / worker) needs its own IORedis instance because
 * BullMQ uses blocking commands that monopolise a connection.
 */

import IORedis from "ioredis";

const REDIS_URL: string = process.env.REDIS_URL || "redis://localhost:6379";

export function createRedisConnection(): IORedis {
  const connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    retryStrategy(times: number): number | null {
      if (times > 10) {
        console.error("[Redis] Max reconnection attempts reached. Giving up.");
        return null;
      }
      const delay = Math.min(times * 500, 5000);
      console.warn(`[Redis] Reconnecting in ${delay}ms (attempt ${times})...`);
      return delay;
    },
  });

  connection.on("error", (err: Error) => {
    console.error("[Redis] Connection error:", err.message);
  });

  connection.on("connect", () => {
    console.log("[Redis] Connected successfully");
  });

  return connection;
}
