# media-box

Self-hosted, all-in-one **series + movies PVR** — a single app that replaces Sonarr, Radarr, and
Jellyseerr-style request management:

- **Two libraries, one app** — TV series and movies, both metadata-driven via TMDB.
- **Full PVR loop** — monitor → RSS sync → search Torznab indexers → grab via **qBittorrent** or
  **TorBox** (debrid) → track the queue → import with **hardlinks**, renaming per your templates →
  history & upgrades.
- **Requests** — invite users; they browse TMDB and request media, you approve from the queue, and
  the request flips to *available* the moment the file is imported.
- **One-click migration** from existing Sonarr and Radarr instances (library, monitored flags,
  quality profiles, Torznab indexers, qBittorrent clients).
- **Unraid-first packaging** — single container, `/config` volume, PUID/PGID, hardlink-aware.

## Quick start (Docker)

```bash
docker build -t media-box .
docker run -d --name media-box \
  -p 7878:7878 \
  -v /mnt/user/appdata/media-box:/config \
  -v /mnt/user/data:/data \
  -e PUID=99 -e PGID=100 -e TZ=Europe/Athens \
  media-box
```

Open `http://<host>:7878`, create the admin account, then:

1. **Settings → General** — paste a free [TMDB API key](https://www.themoviedb.org/settings/api).
2. **Settings → Media Management** — add root folders, e.g. `/data/media/tv` and `/data/media/movies`.
3. **Settings → Indexers** — add your Torznab endpoints (Prowlarr/Jackett work great).
4. **Settings → Download Clients** — add qBittorrent and/or TorBox.
5. Optionally **Settings → Migrate** — point at your Sonarr/Radarr URL + API key, review the
   mapping, and import everything.

For Unraid, a Community Applications template is provided in `unraid/media-box.xml`.

## The /data layout (hardlinks!)

Follow the [trash-guides layout](https://trash-guides.info/File-and-Folder-Structure/): downloads and
media must live on the **same filesystem** for instant, space-free imports:

```
/data
├── torrents/     <- qBittorrent's save path (category: media-box)
├── torbox/       <- TorBox staging dir (fetched files land here)
└── media/
    ├── tv/       <- series root folder
    └── movies/   <- movie root folder
```

- qBittorrent must mount the same `/data` share. If its container sees a different path (e.g.
  `/downloads`), add a **remote path mapping** under Settings → Media Management.
- When source and destination are on the same device media-box hardlinks (torrent keeps seeding,
  zero extra space); otherwise it falls back to a safe copy-then-rename.

## TorBox

TorBox downloads happen on TorBox's servers. media-box adds the torrent, polls until it's finished
remotely, then streams the files down into the staging dir (`/data/torbox` by default, configurable
per client) and imports from there. TorBox items don't seed, so they're removed after import.

## API

Everything the UI does goes through `GET/POST/PUT/DELETE /api/v1/*`. External tools authenticate
with the `X-Api-Key` header — the key is shown under Settings → General. `GET /api/v1/health` is
unauthenticated for container health checks.

## Users & requests

- **Admins** manage the libraries, settings, and the request approval queue.
- **Users** see the libraries and a Requests page: they search TMDB and request; approving a request
  auto-adds it (monitored, default profile/root folder) and triggers a search immediately.

## Development

```bash
yarn install
yarn dev       # config + SQLite DB land in ./.config-dev
yarn test      # parser/naming test suite
```

Built with Next.js 16 (single process: UI + API + in-process job scheduler), SQLite via Drizzle.
