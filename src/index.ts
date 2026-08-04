import { config } from './config.js';
import { logger } from './logger.js';
import { buildServer } from './http/server.js';
import { waClient } from './wa/client.js';
import { sendQueue } from './wa/sendQueue.js';

const SHUTDOWN_TIMEOUT_MS = 25_000;

async function main(): Promise<void> {
  const app = await buildServer();

  // Bind before opening the WhatsApp socket. A personal WhatsApp session must have
  // exactly one owner, and the loopback port bind is what enforces that: a second
  // instance fails EADDRINUSE here, before it can touch AUTH_DIR.
  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info(
    { host: config.HOST, port: config.PORT, authDir: config.AUTH_DIR },
    'relay API listening',
  );
  if (config.ENABLE_UI) {
    logger.info(`test console: http://127.0.0.1:${config.PORT}/ui (loopback only)`);
  }

  await waClient.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const timer = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    try {
      // Order matters: stop accepting requests, let queued sends finish, then close
      // the socket and flush credentials. Killing the socket first would abandon
      // in-flight sends with an unknown outcome.
      await app.close();
      await sendQueue.close();
      await waClient.stop();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
