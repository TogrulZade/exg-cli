import { Worker } from 'bullmq';
import { handleProcessEvents, onShutdown } from '@st/core';
import { QUEUE_NAME, QUEUE_PREFIX, redisConnection } from './index.js';

// Laravel-dəki php artisan queue:work kimi. jobs: { JobName: handlerFunction }
export function startWorker(jobs) {
  handleProcessEvents();
  const worker = new Worker(QUEUE_NAME, async (job) => {
    const handle = jobs[job.name];
    if (!handle) throw new Error(`Unknown job "${job.name}". Register it in src/jobs/index.js.`);
    return handle(job.data, job);
  }, {
    // Workers wait on Redis with blocking commands; BullMQ requires maxRetriesPerRequest: null here.
    connection: redisConnection({ maxRetriesPerRequest: null }),
    prefix: QUEUE_PREFIX,
    concurrency: Number(process.env.QUEUE_CONCURRENCY || 5),
  });

  worker.on('ready', () => console.log(`Worker is processing the "${QUEUE_NAME}" queue`));
  worker.on('completed', (job) => console.log(`✔ ${job.name} #${job.id}`));
  worker.on('failed', (job, error) => {
    console.error(`✖ ${job?.name} #${job?.id} (attempt ${job?.attemptsMade}/${job?.opts.attempts ?? 1}): ${error.message}`);
  });
  worker.on('error', (error) => console.error('Worker error:', error.message));

  // 'stop' phase: running jobs finish before the database and Redis are closed.
  onShutdown(() => worker.close(), 'stop');
  return worker;
}
