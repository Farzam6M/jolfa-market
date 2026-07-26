# Jolfa Market — Backend API

A modular, secure, layered REST API for the "جلفا مارکت" e-commerce marketplace.
Built with **Node.js + Express + PostgreSQL (Prisma ORM)**.

> The existing frontend (`index.html`, `chat-service.js`, `style.css`) is **untouched**.
> Today it runs entirely on `localStorage`. This backend is designed so that connecting
> the frontend later is a matter of swapping `localStorage.getItem/setItem` calls for
> `fetch()` calls to the endpoints below — see **"Frontend integration map"**.

---

## 1. Architecture

```
src/
  config/         env.js, database.js (single shared Prisma client)
  middlewares/    auth, rbac, validate, error, upload, rate-limit
  utils/          ApiError, ApiResponse, asyncHandler, tokens, password hashing
  modules/        one folder per domain — Controller → Service → Prisma
    auth/ users/ roles/ categories/ stores/ sellers/
    products/ cart/ wishlist/ reviews/
    orders/ payments/ support-chat/ notifications/ hero/ admin/
  routes/         index.js — mounts every module under /api/v1
  app.js          Express app (security middleware, routes, error handler)
  server.js       process entrypoint (connect DB, listen, graceful shutdown)
prisma/
  schema.prisma   full data model
  seed.js         roles, super-admin account, base categories
```

**Layering rule, enforced throughout:** `routes → controller → service → Prisma`.
Controllers only translate HTTP ⇄ service calls (no business logic). Services own
all business rules, transactions, and side effects (notifications, audit log).
Validation (Zod) and authorization (JWT + RBAC) run as middleware *before* the
controller, so a controller body never has to re-check "is this data valid" or
"is this user allowed".

### Why this structure scales
- **New module = new folder.** Nothing elsewhere needs to change.
- **New permission = one line in `modules/roles/permissions.constants.js`.**
  Roles are just named bundles of permission keys; a route declares the
  permission it needs, never a hardcoded role name (except a couple of
  genuinely role-specific admin actions).
- **Repository logic lives in services**, one Prisma client shared via
  `config/database.js` — easy to introduce a dedicated repository layer later
  without touching controllers.

---

## 2. Security

- Passwords hashed with **bcrypt** (12 salt rounds) — never stored or logged in plaintext.
- **JWT access tokens** (short-lived, 15m) + **refresh tokens** (30d, rotated and
  revocable, stored *hashed* in the DB so a DB leak can't be replayed).
- **RBAC**: every protected route requires a specific permission
  (`requirePermission`) and/or ownership (`requireOwnerOr`) — e.g. a seller can only
  edit *their own* products; an admin bypass is an explicit, auditable permission.
- `helmet`, `cors` (whitelist via `CORS_ORIGIN`), `express-rate-limit`
  (tighter limits on `/auth/login` and `/auth/register`), input validation with `zod`
  on every mutating endpoint.
- Centralized error handler never leaks stack traces or raw DB errors to clients.

---

## 3. Data model highlights (see `prisma/schema.prisma`)

- `User` → `Role` → `RolePermission` → `Permission` (roles/permissions are DB-driven,
  not hardcoded — an admin can grow the permission set without a redeploy).
- `Store` (1 seller : 1 store) with `status` (PENDING/APPROVED/REJECTED/SUSPENDED),
  fed by `SellerApplication` (customer → seller upgrade flow, mirrors the frontend's
  seller-registration form).
- `Product` → `ProductImage[]`, `WholesaleTier[]`, `Category` (self-referencing tree).
  Editing an approved product resets it to `PENDING` (must be re-approved) — same
  rule the frontend's admin queue expects. `status` (moderation: PENDING/APPROVED/
  REJECTED/ARCHIVED) is intentionally separate from `isActive` (seller-controlled
  visibility toggle, e.g. pausing a product): flipping `isActive` never touches
  `status`, and vice versa. `compareAtPrice` is the pre-discount "was" price used
  to show a discount alongside `price`.
- `Cart`/`CartItem`, `WishlistItem` — one row per user, unique per (cart, product).
- `Review` — one per (product, user), gated on a verified purchase (`OrderItem` lookup).
- `Order` → `OrderItem[]` (name/price **snapshotted** at purchase time) → `Payment[]`.
- `Wallet` / `WalletTransaction` — internal balance + ledger, used by wallet payments.
- `SupportConversation` (1 per user) / `StoreConversation` (1 per store+customer pair)
  — this is a direct, intentional mirror of the rules already documented and enforced
  in the frontend's own `chat-service.js`.
- `Notification` with `scope` (ALL/ROLE/USER) + `NotificationDismissal` — same
  per-role/per-account targeting model as the frontend's `pushNotification()`.
- `AdminActivityLog` — append-only audit trail, powers the admin "آخرین فعالیت‌ها" feed.

---

## 4. Getting started

```bash
cp .env.example .env        # fill in a real DATABASE_URL and strong JWT secrets
npm install
npm run prisma:migrate      # creates the database schema
npm run seed                # roles + super-admin (SEED_SUPERADMIN_MOBILE, else '09999999999'; SEED_SUPERADMIN_PASSWORD, else 'ChangeMe@1404') + base categories
npm run dev                 # http://localhost:4000/api/v1
```

Health check: `GET /health` — now also verifies a real database round-trip
(`SELECT 1` via Prisma) and returns `503` if Postgres isn't reachable, instead
of only reporting process uptime.

---

## 5. Production Deployment

This section is deliberately short — it's a checklist, not a tutorial for any
one hosting provider. Nothing here changes the app; it only documents how to
run the existing, unmodified code correctly outside of local development.

### 5.1 Install & build steps

```bash
git pull                        # or however the server gets the latest code
npm install                     # runs `postinstall` → `prisma generate` automatically
npm run prisma:deploy           # applies committed migrations (prisma migrate deploy) — safe for prod, never `migrate dev` here
npm start                       # or, preferably, run it under PM2 — see 5.2
```

`npm install`'s `postinstall` hook already runs `prisma generate` for you, so
the Prisma Client is always regenerated to match `prisma/schema.prisma` after
every install — this used to be an easy-to-forget manual step.

### 5.2 Process management (PM2)

An `ecosystem.config.js` is included at the project root:

```bash
npm install -g pm2              # once, on the server
pm2 start ecosystem.config.js --env production
pm2 save                        # persist the process list across reboots
pm2 startup                     # (follow the printed instructions once, per server)

pm2 status                      # check it's running
pm2 logs jolfa-market-backend   # tail logs
pm2 restart jolfa-market-backend
```

PM2 gives the process `autorestart` on crash, a `max_memory_restart` ceiling,
and structured start/stop control — see the comments inside
`ecosystem.config.js` for the reasoning behind `instances: 1` (raising it
requires a shared store for the rate limiter and Socket.IO first — an
application change, intentionally out of scope here).

### 5.3 Health check

Point your process manager / load balancer / uptime monitor at:

```
GET /health
```

- `200 { success: true, database: "connected", uptime }` — healthy.
- `503 { success: false, database: "disconnected", uptime }` — Postgres is
  unreachable; treat the instance as unhealthy (e.g. don't route traffic to
  it, or let PM2/your orchestrator restart it).

### 5.4 Environment variables

```bash
cp .env.example .env
```

Then fill in every value for the target environment, with special attention
to (see the warning banner at the top of `.env.example` for detail):

- `DATABASE_URL` — the production Postgres connection string.
- `CORS_ORIGIN` — the real frontend origin(s), comma-separated. There is
  **no wildcard fallback**: the app refuses to start if this is missing or
  set to `*` (see `src/config/env.js`).
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `GATEWAY_CALLBACK_SECRET` — **must**
  be replaced with your own strong, random values before production; the
  values shipped in `.env.example` are placeholders visible to anyone who has
  read this repository, so reusing them would let an attacker forge tokens.
  Generate one with, e.g.:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `NODE_ENV=production` — enables Winston's rotating file logs (see §7) and
  suppresses stack traces in error responses.

### 5.5 SSL / HTTPS

This app does not terminate TLS itself — that's expected, and is handled one
layer up:

- Terminate SSL at Nginx (or your load balancer/CDN) in front of this Node
  process, which continues listening on plain HTTP on `PORT` (default
  `4000`) on localhost/an internal network only.
- A free, auto-renewing certificate via [Let's Encrypt](https://letsencrypt.org/)
  + [Certbot](https://certbot.eff.org/) is the standard choice for a single
  domain.
- Redirect all `http://` traffic to `https://` at the Nginx layer.

### 5.6 Nginx (reverse proxy)

Run Nginx in front of this app rather than exposing Node directly to the
internet. A minimal example (adjust domain/paths/upstream port):

```nginx
server {
    listen 443 ssl http2;
    server_name api.jolfa-market.example;

    ssl_certificate     /etc/letsencrypt/live/api.jolfa-market.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.jolfa-market.example/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:4000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

The app already calls `app.set('trust proxy', 1)` (see `src/app.js`), so with
exactly one proxy hop like the above, `req.ip` and the rate limiter both see
the real client IP from `X-Forwarded-For` rather than Nginx's own address.

### 5.7 Backup & Monitoring

See §6 (Backup Strategy) and §7 (Monitoring) below.

---

## 6. Backup Strategy

Documentation only — no backup script is included in this repo; back up the
Postgres database using your own infrastructure/cron, not application code.

- **What to back up:** the Postgres database only (`DATABASE_URL`'s target).
  Uploaded files under `uploads/` are user content too and should be backed
  up separately (see §5.6/§8 note on moving them to object storage, which
  typically comes with its own durability/versioning).
- **Tool:** [`pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html),
  e.g.:
  ```bash
  pg_dump --format=custom --file="jolfa_market_$(date +%F).dump" "$DATABASE_URL"
  ```
- **Schedule:** daily, at minimum (a nightly cron job or your hosting
  provider's managed-Postgres backup feature, if available). Increase
  frequency once real transaction volume (orders/payments) makes a full
  day of potential data loss unacceptable.
- **Retention:** keep at least 7 daily dumps and 4 weekly dumps, e.g. by
  rotating filenames by day-of-week/week-of-month, or by using your storage
  provider's lifecycle rules if dumps are shipped to object storage.
- **Off-host storage:** ship dumps off the database server itself (S3-
  compatible storage, a separate backup host, etc.) — a backup that lives
  only on the same disk as the database doesn't protect against that host's
  own failure.
- **Restore:**
  ```bash
  pg_restore --clean --if-exists --dbname="$DATABASE_URL" jolfa_market_2026-07-24.dump
  ```
  Test this restore path periodically against a disposable database (never
  production) — an untested backup is not a verified backup.

---

## 7. Monitoring

Documentation only — nothing below is wired into the code; pick what fits
your infrastructure and configure it externally.

- **PM2 (process-level, included today):** `pm2 status`, `pm2 monit`, and
  `pm2 logs jolfa-market-backend` cover process uptime, restarts, and memory
  right after following §5.2 — no extra setup needed.
- **Winston (application logs, included today):** in `NODE_ENV=production`,
  `src/utils/logger.js` writes rotating daily files to `logs/` (`app-*.log`
  for info+, `error-*.log` for errors only), in addition to console output.
  Ship that `logs/` directory to your log aggregator of choice (e.g. a
  hosted log service, or `journald`/`syslog` if PM2 is run under systemd).
- **Sentry (optional, error tracking):** for real-time exception alerting
  and stack-trace grouping beyond log files, `@sentry/node` can be added and
  initialized in `src/server.js` — evaluate this as a follow-up; it is not
  installed today.
- **Prometheus (optional, metrics):** for request-rate/latency/error-rate
  dashboards and alerting, a metrics endpoint (e.g. via `prom-client`) can be
  added later. Also not installed today — call out explicitly if this
  becomes a requirement, since it needs a small, deliberate code addition
  (a `/metrics` route) rather than being purely a documentation change.

---

## 8. API surface (all under `API_PREFIX`, default `/api/v1`)

| Module | Base path | Notes |
|---|---|---|
| Auth | `/auth` | register, login, refresh, logout, me, change-password |
| Users | `/users` | self profile + admin user management/ban |
| Categories | `/categories` | public read, admin manage |
| Stores | `/stores` | public list/detail, seller self-manage (`/stores/me`), admin full edit (`PATCH /stores/:id`) + moderate status (`PATCH /stores/:id/moderate`) |
| Sellers | `/sellers` | seller application + admin review (approve → creates Store + upgrades role) — this **is** "create store" for a seller |
| Products | `/products` | public list/detail/search/filter, seller CRUD (own only, incl. `PATCH /:id/stock` inventory and `PATCH /:id/active` visibility toggle), admin full access + moderate |
| Cart | `/cart` | self-scoped |
| Wishlist | `/wishlist` | self-scoped |
| Reviews | `/reviews` | verified-purchase gated, admin moderate |
| Orders | `/orders` | checkout from cart, self/store/admin views |
| Payments | `/payments` | wallet / gateway / COD, wallet balance + ledger |
| Chat | `/chat` | `/chat/support/*`, `/chat/store/:storeId`, staff & seller inboxes |
| Notifications | `/notifications` | per-role/per-user targeted feed |
| Hero slider | `/hero` | public: active + in-schedule slides only, ordered by display order. Admin (`hero:manage`): unlimited slides — create/edit/delete/toggle/reorder, desktop+mobile image upload or URL, buttons, schedule window (`startAt`/`endAt`) |
| Admin | `/admin` | dashboard stats, activity log, create admin accounts (super_admin only), delete a seller (`DELETE /admin/sellers/:sellerId` — admin with `sellers:delete` or super_admin) |

Every response is a consistent envelope: `{ success, message, data }` on success,
`{ success: false, message, details }` on error.

---

## 9. Frontend integration map (for when you're ready to connect it)

The current frontend never touches a network — everything lives in these
`localStorage` keys. Each maps cleanly onto an endpoint above:

| localStorage key | Replace with |
|---|---|
| `jm_users_db`, `jm_session_user_id` | `POST /auth/register`, `/auth/login`, `/auth/me` |
| `jm_seller_app`, `jm_seller_profile`, `jm_seller_settings` | `/sellers/apply`, `/stores/me` |
| `jm_extra_shops` | `/stores` |
| `jm_product_requests` | `/products` (status PENDING) + `/products/:id/moderate` |
| `jm_cart` | `/cart` |
| `jm_product_comments` | `/reviews` |
| `jm_wallet` | `/payments/wallet` |
| `jm_site_notifications`, `jm_notif_dismissed` | `/notifications` |
| `jm_admin_activity_log` | `/admin/activity-log` |
| `jm_site_settings` | new `/admin/settings` endpoint (add when needed — schema is ready to extend) |
| `chat-service.js` (`ChatService.*`) | `/chat/support/*`, `/chat/store/:storeId` — same one-conversation-per-user / one-per-store-per-customer rules, already implemented server-side |

`chat-service.js` was already written with a `StorageAdapter` abstraction anticipating
exactly this swap (its own comments say so) — only that one file's adapter needs to
call `fetch()` instead of `localStorage`; `ChatRepository`/`ChatService` and every page
that calls them stay the same.

---

## 10. Seller deletion (admin panel)

`DELETE /admin/sellers/:sellerId` lets an admin (holding the `sellers:delete`
permission) or a super_admin (wildcard `*`) remove a seller from the admin panel.

**Access:** `authenticate` + `requirePermission(PERMISSIONS.SELLERS_DELETE)` —
returns `403` for any role that doesn't hold it (customers, sellers, and admins
without the permission), `401` if unauthenticated.

**Request:** `DELETE /api/v1/admin/sellers/:sellerId` (`sellerId` must be a UUID).

**Responses:**
| Status | Meaning |
|---|---|
| 200 | Seller deleted. Body: `{ success, message, data: { id, name, status, deletedAt, storeId, archivedProducts } }` |
| 400 | Invalid deletion request — target is not a `SELLER` (e.g. a customer), or you tried to delete your own account |
| 403 | No permission, or the target is the `SUPER_ADMIN` |
| 404 | Seller not found |
| 409 | Seller was already deleted (idempotency guard) |
| 500 | Internal error |

**What actually happens (never a raw SQL `DELETE` on the seller's data):**
A seller's `Store`/`Product` rows can already be referenced by `OrderItem`
rows, and `OrderItem -> Product` has no cascading foreign key — hard-deleting
would either throw a raw FK-constraint violation or, if forced, destroy
customers' order history (`products.service.js`'s own `remove()` already
refuses to hard-delete a single product with order history for the same
reason). So this endpoint performs a controlled, transactional **soft
delete** instead, inside one `prisma.$transaction`:

1. Validates the target exists, is role `SELLER` (not any other role), isn't
   the acting admin themself, and isn't already deleted.
2. Every product under the seller's store is set to `status: ARCHIVED`,
   `isActive: false` — hidden from `GET /products` (existing default filters),
   row and all history (`OrderItem`, `Review`, etc.) kept intact.
3. The store is set to `status: SUSPENDED` — hidden from `GET /stores`
   (existing default filter), same as the existing store-moderation feature.
4. Every refresh token for the account is revoked (ends active sessions).
5. The `User` row is set to `status: BANNED` (already rejected by
   `authenticate()` — no auth-module changes needed) and stamped with
   `deletedAt` / `deletedById` for audit + idempotency.
6. An `AdminActivityLog` row is created — actor = admin id, action text
   includes the seller's name, `meta: { code: 'DELETE_SELLER', targetUserId,
   storeId, archivedProducts }`, `createdAt` automatic — visible via the
   existing `GET /admin/activity-log`.

Left completely untouched: `Order`, `OrderItem`, `Payment`, `Review`,
`StoreConversation`/`StoreMessage`, `SupportConversation`/`SupportMessage`,
`Notification*`, `Wallet`/`WalletTransaction`, `Cart`/`WishlistItem`.

**Database impact:** one additive migration
(`20260724090000_seller_soft_delete`) adds two nullable columns to `users`:
`deletedAt TIMESTAMP(3)` and `deletedById TEXT` (plain string, no FK — same
convention as `reviewedById` on `Product`/`SellerApplication`). No existing
column, table, or migration is changed; nothing else needs re-migrating.

**Tests:** `tests/admin-sellers-deletion.test.js` covers: admin deletes a
seller, super_admin deletes a seller, a customer/seller gets 403, deleting a
seller that has products (archived, not destroyed), deleting a seller with
existing orders/payments (untouched, no FK error), deleting a seller with an
open store conversation (chat history preserved), deleting an already-deleted
seller (409), a non-existent seller (404), a non-seller target (400), the
super_admin (403), and self-deletion (400).

**Potential risks / follow-ups:**
- This is a soft delete by design — no endpoint currently "undoes" it (no
  `PATCH /admin/sellers/:id/restore`). Add one if reinstating a seller becomes
  a real requirement; the `deletedAt`/`status` fields already make that cheap.
- A seller's `SellerApplication` row (their original application) is left as-is
  (still shows `APPROVED`); harmless, but worth knowing if you ever report off it.
- `GET /users` (admin user list) will now show soft-deleted sellers with
  `status: BANNED`, same as any other manually banned user — deliberate,
  since `users.service.js` wasn't touched, but flagging in case a future
  admin-UI wants to distinguish "banned" from "deleted".

## 11. Testing (Store + Product access control)

`tests/stores-products.access.test.js` is an integration suite (Jest + Supertest)
that exercises the exact rules requested for the store/product system:

- a seller can create a store (via `/sellers/apply` → admin approval), edit their
  own store, and add/edit/delete their own products, incl. dedicated inventory
  (`/stock`) and active/inactive (`/active`) management;
- a seller can **not** read another seller's not-yet-approved product, and can
  **not** edit/delete/restock another seller's product (403 in every case);
- **admin has full access**: can edit any store, and edit/delete/moderate any
  product, regardless of who owns it;
- customers can list, search (`?q=`), filter (`?categoryId=`, `?minPrice=`,
  `?maxPrice=`), and view product details, but only ever see `APPROVED` +
  active products — pending/inactive products 404 for them.

Run it against a disposable Postgres database (never your dev DB — the suite
creates real rows):

```bash
npm install
createdb jolfa_market_test   # or point DATABASE_URL at any empty Postgres db
DATABASE_URL="postgresql://user:pass@localhost:5432/jolfa_market_test?schema=public" \
  npx prisma migrate dev --name init
DATABASE_URL="postgresql://user:pass@localhost:5432/jolfa_market_test?schema=public" \
  npm run seed        # seeds the 4 roles the tests require
DATABASE_URL="postgresql://user:pass@localhost:5432/jolfa_market_test?schema=public" \
  JWT_ACCESS_SECRET=test JWT_REFRESH_SECRET=test \
  npm test
```

(These tests weren't run in this environment because it has no network access
and no Postgres instance available — run them locally or in CI with the steps
above.)

## 12. Review notes / known follow-ups

- The current frontend's product catalog is hardcoded directly into `index.html` as
  static DOM cards, not fetched from anywhere — `GET /products` is ready to serve it,
  but wiring the product grid to render from the API is frontend work intentionally
  left untouched per the brief.
- `Payments.GATEWAY` is stubbed as PENDING pending a real gateway integration
  (`confirmGateway()` in `payments.service.js` is the webhook entrypoint to wire up).
- Image uploads go through `middlewares/upload.middleware.js` (disk storage today,
  swappable for S3/object storage later without touching any controller).
- Seller deletion (`DELETE /admin/sellers/:sellerId`, section 10) is a soft
  delete on purpose — see that section's "Potential risks" for the restore
  endpoint and admin-user-list follow-ups.
