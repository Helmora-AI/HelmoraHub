# Pterodactyl — custom startup (Linux)

Khi bật **Tùy chỉnh lệnh khởi động**, panel **không** chạy git/npm của egg nữa — lệnh custom phải tự làm đủ các bước.

Docker image: `ghcr.io/pterodactyl/yolks:nodejs_20`  
Server root: `/home/container`

Tunnel Cloudflare **không** nằm trong shell startup — Hub tự mở sau khi process chạy nếu có `CLOUDFLARE_TUNNEL_TOKEN` / file token / Settings.

---

## Paste vào ô (khuyến nghị — ngắn)

```bash
bash scripts/ptero-startup.sh
```

Script gồm: `git pull` → `NODE_PACKAGES` → `npm install` → `npm run build` → `node scripts/ptero-start.mjs`

---

## Paste vào ô (one-liner đầy đủ, không cần script)

```bash
cd /home/container; if [[ -d .git ]]; then git pull; fi; if [[ ! -z ${NODE_PACKAGES} ]]; then /usr/local/bin/npm install ${NODE_PACKAGES}; fi; if [[ ! -z ${UNNODE_PACKAGES} ]]; then /usr/local/bin/npm uninstall ${UNNODE_PACKAGES}; fi; if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi; /usr/local/bin/npm run build && /usr/local/bin/node /home/container/scripts/ptero-start.mjs
```

---

## Env panel

| Variable | Suggested |
|----------|-----------|
| `DATA_DIR` | `/home/container/data` |
| `HELMORA_PUBLIC` | `1` |
| `ENCRYPTION_KEY` | set |
| `CLOUDFLARE_TUNNEL_TOKEN` | optional (Hub auto-starts tunnel) |
| `HELMORA_PUBLIC_URL` / `HELMORA_FRONTEND_URL` | OAuth |
