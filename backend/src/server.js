const http = require('http');
const app = require('./app');
const env = require('./config/env');
const logger = require('./utils/logger');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { initRealtime } = require('./realtime/socket');

let server;

async function bootstrap() {
  await connectDatabase();
  server = http.createServer(app);
  initRealtime(server);
  server.listen(env.port, () => {
    logger.info(`Jolfa Market API (+ WebSocket) listening on port ${env.port} [${env.nodeEnv}]`);
  });
}

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully...`);
  if (server) server.close();
  await disconnectDatabase();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection: ' + reason);
});

bootstrap().catch((err) => {
  logger.error('Fatal error during startup: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
