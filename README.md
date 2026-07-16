<p align="center">
  <img src="public/logo/helmoraai-readme.svg" alt="Helmora AI" width="560" />
</p>

<h1 align="center">Helmora Hub</h1>

<p align="center">
  Layered AI gateway for the <strong>Helmora</strong> ecosystem — providers, modes, hybrid storage, and OpenAI-compatible routing.
</p>

<p align="center">
  <a href="https://github.com/Helmora-AI/HelmoraHub"><img src="https://img.shields.io/badge/GitHub-HelmoraHub-111827?style=flat&logo=github" alt="GitHub" /></a>
  <a href="https://github.com/Helmora-AI/HelmoraHub-Frontend"><img src="https://img.shields.io/badge/UI-HelmoraHub--Frontend-0ea5e9?style=flat&logo=react" alt="Frontend" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/tests-Vitest-6E9F18?style=flat&logo=vitest&logoColor=white" alt="Vitest" />
  <img src="https://img.shields.io/badge/deploy-Docker%20%7C%20VPS%20%7C%20Pterodactyl-F97316?style=flat" alt="Deploy" />
  <img src="https://img.shields.io/badge/version-0.1.16-6366f1?style=flat" alt="Version" />
</p>

<p align="center">
  <a href="https://github.com/Helmora-AI/HelmoraHub">Repository</a>
  ·
  <a href="https://github.com/Helmora-AI/HelmoraHub-Frontend">Admin UI</a>
  ·
  <a href="docs/deploy.md">Deploy guide</a>
</p>

---

## Repos

| Package | Role | Link |
|---------|------|------|
| **HelmoraHub** | API gateway (this repo) | [github.com/Helmora-AI/HelmoraHub](https://github.com/Helmora-AI/HelmoraHub) |
| **HelmoraHub-Frontend** | Admin SPA (Vite → Cloudflare Pages) | [github.com/Helmora-AI/HelmoraHub-Frontend](https://github.com/Helmora-AI/HelmoraHub-Frontend) |

## What it does

| Surface | Endpoints |
|---------|-----------|
| **Runtime** | `GET /health`, `GET /state`, `GET /registry` |
| **OpenAI-compatible** | `POST /v1/chat/completions` (JSON + SSE), `GET /v1/models` |
| **Admin** | `/api/status`, providers, modes, agents, OAuth Connect |
| **Settings** | Local SQLite or hybrid SQL (Supabase control + local vault) |

- Default port: **20800**
- Modes: `manual`, `smart`, `coding`, `economy`, `premium`, `fusion`
- Tiers: **1** subscription · **2** paid · **3** free pool
- Free-pool ready providers include Ollama Cloud, Groq, OpenRouter, ModelScope, LLM7, Kira AI, BigModel.cn, Cerebras, Mistral, AI/ML API, NVIDIA NIM, Gemini (AI Studio), Cloudflare Workers AI
- OAuth PKCE Connect for **Claude** and **Codex** (device flows later)

## Hybrid storage

| Layer | Where |
|-------|--------|
| Control (providers, keys, agents, settings) | Local SQLite **or** Supabase (hybrid primary) |
| Trusted control snapshot + workspace | Local disk under `DATA_DIR` |
| Secrets at rest | AES-GCM (`ENCRYPTION_KEY`) |
| Rate / cooldown / sticky | Memory or Redis |

Hybrid startup opens the local SQLite snapshot first and probes Supabase only after
the HTTP server is live. A complete snapshot keeps model routes available during a
temporary control-plane outage. Without one, Hub stays live in a restricted
recovery-only mode: `GET /health` remains `200`, `GET /ready` returns `503`, and
model/admin serving is blocked until storage is repaired.

Set `HELMORA_RECOVERY_TOKEN` on Hybrid deployments, apply the idempotent Supabase
schema, and persist `DATA_DIR`. The token can create a short-lived, storage-only
recovery session; it is never accepted as an admin or `/v1` credential. Full setup,
migration, and rollback notes: [`docs/deploy.md`](docs/deploy.md).

## Quick start

```bash
git clone https://github.com/Helmora-AI/HelmoraHub.git
cd HelmoraHub
cp .env.example .env
# Put this generated value in .env as HELMORA_SETUP_TOKEN before first boot:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npm install
npm run dev
```

Smoke:

```bash
curl http://127.0.0.1:20800/health
curl http://127.0.0.1:20800/ready
curl http://127.0.0.1:20800/api/status
```

Pair with the UI:

```bash
git clone https://github.com/Helmora-AI/HelmoraHub-Frontend.git
cd HelmoraHub-Frontend
npm install
npm run dev
```

## Secure first-run contract

- Every unconfigured Hub requires `HELMORA_SETUP_TOKEN`, including localhost.
  Missing or weak configuration keeps `/health` live, makes `/ready` return
  `503`, and makes setup unavailable until configuration is repaired.
- Setup attempts are limited for 15 minutes to 10 per socket source and 100 per
  Hub process. `Retry-After` reports the applicable reset. The limiter is
  intentionally process-local; the strong token and SQLite compare-and-set are
  the authorization and correctness boundaries.
- Configure exact browser origins with `HELMORA_PUBLIC_URL`,
  `HELMORA_FRONTEND_URL`, and optional comma-separated
  `HELMORA_CORS_ORIGINS`. Wildcards and trust inferred from proxy/request
  headers are rejected. Server clients without `Origin` remain supported.
- Setup shows each locally generated admin/recovery token once. An
  environment-managed token is identified without echoing or generating a
  shadowed local value. Save generated credentials before acknowledging.
- If setup commits but the response is lost, sign in using the chosen password,
  then rotate the locally managed admin/recovery tokens. Setup is not replayed.
- Environment credentials shadow the corresponding local credential for the
  current process without deleting it. After removing an environment value and
  restarting, the prior local credential returns; rotate it first if its origin
  is uncertain.
- The auth-store migration removes legacy auth hashes/raw session material from
  runtime config and invalidates old signed cookies once. An interrupted cleanup
  fails auth/readiness closed and resumes on restart rather than reading two
  stores.
- Auth JSON is limited to 16 KiB and normal control JSON to 256 KiB; both reject
  non-identity `Content-Encoding` with `415`. Chat/vision retains a 10 MiB limit
  measured after decompression.

For an existing Supabase deployment, apply migrations in order through
`sql/migrations/005_atomic_chat_messages.sql`. Run its duplicate preflight and
resolve duplicates from a backup; Hub never applies production migrations.

## Deploy

| Target | How |
|--------|-----|
| Local | `npm run build && npm start` |
| Docker | `npm run docker:up` |
| VPS systemd | [`deploy/helmora.service`](deploy/helmora.service) |
| Pterodactyl | Import egg · startup `bash scripts/ptero-startup.sh` |

Guide: **[docs/deploy.md](docs/deploy.md)**

For OAuth Connect set:

```bash
HELMORA_PUBLIC_URL=https://hub.example.com
HELMORA_FRONTEND_URL=https://app.example.com
ENCRYPTION_KEY=…
```

### Hub + Frontend rollout

Deploy the Hub before the Frontend so Pages never points at an origin that is
still restarting:

1. Push/deploy Hub and restart its Pterodactyl service.
2. Wait for the `Cloudflare connector registered` log entry.
3. Confirm `GET /health` returns `200`, then require `GET /ready` to return `200`
   before sending model traffic. `GET /health` alone also succeeds in recovery-only
   mode and is therefore not a serving-readiness check.
4. Confirm a browser-origin preflight returns `204` with
   `Access-Control-Allow-Origin` before deploying Cloudflare Pages.

A Cloudflare-generated `502` does not pass through Helmora Hub, so it cannot
contain the Hub's CORS headers and browsers may report it as a CORS failure.
Treat that combination as a tunnel/origin outage. Hub retries `cloudflared`
with bounded backoff; see [docs/deploy.md](docs/deploy.md) for diagnosis and
recovery steps.

## Branding

| File | Use |
|------|-----|
| [`public/logo/helmoraai-readme.svg`](public/logo/helmoraai-readme.svg) | README / GitHub hero |
| [`public/logo/helmora_full_black.svg`](public/logo/helmora_full_black.svg) | Full lockup (light) |
| [`public/logo/helmora_full_white.svg`](public/logo/helmora_full_white.svg) | Full lockup (dark) |
| [`public/logo/helmora_logo_black.svg`](public/logo/helmora_logo_black.svg) | Icon mark |
| [`public/logo/helmora_logo_white.svg`](public/logo/helmora_logo_white.svg) | Icon mark (dark) |

## Scripts

```bash
npm run dev
npm test
npm run typecheck
npm run build && npm start
npm run start:ptero
npm run docker:up
```

GitHub Actions reproduces the locked Node 22 gate with `npm ci`, `npm test`,
`npm run typecheck`, `npm run build`, and a high-severity runtime dependency
audit. Unit tests set `NODE_ENV=test` and do not read the developer's `.env`.

## License

Private / Helmora-AI — see repository settings for access.
