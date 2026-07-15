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
| Vault + outbox + workspace | Local disk under `DATA_DIR` |
| Secrets at rest | AES-GCM (`ENCRYPTION_KEY`) |
| Rate / cooldown / sticky | Memory or Redis |

Pick storage in Settings (`http://127.0.0.1:20800/settings`) or via runtime config. Full notes: [`docs/deploy.md`](docs/deploy.md).

## Quick start

```bash
git clone https://github.com/Helmora-AI/HelmoraHub.git
cd HelmoraHub
cp .env.example .env
npm install
npm run dev
```

Smoke:

```bash
curl http://127.0.0.1:20800/health
curl http://127.0.0.1:20800/api/status
```

Pair with the UI:

```bash
git clone https://github.com/Helmora-AI/HelmoraHub-Frontend.git
cd HelmoraHub-Frontend
npm install
npm run dev
```

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
3. Confirm several consecutive public requests to `GET /health` and
   `GET /api/auth/status` return `200`.
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

## License

Private / Helmora-AI — see repository settings for access.
