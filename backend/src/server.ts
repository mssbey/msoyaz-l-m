import { createApp } from './http/app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';
import { closeQueues } from './queues/queues.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV, dryRun: env.SENTOS_DRY_RUN }, 'MSO API ayakta');
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Kapatiliyor...');
  server.close();
  await closeQueues();
  await disconnectPrisma();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
