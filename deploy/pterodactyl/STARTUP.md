# Pterodactyl — custom startup (≤512 chars)

## Paste vào ô (khuyến nghị)

```bash
[ -d .git ]||(git clone --depth 1 -b ${GIT_BRANCH:-main} ${GIT_REPO:-https://github.com/Helmora-AI/HelmoraHub.git} /tmp/h&&cp -a /tmp/h/. .&&rm -rf /tmp/h);bash scripts/ptero-startup.sh
```

| Bước | Việc làm |
|------|----------|
| Không có `.git` | Clone shallow vào `/tmp/h` rồi copy vào `/home/container` (lần đầu / sau upload zip) |
| Có `.git` | Bỏ qua clone |
| Luôn | `bash scripts/ptero-startup.sh` → **git pull**, `npm ci`/`install`, build, start |

**Lưu ý:** bản cũ dùng `[ -f scripts/ptero-startup.sh ]||clone…` — nếu bạn upload zip (đã có script nhưng **không** có `.git`) thì **không bao giờ** git sync. Đổi sang `[ -d .git ]` như trên. Branch mặc định trên GitHub là **`main`** (không phải `master`).

Sau khi đã chắc có `.git`, có thể rút còn:

```bash
bash scripts/ptero-startup.sh
```

## Env hỗ trợ (panel)

| Env | Ví dụ |
|-----|--------|
| `GIT_REPO` | `https://github.com/Helmora-AI/HelmoraHub.git` (optional; mặc định URL trên) |
| `GIT_BRANCH` | `main` (default; clone lần đầu + pull trong script) |

Tunnel / Hub: `CLOUDFLARE_TUNNEL_TOKEN`, `CLOUDFLARE_TUNNEL_AUTO_START=1`, `ENCRYPTION_KEY`, `DATA_DIR=/home/container/data`, `HELMORA_PUBLIC=1`.

## Log bạn nên thấy

```text
[helmora] git pull…
[helmora] npm install…   (hoặc npm ci)
[helmora] npm run build…
[helmora] starting …
```

Nếu **không** có dòng `git pull` → lúc đó không có thư mục `.git` (startup cũ hoặc source zip). Đổi command như trên rồi **Restart** một lần.

Nếu egg vẫn chạy `AUTO_UPDATE` + `npm install` **trước** custom startup: tắt custom egg update hoặc chấp nhận double `npm install` — phần pull quan trọng nằm trong `ptero-startup.sh`.

## better-sqlite3 / npm 12

Ptero Node eggs often ship **npm 12**, which blocks install scripts by default → missing `better_sqlite3.node` at runtime.

Hub commits in `package.json`:

```json
"allowScripts": { "better-sqlite3": true }
```

Startup verifies the `.node` binding and rebuilds if missing. After pull: delete `node_modules` in File Manager once, then Start again.
