require('express-async-errors');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const path = require('path');

const env = require('./config/env');
const { prisma } = require('./config/database');
const logger = require('./utils/logger');
const { apiLimiter } = require('./middlewares/rateLimit.middleware');
const { notFoundHandler, errorHandler } = require('./middlewares/error.middleware');
const routerV1 = require('./routes');

const app = express();

// The app is expected to run behind exactly one reverse proxy hop in
// production (e.g. Nginx/a load balancer terminating TLS). Without this,
// Express treats the proxy's own socket address as the client IP, which
// breaks `req.ip`-based logic — most importantly the express-rate-limit
// middleware (rateLimit.middleware.js) keying/limiting by the wrong IP,
// and any audit logging (e.g. auth.controller.js requestMeta) recording
// the proxy's address instead of the real client's.
app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  // env.corsOrigins is guaranteed by config/env.js to be a non-empty, explicit
  // list — never "*" — so credentials:true here is always paired with a
  // known set of allowed origins, never a wildcard.
  origin: env.corsOrigins,
  credentials: true,
}));
app.use(compression());
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'));
// helmet()'s default Cross-Origin-Resource-Policy is "same-origin", which
// blocks a frontend hosted on a different domain from embedding images
// served from here (e.g. <img src="https://api.example.com/uploads/...">).
// Relax that policy only for this static-file route — every other route
// keeps helmet's stricter default.
//
// PRODUCTION NOTE (no change made here — see README "Production Deployment"
// section): serving uploaded images through this Node/Express process works
// correctly at any scale, but it spends Node's event loop and process memory
// on plain file I/O that a reverse proxy or object storage does far more
// efficiently. Once infrastructure is available, prefer having Nginx serve
// `/uploads` directly from disk (an `alias`/`location` block, bypassing Node
// entirely) or moving the `uploads/` directory to an object store (S3-
// compatible) and serving from there. This route is intentionally left
// as-is here since that is an infrastructure decision, not an application bug.
app.use(
  '/uploads',
  (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static(path.resolve(process.cwd(), env.upload.dir)),
);

app.use(env.apiPrefix, apiLimiter, routerV1);

// A previous version of this endpoint reported "ok" purely from process
// uptime, so an orchestrator/load-balancer could see a 200 even while the
// database was completely unreachable. This now actually round-trips to
// Postgres via Prisma before answering, and fails closed with 503 (instead
// of a false-positive 200) if that round-trip doesn't succeed.
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ success: true, message: 'ok', uptime: process.uptime(), database: 'connected' });
  } catch (err) {
    logger.error('Health check failed: database unreachable — ' + (err && err.message ? err.message : err));
    res.status(503).json({ success: false, message: 'سرویس در دسترس نیست (اتصال به پایگاه داده برقرار نشد)', uptime: process.uptime(), database: 'disconnected' });
  }
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
