// PM2 process manager configuration.
// This file only controls *how the existing, unmodified* `src/server.js`
// is run/restarted/monitored — it does not change any application code,
// routes, or behavior.
//
// Usage:
//   pm2 start ecosystem.config.js --env production
//   pm2 status / pm2 logs jolfa-market-backend / pm2 restart jolfa-market-backend
//
// All actual runtime configuration (DATABASE_URL, JWT secrets, CORS_ORIGIN,
// ...) still comes from the process's .env file via dotenv, exactly as it
// does today — PM2 does not replace or duplicate that mechanism.
module.exports = {
  apps: [
    {
      name: 'jolfa-market-backend',
      script: 'src/server.js',
      cwd: __dirname,

      // Fork mode with a single instance. NOTE: the app currently keeps
      // rate-limiter counters and Socket.IO connections in-process memory
      // (no Redis-backed store/adapter configured). Raising `instances`
      // above 1 (or switching exec_mode to 'cluster') would silently split
      // that state across processes — rate limits and socket delivery would
      // then be inconsistent per-instance. Increase instances only after a
      // shared store is introduced for both subsystems; that is an
      // application-level change outside the scope of this deployment fix.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '300M',

      watch: false, // deployments are explicit (git pull + pm2 reload), not filesystem-watch-triggered

      // Base env for `pm2 start` with no --env flag (mirrors local dev).
      env: {
        NODE_ENV: 'development',
      },
      // Used with `pm2 start ecosystem.config.js --env production`.
      // Every other required value (DATABASE_URL, JWT_*, CORS_ORIGIN, ...)
      // must still be present in the server's .env file — see
      // .env.example and the README's "Production Deployment" section.
      env_production: {
        NODE_ENV: 'production',
      },

      // PM2-level log files (separate from the app's own Winston output —
      // see src/utils/logger.js). Kept under the git-ignored logs/ dir.
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
