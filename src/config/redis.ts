/**
 * Redis connection factory for BullMQ queues and workers.
 * Each consumer (queue / worker) needs its own IORedis instance because
 * BullMQ uses blocking commands that monopolise a connection.
 *
 * Limits retries to 3 attempts and logs minimally to avoid spam.
 */

import IORedis from "ioredis";

const REDIS_URL: string = process.env.REDIS_URL || "redis://localhost:6379";

let redisAvailable: boolean | null = null; // null = unknown

export function isRedisAvailable(): boolean {
  return redisAvailable === true;
}

export function createRedisConnection(): IORedis {
  const connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy(times: number): number | null {
      if (times > 3) {
        redisAvailable = false;
        return null; // Stop retrying
      }
      const delay = Math.min(times * 1000, 3000);
      if (times === 1) {
        console.warn(`[Redis] Connecting to ${REDIS_URL}...`);
      }
      return delay;
    },
  });

  connection.on("error", () => {
    // Silently ignore — retryStrategy handles logging
  });

  connection.on("connect", () => {
    redisAvailable = true;
    console.log("[Redis] ✅ Connected successfully");
  });

  return connection;
}
