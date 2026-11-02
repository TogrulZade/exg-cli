import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { appName, onShutdown } from '@st/core';

export { startWorker } from './worker.js';

export const QUEUE_NAME = process.env.QUEUE_NAME || 'default';
// Redis keys start with the project name, so several projects can share one Redis server.
export const QUEUE_PREFIX = process.env.QUEUE_PREFIX || appName();
const DISPATCH_TIMEOUT_MS = Number(process.env.QUEUE_DISPATCH_TIMEOUT_MS || 5000);

export function redisConnection(options = {}) {
  return new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', options);
}

// Created on the first dispatch, so tests and a server without Redis start normally.
let queue;
let connection;
let lastError;

function getQueue() {
  if (!queue) {
    connection = redisConnection();
    queue = new Queue(QUEUE_NAME, {
      connection,
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3, // Laravel $tries
        backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s
        removeOnComplete: 1000, // keep the last 1000 finished jobs
        removeOnFail: 5000,
      },
    });
    // Without a listener an 'error' event would crash the process. Log each new error once.
    queue.on('error', (error) => {
      if (error.message !== lastError) console.error('Queue error:', error.message);
      lastError = error.message;
    });
  }
  return queue;
}

// Like Laravel's SendWelcomeEmail::dispatch($data):
//   import { dispatch } from '@st/queue';
//   import SendWelcomeEmail from '../jobs/SendWelcomeEmail.js';
//   await dispatch(SendWelcomeEmail, { userId: user.id });
// Options: { delay: 60_000 } (ms), { priority: 1 }, { attempts: 5 } ...
export async function dispatch(job, data = {}, options = {}) {
  if (typeof job !== 'function' || !job.name) {
    throw new TypeError('dispatch() expects a job function imported from src/jobs');
  }
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Queue unavailable: Redis did not answer within ${DISPATCH_TIMEOUT_MS}ms`)), DISPATCH_TIMEOUT_MS);
  });
  try {
    // The worker finds the handler by this name in src/jobs/index.js.
    return await Promise.race([getQueue().add(job.name, data, options), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Runs on shutdown: an open Redis connection keeps the process alive.
export async function closeQueue() {
  if (!queue) return;
  await queue.close();
  await connection.quit().catch(() => connection.disconnect());
  queue = undefined;
}

onShutdown(closeQueue);
