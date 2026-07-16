# Helmora Hub deploy assets

| File | Use |
|------|-----|
| [`helmora.service`](./helmora.service) | systemd on bare VPS |
| [`pterodactyl/egg-helmora.json`](./pterodactyl/egg-helmora.json) | Import into Pterodactyl |
| [`pterodactyl/STARTUP.md`](./pterodactyl/STARTUP.md) | Linux custom startup command |

Full guide: [`docs/deploy.md`](../docs/deploy.md)

Before any first boot, generate and configure `HELMORA_SETUP_TOKEN` (at least
32 random bytes), then set canonical `HELMORA_PUBLIC_URL` and
`HELMORA_FRONTEND_URL`/`HELMORA_CORS_ORIGINS` for every browser origin. Neither
bind address nor proxy headers grant setup or CORS trust. Use `/health` only for
liveness and `/ready` for traffic readiness. See the repository README's
"Secure first-run contract" section before rollout.
