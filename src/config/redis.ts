/**
 * Redis connection factory for BullMQ queues and workers.
 * Each consumer (queue / worker) needs its own IORedis instance because
 * BullMQ uses blocking commands that monopolise a connection.
 *
 * Limits retries to 3 attempts and logs minimally to avoid spam.
 */

import IORedis from "ioredis";

const REDIS_URL: string = process.env.REDIS_URL || "redis://localhost:6379";

let redisAvailable = false;

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

/**
 * Checks if Redis is available by attempting a connection with a timeout.
 * This prevents BullMQ from running and spamming connection errors.
 */
export async function checkRedisConnection(): Promise<boolean> {
  console.log(`[Redis] Testing connection to ${REDIS_URL}...`);
  return new Promise((resolve) => {
    const client = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      showFriendlyErrorStack: false,
    });

    let resolved = false;

    client.on("connect", () => {
      if (!resolved) {
        resolved = true;
        redisAvailable = true;
        client.disconnect();
        resolve(true);
      }
    });

    client.on("error", () => {
      if (!resolved) {
        resolved = true;
        redisAvailable = false;
        client.disconnect();
        resolve(false);
      }
    });

    // Fallback timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        redisAvailable = false;
        client.disconnect();
        resolve(false);
      }
    }, 2500);
  });
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
      return delay;
    },
  });

  connection.on("error", () => {
    // Silently ignore — checkRedisConnection and retryStrategy handle logging
  });

  connection.on("connect", () => {
    redisAvailable = true;
  });

  return connection;
}
