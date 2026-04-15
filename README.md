# Immich Swipe

Swipe-review your Immich library: right = keep, left = archive. It adds manual training vectors, scores new photos with CLIP + Qdrant, and can auto-archive high-confidence bad matches on a cron schedule.

![Vue 3](https://img.shields.io/badge/Vue-3.x-4FC08D?logo=vue.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-4.x-06B6D4?logo=tailwindcss)

<p align="center">
  <img src="docs/screenshots/home.png" width="960" alt="Immich Swipe home screen (sanitized demo)" />
</p>

<p align="center">
  <img src="docs/screenshots/mobile.png" width="260" alt="Immich Swipe mobile view (sanitized demo)" />
</p>

<p align="center">
  <img src="docs/screenshots/album-picker.png" width="960" alt="Album picker + hotkey mapping (sanitized demo)" />
</p>

> Screenshots are sanitized (no real photos or API keys).

## Features

- Swipe (touch/mouse) or use keyboard/buttons
- Random or chronological review (oldest/newest first)
- Skip videos toggle
- Favorite toggle (press `F`)
- Add-to-album (+ configurable `0–9` hotkeys)
- Undo (Ctrl/⌘+Z or ↑)
- Reviewed cache + stats persisted per server/user
- Preloads the next asset
- Manual training vectors stored in Qdrant
- Triage grid for batch review and training
- Toggleable server-side cron auto-archive
- User-controlled auto-archive threshold in the web UI
- Auto-archive never writes its own decisions back into training
- Archived assets are added to an Immich album named `archived` for later review
- Archived review page with restore and direct-open-in-Immich actions

## How It Works

1. Review photos manually in the swipe UI.
2. Manual keep/archive decisions are embedded with CLIP and stored in Qdrant.
3. The app scores fresh photos by comparing them against those manual vectors.
4. The triage page lets you review a scored batch and add more manual training examples.
5. If cron auto-archive is enabled, the server periodically scans a batch of photos and archives only the ones below your chosen threshold.

Important:
- Only manual actions contribute to training.
- Auto-archived photos do not train the model.
- The threshold is most useful after at least 5 manual training decisions.

## Controls

| Action | Gesture / Key | Button |
|---|---|---|
| Keep | Swipe right / `→` | ✓ |
| Delete (moves to trash) | Swipe left / `←` | ✕ |
| Undo | `Ctrl/⌘+Z` or `↑` | ↶ |
| Favorite | `F` | ♡ |
| Add to album | `0–9` (configured) | Album icon |

## Quickstart

### Local development

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

### Docker

```bash
cp env.example .env
# edit .env
docker compose up --build
```

Open `http://localhost:8080`.

Note: `.env` values are passed as build args and end up in the frontend bundle. Changing `.env` requires a rebuild.

### Docker image only

If you want to use the published image without rebuilding locally:

```bash
cp env.example .env
docker compose -f docker-compose.published.yml up -d
```

Open `http://localhost:8080`.

Behavior:
- Login is done manually in the web UI unless you build your own image with `VITE_*` values.
- Server-side auto-archive can still run from the published image when `AUTO_ARCHIVE_IMMICH_URL` and `AUTO_ARCHIVE_API_KEY` are set in `.env`.
- Auto-archive only uses manual training vectors. Photos archived by cron are never written back into the training set.
- GUI settings such as the cron toggle and threshold persist in the `swiparr_data` Docker volume.

### First-time setup checklist

1. Start the stack.
2. Open `http://localhost:8080`.
3. Log into Immich in the web UI, or build your own image with `VITE_*` values.
4. Swipe through some photos manually to create training data.
5. Open the Automatic Cleanup / Triage screen to inspect scores.
6. Enable cron auto-archive in the home screen once you are comfortable with the threshold.

### FreeNAS / TrueNAS bind-mount example

If you want fixed host paths instead of Docker-managed volumes, create:

```bash
mkdir -p /mnt/SSDCAGE/swiparr/qdrant
mkdir -p /mnt/SSDCAGE/swiparr/config
mkdir -p /mnt/SSDCAGE/swiparr/data
```

Then use:

```yaml
services:
  qdrant:
    image: qdrant/qdrant:latest
    container_name: immich-swipe-qdrant
    restart: unless-stopped
    ports:
      - "6333:6333"
    volumes:
      - /mnt/SSDCAGE/swiparr/qdrant:/qdrant/storage

  immich-swipe:
    image: goethenorris/swiparr:v4
    container_name: immich-swipe
    restart: unless-stopped
    depends_on:
      - qdrant
    ports:
      - "8080:80"
    environment:
      QDRANT_HOST: qdrant
      APP_DATA_DIR: /data
      AUTO_ARCHIVE_IMMICH_URL: ${AUTO_ARCHIVE_IMMICH_URL:-}
      AUTO_ARCHIVE_API_KEY: ${AUTO_ARCHIVE_API_KEY:-}
    volumes:
      - /mnt/SSDCAGE/swiparr/config:/data
      - /mnt/SSDCAGE/swiparr/data:/app/models
```

    The repository includes that FreeNAS-oriented bind-mount version in `docker-compose.template.yml`.

### GitHub Pages

This repo includes a GitHub Actions workflow that builds and deploys the SPA to GitHub Pages on every push to `main`.

After enabling Pages in your repo settings, your URL will be:
- `https://<owner>.github.io/<repo>/`

<details>
  <summary>Login screen</summary>
  <p align="center">
    <img src="docs/screenshots/login.png" width="320" alt="Login screen" />
  </p>
</details>

## Configuration

### Option A: `.env` users (build-time)

See `env.example`.

```bash
VITE_SERVER_URL=https://immich.example.com
VITE_USER_1_NAME=User 1
VITE_USER_1_API_KEY=your-api-key
```

Tip: `VITE_SERVER_URL` can be the base URL (recommended) or end with `/api` — the app normalizes it.

Behavior:
- 1 user configured: auto-login
- >1 users configured: user selection screen (`/select-user`)
- no `.env` users: manual login (`/login`), stored in `localStorage`

Note: user slots are currently wired up to `VITE_USER_5_*` in `src/vite-env.d.ts`, `Dockerfile`, and `docker-compose.yml`.

Security note: `VITE_*` variables are embedded into the compiled frontend. Only use `VITE_USER_*_API_KEY` for private deployments/images.

For the published Docker image, prefer `AUTO_ARCHIVE_IMMICH_URL` and `AUTO_ARCHIVE_API_KEY` for backend-only automation. These are read at runtime by the Node server and are not needed for manual UI login.

Required for server-side cron auto-archive:

```bash
AUTO_ARCHIVE_IMMICH_URL=https://immich.example.com
AUTO_ARCHIVE_API_KEY=your-api-key
```

### Option B: manual login (runtime)

If you don’t configure `.env` users, the app asks for:
- Immich Server URL
- API key

Those values are stored in `localStorage` under `immich-swipe-config`.

## API / CORS / Proxy

All requests use Immich’s API (`/api/...`) with the `x-api-key` header, so your Immich instance (or reverse proxy in front of it) needs to allow CORS.

If `VITE_SERVER_URL` points directly to your Immich instance (for example `https://immich.example.com`), your browser calls `https://immich.example.com/api/...`.

You’ll need CORS headers. For Nginx Proxy Manager, add:

```nginx
add_header 'Access-Control-Allow-Origin' '*' always;
add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, PATCH, DELETE, OPTIONS' always;
add_header 'Access-Control-Allow-Headers' 'X-Api-Key, X-Target-Host, User-Agent, Content-Type, Authorization, Range, Accept' always;
add_header 'Access-Control-Expose-Headers' 'Content-Length, Content-Range, Accept-Ranges' always;
if ($request_method = OPTIONS) { return 204; }
```

See also: https://docs.immich.app/administration/reverse-proxy/

## Stored data (localStorage)

- `immich-swipe-config` (manual login: server URL + API key)
- `immich-swipe-theme`
- `immich-swipe-skip-videos`
- `immich-swipe-stats:<server>:<user>` (keep/delete counters)
- `immich-swipe-reviewed:<server>:<user>` (already reviewed IDs + decision)
- `immich-swipe-preferences:<server>:<user>` (order mode + album hotkeys)

## Immich API key permissions

Minimum:
- `asset.read`
- `asset.update`

If you want albums and favorites, grant the corresponding read/update permissions as well.

## Training And Cron Notes

- The model starts with no knowledge on first run.
- Manual swipes and manual triage submissions are the only source of training vectors.
- Cron auto-archive uses your saved threshold from the home screen.
- Lower thresholds are stricter. Higher thresholds archive more aggressively.
- If you want to validate behavior safely, use the UI threshold first and build a few dozen manual decisions before relying on cron.

## Troubleshooting

- Images load slowly on first use: the model and proxy cache need to warm up.
- Auto-archive is enabled but does nothing: confirm `AUTO_ARCHIVE_IMMICH_URL` and `AUTO_ARCHIVE_API_KEY` are set, and confirm you have enough manual training data.
- Threshold changes are lost after restart: use the published compose template or a bind-mounted config path so `/data/settings.json` persists.
- The published image does not auto-login: that is expected unless you build your own image with `VITE_*` build args.

## Development scripts

- `npm run dev` (Vite, `5173`, `--host`)
- `npm run build`
- `npm run preview`
- `npm run type-check`
- `npm test`
