// Files written by `st install:queue` and `st make:job`.
import { readFileSync } from 'node:fs';

// @st layout: the queue is a framework package (src/@st/queue), the app only keeps jobs and worker.js.
const stFile = (name) => readFileSync(new URL(`./st/queue/${name}`, import.meta.url), 'utf8');
export const stQueuePackage = stFile('package.json');
export const stQueueIndex = stFile('index.js');
export const stQueueWorker = stFile('worker.js');

export const stWorker = `import 'dotenv/config';
import { startWorker } from '@st/queue';
import { jobs } from './jobs/index.js';

// Laravel-dəki php artisan queue:work kimi. İşə salmaq: npm run queue:work
// Ctrl+C və deploy zamanı işləyən job-lar bitir, sonra baza və Redis bağlanır (@st/core).
startWorker(jobs);
`;

export const queueIndex = `import { readFileSync } from 'node:fs';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const QUEUE_NAME = process.env.QUEUE_NAME || 'default';
// Redis keys start with the project name, so several projects can share one Redis server.
const projectName = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).name;
export const QUEUE_PREFIX = process.env.QUEUE_PREFIX || projectName || 'bull';
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
//   import SendWelcomeEmail from '../jobs/SendWelcomeEmail.js';
//   await dispatch(SendWelcomeEmail, { userId: user.id });
// Options: { delay: 60_000 } (ms), { priority: 1 }, { attempts: 5 } ...
export async function dispatch(job, data = {}, options = {}) {
  if (typeof job !== 'function' || !job.name) {
    throw new TypeError('dispatch() expects a job function imported from src/jobs');
  }
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(\`Queue unavailable: Redis did not answer within \${DISPATCH_TIMEOUT_MS}ms\`)), DISPATCH_TIMEOUT_MS);
  });
  try {
    // The worker finds the handler by this name in src/jobs/index.js.
    return await Promise.race([getQueue().add(job.name, data, options), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Call on shutdown: an open Redis connection keeps the process alive.
export async function closeQueue() {
  if (!queue) return;
  await queue.close();
  await connection.quit().catch(() => connection.disconnect());
  queue = undefined;
}
`;

export const jobsIndex = `// Laravel-dəki app/Jobs kimi: hər job öz faylındadır və burada qeydiyyata alınır.
// Worker job-u adına görə bu siyahıda tapır. Yeni job: st make:job SendWelcomeEmail
export const jobs = {
};
`;

export const worker = `import 'dotenv/config';
import { Worker } from 'bullmq';
import { QUEUE_NAME, QUEUE_PREFIX, redisConnection } from './queues/index.js';
import { jobs } from './jobs/index.js';

// Laravel-dəki php artisan queue:work kimi. İşə salmaq: npm run queue:work
const worker = new Worker(QUEUE_NAME, async (job) => {
  const handle = jobs[job.name];
  if (!handle) throw new Error(\`Unknown job "\${job.name}". Register it in src/jobs/index.js.\`);
  return handle(job.data, job);
}, {
  // Workers wait on Redis with blocking commands; BullMQ requires maxRetriesPerRequest: null here.
  connection: redisConnection({ maxRetriesPerRequest: null }),
  prefix: QUEUE_PREFIX,
  concurrency: Number(process.env.QUEUE_CONCURRENCY || 5),
});

worker.on('ready', () => console.log(\`Worker is processing the "\${QUEUE_NAME}" queue\`));
worker.on('completed', (job) => console.log(\`✔ \${job.name} #\${job.id}\`));
worker.on('failed', (job, error) => {
  console.error(\`✖ \${job?.name} #\${job?.id} (attempt \${job?.attemptsMade}/\${job?.opts.attempts ?? 1}): \${error.message}\`);
});
worker.on('error', (error) => console.error('Worker error:', error.message));

// Let running jobs finish before exiting (Ctrl+C, deploys).
async function shutdown() {
  await worker.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
`;

export function jobTemplate(name, { st = false } = {}) {
  return `// Laravel-dəki Job::handle() kimi. Göndərmək:
//   import { dispatch } from '${st ? '@st/queue' : '../queues/index.js'}';
//   import ${name} from '../jobs/${name}.js';
//   await dispatch(${name}, { userId: user.id });
//
// data Redis-də JSON kimi saxlanılır: bütöv obyekt yox, id göndər və ən son datanı burada bazadan oxu.
// Xəta atsan job yenidən cəhd edilir (default 3 dəfə). Funksiyanın adını dəyişmə: worker onu adına görə tapır.
export default async function ${name}(data, job) {
  // TODO: işin məntiqini yaz.
  console.log(\`${name} #\${job.id}\`, data);
}
`;
}
