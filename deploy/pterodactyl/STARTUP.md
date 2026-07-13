# Pterodactyl — custom startup (≤512 chars)

## Paste vào ô (ngắn)

```bash
[ -f scripts/ptero-startup.sh ]||(git clone --depth 1 ${GIT_REPO:-https://github.com/Helmora-AI/HelmoraHub.git} /tmp/h&&cp -a /tmp/h/. .&&rm -rf /tmp/h);bash scripts/ptero-startup.sh
```

(~180 ký tự) Lần đầu: clone repo → rồi script lo `git pull` / `npm install` / `build` / start.

Sau khi đã có source, có thể rút còn:

```bash
bash scripts/ptero-startup.sh
```

## Env hỗ trợ (panel)

| Env | Ví dụ |
|-----|--------|
| `GIT_REPO` | `https://github.com/Helmora-AI/HelmoraHub.git` (optional; mặc định URL trên) |
| `GIT_BRANCH` | dùng trong script sau khi đã có tree — clone lần đầu dùng default branch |

Tunnel / Hub: `CLOUDFLARE_TUNNEL_TOKEN`, `CLOUDFLARE_TUNNEL_AUTO_START=1`, `ENCRYPTION_KEY`, `DATA_DIR=/home/container/data`, `HELMORA_PUBLIC=1`.

## better-sqlite3 / npm 12

Ptero Node eggs often ship **npm 12**, which blocks install scripts by default → missing `better_sqlite3.node` at runtime.

Hub commits in `package.json`:

```json
"allowScripts": { "better-sqlite3": true }
```

Startup verifies the `.node` binding and rebuilds if missing. After pull: delete `node_modules` in File Manager once, then Start again.
