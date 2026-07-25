import createApp from './app.js';
import env from './config/env.js';
import { closeDatabase, connectDatabase } from './db/client.js';
import { ensureIndexes } from './db/indexes.js';

async function main() {
  await connectDatabase();
  const indexCount = await ensureIndexes();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.info(`Kaistrum Academy API on http://localhost:${env.PORT}/api/v1`);
    console.info(`  db=${env.MONGODB_DB}  env=${env.NODE_ENV}  indexes=${indexCount}`);
    if (!env.paystackEnabled) console.warn('  Paystack is not configured — checkout is disabled');
    if (!env.mailEnabled) console.warn('  SMTP is not configured — emails print to the console');
  });

  const shutdown = async (signal) => {
    console.info(`\n${signal} received — shutting down`);
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
    // Don't hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
