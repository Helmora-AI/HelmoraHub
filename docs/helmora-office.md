# Helmora Office (Claw3D fork)

Helmora Office is the **Virtual Office 3D** experience — a full fork of [Claw3D](https://github.com/claw3d/claw3d) wired to Helmora Hub as the custom runtime backend.

## Hub contract

Hub already exposes (no admin auth):

- `GET /health`
- `GET /state` — office agents, active models, identity
- `GET /registry` — model registry for Studio

Office chat uses `POST /v1/chat/completions` with Hub API keys. Requests may include `role` / `lane` matching desk ids (`coordinator`, `developer`, …).

Admin SPA: `GET /api/office/runtime` — summary for Agents → Office.

## Desk routing

| Desk id | Default mode | Model |
|---------|--------------|-------|
| coordinator | smart | auto |
| developer | coding | auto |
| analyst | smart | auto |
| scout | economy | auto |
| ops | manual | auto |
| reviewer | premium | auto |

When `model` is `auto`, Hub applies **Helmora Mini 1.0** multi-model chain (see `mini_route_v1` setting).

## Fork workflow

```bash
cd HelmoraOffice
npm run sync      # Claw3D + helmora-overrides
cd app && npm install && copy ..\.env.example .env.local
cd .. && npm run dev
```

Connect screen defaults to **Helmora Hub** (URL + `hel_*` key). See `HelmoraOffice/CREDITS.md`.

## Admin UI

- `/agents/office` — desk roster + Virtual Office launcher
- `/agents/mini` — Mini 1.0 candidate chain

## Deferred slices

- Automations / playbooks port
- Remote office presence (multi-user)
- Bundled deploy (Office + Hub single container)
