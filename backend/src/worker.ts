import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';
import { startWorkers } from './queues/workers.js';
import { startCron } from './cron/scheduler.js';

/**
 * Ayri surec: kuyruk isleyicileri + zamanlanmis gorevler.
 * API sureci sadece istek karsilar, agir isler burada calisir.
 */
const workers = startWorkers();
const tasks = startCron();

async function shutdown(signal: string) {
  logger.info({ signal }, 'Worker kapatiliyor...');
  for (const task of tasks) task.stop();
  await Promise.all(workers.map((worker) => worker.close()));
  await disconnectPrisma();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
