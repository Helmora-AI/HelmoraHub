# Deploy Helmora Hub

Helmora Hub is a **long-running Node.js 20** process (Express). One build artifact (`dist/`) runs everywhere: local, Docker, VPS (DigitalOcean, Oracle, …), and **Pterodactyl**.

Frontend (`Helmora-Frontend`) can sit on Vercel/Pages and call this API. **Do not** run the Express gateway as a Vercel Serverless Function.

## Quick matrix

| Target | How |
|--------|-----|
| Local | `npm run dev` or `npm run build && npm start` |
| Docker | `docker compose up -d --build` |
| VPS (DO / Oracle / …) | Node 20 + systemd unit in `deploy/helmora.service` |
| Pterodactyl | Import `deploy/pterodactyl/egg-helmora.json`, startup `bash scripts/ptero-startup.sh` |
| Storage | Settings UI → **Local** (SQLite) or **SQL** (hybrid: Supabase control + local vault/workspace) |

Default listen: **20800**. Panels often inject `SERVER_PORT` — Helmora Hub maps it automatically.

---

## Hybrid control + workspace storage

Recommended production shape:

| Layer | Where |
|-------|--------|
| Frontend SPA | Cloudflare Pages (or Vercel static) — no secrets |
| Hub API | Long-running Node on **Pterodactyl** / VPS / Docker |
| Control (light) | **Supabase** Postgres — providers, API keys, agents, small settings |
| Vault + workspace (heavy) | **Local SQLite** under `DATA_DIR` on the Hub host |

When you pick **SQL** in Settings, Hub runs **hybrid** mode: Supabase is the control-plane primary; a control **vault** mirror and all heavy workspace data (usage, models catalog growth, Playground chat) stay on local SQLite.

### Outage and recovery

Hybrid boot is local-first for availability:

1. Hub opens and validates the local control snapshot before contacting Supabase.
2. The HTTP server starts, then one serialized background probe checks Supabase.
3. With a complete trusted snapshot, `/v1` keeps serving during a temporary remote outage and control state becomes `degraded`.
4. Without a complete snapshot, Hub enters `recovery_only`: liveness and recovery authentication remain available, but `/ready`, model routes, and ordinary admin routes fail closed.

The transactional local-first mutation outbox and causal replay are a later rollout
phase. Until that phase ships, do not treat offline control-plane edits as durable
or assume they will be replayed automatically. Runtime serving from the last complete
snapshot is independent of that future write path.

Health endpoints are intentionally different:

| Endpoint | Meaning |
|----------|---------|
| `GET /health` | Process and local SQLite are alive. Returns `200` in recovery-only mode too. |
| `GET /ready` | Model/admin serving has a complete control snapshot. Returns `503` in recovery-only mode. |
| `GET /api/storage/health` | Masked control diagnostics for a recovery session. No secrets or raw Supabase errors. |

### Break-glass storage recovery

Set a strong, unique `HELMORA_RECOVERY_TOKEN` in the VPS/Pterodactyl environment
before restart. The environment value is authoritative and is not written to
`runtime-config.json`. If it is not environment-managed, initial admin setup returns
a generated recovery token once; an authenticated admin can rotate it later.

Recovery authentication is separate from admin and `/v1` authentication:

```bash
curl -sS -X POST https://hub.example.com/api/auth/recovery-login \
  -H "Content-Type: application/json" \
  --data '{"token":"YOUR_RECOVERY_TOKEN"}'
```

Use the returned short-lived bearer token only on the storage recovery endpoints:

```text
GET  /api/storage/health
POST /api/storage/test
GET  /api/settings/storage
GET  /api/settings/storage/schema
PUT  /api/settings/storage
```

The recovery session cannot call model routes or ordinary admin routes. Credential
replacement is encrypted in a dedicated local recovery vault, never stored in the
general settings document, and returns `restartRequired: true`. Restart Hub after a
successful repair so the normal storage pipeline is rebuilt cleanly.

### Schema (required before SQL mode)

1. Open **Supabase Dashboard → SQL Editor → New query**.
2. Paste and run the full contents of [`sql/supabase-schema.sql`](../sql/supabase-schema.sql) (source of truth; see also [`sql/migrations/README.md`](../sql/migrations/README.md)).
3. If you still have legacy `ctrlhub_*` table names, run [`sql/rename-ctrlhub-to-helmora.sql`](../sql/rename-ctrlhub-to-helmora.sql) once.
4. Existing installs missing only the Tools tables may instead run the standalone idempotent [`sql/migrations/004_tools_control_plane.sql`](../sql/migrations/004_tools_control_plane.sql). The full schema remains authoritative.
5. In Helmora Settings choose **SQL (Supabase)**, enter URL + service role key + encryption key, **Test connection**, then **Apply**.
6. Persist `DATA_DIR` on the Hub host (Ptero volume / Docker volume) — the trusted snapshot, encrypted recovery vault, and workspace live there.

Admin helper: `GET /api/settings/storage/schema` returns the SQL text for copy/paste.

**Not stored in Supabase (hybrid):** heavy workspace data (usage, model catalog growth, Playground chat) stay on Hub local SQLite. Control-plane settings/providers/agents/keys live on Supabase.

Health fields contain no secrets. Use `/health` for liveness and `/ready` for traffic readiness; authenticated admin status also exposes masked control state.

### Rollback

The Supabase schema and migration `004` are additive and idempotent. A code rollback
does not require dropping their tables; leaving them in place is safer. Before any
storage repair, back up the persistent `DATA_DIR`. If a repaired URL or credential is
wrong, restore the previous environment value or backup of the local runtime/recovery
files, then restart the previous Hub build. Never delete the SQLite snapshot while it
is the only known-good control copy.

### OAuth Connect (Claude / Codex)

Browser OAuth needs two public origins (set in `.env` / panel env):

| Variable | Purpose |
|----------|---------|
| `HELMORA_PUBLIC_URL` | Hub public origin — IdP `redirect_uri` is `{HELMORA_PUBLIC_URL}/api/oauth/callback` |
| `HELMORA_FRONTEND_URL` | SPA origin — post-callback redirect only to `{HELMORA_FRONTEND_URL}/providers?oauth=…` |

Example (Pages SPA + tunnel Hub):

```bash
HELMORA_PUBLIC_URL=https://hub.example.com
HELMORA_FRONTEND_URL=https://app.example.com
ENCRYPTION_KEY=…   # required — OAuth vault AES-GCM
```

Without both URLs, `/api/oauth/*/start` returns 503. Device-code routes are not mounted in this release.

---

## 1. Local

```bash
cd HelmoraHub
cp .env.example .env
npm install
npm run dev
# http://127.0.0.1:20800/settings
```

Production-like:

```bash
npm run build
npm start
```

---

## 2. Docker

```bash
cd HelmoraHub
cp .env.example .env
# optional: ENCRYPTION_KEY, HELMORA_API_KEY, …
docker compose up -d --build
```

- Image binds `0.0.0.0:20800`
- Volume `helmora_data` → `/app/data` (SQLite + `runtime-config.json`)
- Health: `GET /health`

Useful:

```bash
docker compose logs -f helmora
docker compose exec helmora node -e "console.log('ok')"
```

Build only:

```bash
docker build -t helmora:local .
docker run --rm -p 20800:20800 -v helmora_data:/app/data helmora:local
```

---

## 3. VPS (DigitalOcean, Oracle Cloud, Hetzner, …)

### Option A — Docker on the VPS

Same as §2. Open firewall for `20800/tcp` (or put Nginx/Caddy in front with TLS).

### Option B — bare Node + systemd

```bash
# as root
adduser --system --group helmora
mkdir -p /opt/helmora
# copy release files into /opt/helmora (git clone or rsync)
cd /opt/helmora
sudo -u helmora bash scripts/install.sh
sudo -u helmora cp .env.example .env
# edit .env — set ENCRYPTION_KEY, etc.

sudo cp deploy/helmora.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now helmora
sudo systemctl status helmora
```

Reverse proxy example (Caddy):

```caddy
hub.example.com {
  reverse_proxy 127.0.0.1:20800
}
```

Then open Settings at `https://hub.example.com/settings`.

---

## 4. Pterodactyl Panel

Nếu panel cho sửa **Startup Command** và custom **thay toàn bộ** lệnh gốc (mất `git pull` / `npm install`), paste một trong hai:

**Ngắn** (≤512 ký tự — paste vào panel):

```bash
[ -d .git ]||(git clone --depth 1 -b ${GIT_BRANCH:-main} ${GIT_REPO:-https://github.com/Helmora-AI/HelmoraHub.git} /tmp/h&&cp -a /tmp/h/. .&&rm -rf /tmp/h);bash scripts/ptero-startup.sh
```

Dùng `[ -d .git ]` (không phải `-f scripts/ptero-startup.sh`) để lần đầu / sau upload zip vẫn lấy được repo Git. Branch mặc định là **`main`**. Sau đó `ptero-startup.sh` lo `git pull` mỗi lần start.

Sau khi đã có source: `bash scripts/ptero-startup.sh`

Tunnel Cloudflare vẫn do Hub tự chạy sau khi start (env/token) — không có trong shell panel. Chi tiết: [`deploy/pterodactyl/STARTUP.md`](../deploy/pterodactyl/STARTUP.md).

Docker image: `ghcr.io/pterodactyl/yolks:nodejs_20`

### Generic Node egg (MAIN_FILE) — when startup is locked

If startup is locked like:

```bash
… npm install …; node "/home/container/${MAIN_FILE}" ${NODE_ARGS}
```

and you can only edit fields such as MAIN FILE / NODE_PACKAGES / NODE_ARGS:

| Panel field | Set to |
|-------------|--------|
| **MAIN FILE** | `index.js` |
| **ADDITIONAL ARGUMENTS** | *(leave empty)* |
| **ADDITIONAL NODE PACKAGES** | *(leave empty)* |
| **UNINSTALL NODE PACKAGES** | *(leave empty)* |
| GIT USERNAME / TOKEN | only if that egg uses git pull |

`index.js` → `scripts/ptero-start.mjs` → maps `SERVER_PORT` → `PORT`, public bind, starts Hub.

**Tunnel token is not in those fields.** Use one of:

1. File Manager → `/home/container/data/cloudflare-tunnel.token` (one line = connector token) → Hub auto-starts tunnel on boot
2. File Manager → edit `/home/container/.env` with `CLOUDFLARE_TUNNEL_TOKEN=…` (+ optional `CLOUDFLARE_TUNNEL_HOSTNAME`, `ENCRYPTION_KEY`)
3. After boot → `http://IP:PORT/settings` → Cloudflare Tunnel

In Cloudflare Zero Trust, Public Hostname → `http://127.0.0.1:<SERVER_PORT>`.

Do **not** put the token in ADDITIONAL ARGUMENTS (visible in process list).

### Import Helmora egg (if host allows)

1. Admin → Nests → Eggs → **Import Egg**
2. Upload `deploy/pterodactyl/egg-helmora.json`
3. Docker image: `ghcr.io/pterodactyl/yolks:nodejs_20`

Startup: `bash scripts/ptero-startup.sh` (Linux custom command; fallback `node scripts/ptero-start.mjs` or MAIN FILE = `index.js`).

### Create server

1. Upload Helmora Hub source (zip / SFTP)
2. Reinstall / install script (`npm install` + `npm run build`), or run that in console once
3. MAIN FILE = `index.js`

### What `ptero-start.mjs` / `index.js` does

- Maps `SERVER_PORT` / `P_SERVER_PORT` → `PORT`
- Sets `HELMORA_PUBLIC=1` (bind `0.0.0.0`)
- Creates `data/`
- Starts `dist/index.js` (tunnel auto-starts if token present)

### Panel variables (Helmora egg)

| Variable | Purpose |
|----------|---------|
| `PORT` | Listen port (allocation often also sets `SERVER_PORT`) |
| `ENCRYPTION_KEY` | Encrypt provider secrets + tunnel token |
| `HELMORA_API_KEY` | `/v1` bearer (optional auto-gen; legacy `CTRLHUB_API_KEY` accepted) |
| `DATA_DIR` | Default `/home/container/data` |
| `HELMORA_PUBLIC` | `1` = bind all interfaces |
| `CLOUDFLARE_TUNNEL_TOKEN` | Named tunnel connector token |

### After start

- Allocation URL → `http://<node-ip>:<port>/settings`
- Choose **Local** (SQLite) or **SQL (Supabase)**
- **Before SQL:** paste/run `sql/supabase-schema.sql` in Supabase SQL Editor, then Test Connection (existing `ctrlhub_*` tables: run `sql/rename-ctrlhub-to-helmora.sql`)

---

## 5. Environment reference

| Env | Default | Notes |
|-----|---------|--------|
| `PORT` | `20800` | Also reads `SERVER_PORT`, `P_SERVER_PORT` |
| `HOST` | `127.0.0.1` local / `0.0.0.0` production | Or force with `HELMORA_PUBLIC=1` |
| `DATA_DIR` | `./data` | Persist this path |
| `NODE_ENV` | — | `production` ⇒ bind `0.0.0.0` |
| `ENCRYPTION_KEY` | — | Recommended always; required for SQL |
| `HELMORA_API_KEY` | auto | Unified `/v1` key (`CTRLHUB_API_KEY` legacy fallback) |
| `HELMORA_RECOVERY_TOKEN` | — | Recommended break-glass credential for Hybrid storage repair; keep separate from admin and `/v1` keys |
| `RATE_BACKEND` | `memory` | `redis` + `REDIS_URL` on multi-instance |
| `SUPABASE_*` | — | Optional; Settings UI can set SQL mode |

Storage preference lives in **Settings** → `data/runtime-config.json` (not only env).

---

## 6. Production checklist

- [ ] Persist `DATA_DIR` (volume / disk)
- [ ] Set `ENCRYPTION_KEY`
- [ ] Open `/settings` once → **create admin password** (copy admin token shown once)
- [ ] Confirm Local vs SQL storage
- [ ] If SQL: schema applied; service role key only on server
- [ ] If SQL: set and securely store `HELMORA_RECOVERY_TOKEN`; persist and back up `DATA_DIR`
- [ ] Require `/ready` = `200` before routing model traffic (`/health` alone is liveness)
- [ ] Optional: Cloudflare Tunnel token in Settings (Public Hostname → `http://127.0.0.1:PORT`)
- [ ] Firewall / TLS reverse proxy (or rely on Cloudflare Tunnel and keep Hub on localhost)
- [ ] External admin scripts: `Authorization: Bearer <admin-token>` or `X-Admin-Token` (not the `/v1` API key)

---

## 6b. Cloudflare Tunnel (token)

Named tunnels are preferred over Quick Tunnels: stable hostname, Cloudflare Access policies, no random `trycloudflare.com` URL.

1. Cloudflare Zero Trust → **Networks → Tunnels** → Create → copy **connector token**.
2. Add a **Public Hostname** pointing to `http://127.0.0.1:20800` (or your `PORT`).
3. In Helmora Hub **Settings → Cloudflare Tunnel**: paste token, set hostname for display, enable **Auto-start**, click **Start**.
4. Or via env: `CLOUDFLARE_TUNNEL_TOKEN=…` and `CLOUDFLARE_TUNNEL_AUTO_START=1`.

Hub downloads `cloudflared` into `data/bin/` on first start if it is not on `PATH`. Token is AES-GCM encrypted in `runtime-config.json` when `ENCRYPTION_KEY` is set.

API: `GET|PUT /api/settings/tunnel`, `POST /api/settings/tunnel/start|stop`.

### Rollout order for Hub + Admin SPA

Deploy/restart the Hub first. Wait until `GET /health` and `GET /api/auth/status`
return `200`, and require `GET /ready` to return `200` repeatedly through the public
hostname before routing model traffic or deploying the Admin SPA. A single
Pterodactyl instance can briefly return Cloudflare `502` while Node and `cloudflared`
restart; the tunnel manager retries failed startup/reconnect attempts with bounded
exponential backoff.

Also verify an `OPTIONS` request from the SPA origin returns `204` with
`Access-Control-Allow-Origin` and `Access-Control-Allow-Headers`. Hub caches successful
preflight decisions for 10 minutes. A Cloudflare-generated `502` has no Hub CORS headers,
so browsers may describe an unavailable tunnel as a CORS error even though Express CORS
configuration is correct.

---

## 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Panel health never “done” | Ensure startup done string matches log: `Helmora AI listening on` |
| Connection refused from outside | `HELMORA_PUBLIC=1` or `HOST=0.0.0.0`; check allocation port — or use Cloudflare Tunnel and leave Hub on `127.0.0.1` |
| Tunnel won’t start | Check token; Public Hostname must target `http://127.0.0.1:PORT`; see Hub logs for `cloudflared` |
| Browser reports missing `Access-Control-Allow-Origin`, response is Cloudflare `502` | This is tunnel/origin unavailability, not an Express preflight rejection. Check Pterodactyl state, `cloudflared` reconnect logs, public-hostname target/port, and duplicate stale connectors. |
| `better-sqlite3` build fail | Need Node 20 + build tools (`python3 make g++`) on install image |
| Settings 404 | Run `npm run build` (copies `public/` into `dist/public`) |
| Lost data after reinstall | Persist `/home/container/data` (Ptero) or Docker volume |
