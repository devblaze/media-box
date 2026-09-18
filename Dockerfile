# ---- build stage ----
# glibc (trixie) base so the compiled native modules (better-sqlite3, sharp)
# match the glibc runtime below. Both stages move together for that reason.
FROM node:24-trixie-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

# ---- runtime stage ----
# glibc base + ffmpeg + VAAPI drivers so hardware transcoding (Intel QSV/VAAPI,
# AMD VAAPI, NVIDIA NVENC) works. NVIDIA also needs the host's nvidia-container
# runtime (--runtime=nvidia); no in-image NVIDIA packages are required.
#
# Debian 13 (trixie), not 12, specifically for Intel Arc. Debian 12's ffmpeg
# links Intel's old Media SDK (libmfx 1.35), which stops at 12th-generation
# integrated graphics: on an A380 QSV fails with "Error initializing an MFX
# session" while VAAPI encodes fine — the card is passed through correctly, the
# encoder library simply predates it. Trixie's ffmpeg is built against oneVPL,
# which is what Arc needs.
FROM node:24-trixie-slim
WORKDIR /app

# Core: ffmpeg (built with vaapi + nvenc), gosu (privilege drop), tzdata, wget
# (healthcheck), the free VAAPI runtime (AMD via mesa, generic libva), and adb.
# adb is what lets the server push its own Android build onto an Android TV or
# Fire TV over the network; without it that install falls back to typing a short
# URL into the TV by hand.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg gosu tzdata wget adb \
        libva2 libva-drm2 vainfo mesa-va-drivers libvpl2 \
    && rm -rf /var/lib/apt/lists/*

# Best-effort: modern Intel QuickSync driver + the oneVPL GPU runtime, both from
# the non-free repo. Never fails the build — software transcoding and AMD/NVIDIA
# still work without them, and so does Intel VAAPI via mesa.
RUN sed -i 's/^Components: main/Components: main contrib non-free non-free-firmware/' \
      /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        intel-media-va-driver-non-free libmfx-gen1.2 || true; \
    rm -rf /var/lib/apt/lists/*

# Fail the BUILD if this ffmpeg cannot do the hardware paths the app offers.
# Without it, an ffmpeg missing QSV ships silently and only fails on a user's
# GPU, which is exactly how the Arc problem reached someone's machine. This
# proves the BUILD supports them; whether a given host's GPU and driver do is
# what Settings > Transcoding > Test is for.
RUN for enc in h264_qsv h264_vaapi; do \
      ffmpeg -hide_banner -encoders 2>/dev/null | grep -q " $enc " \
        || { echo "FATAL: this ffmpeg has no $enc encoder"; exit 1; }; \
    done; \
    echo "ffmpeg hardware encoders present: $(ffmpeg -hide_banner -encoders 2>/dev/null | grep -cE ' (h264|hevc)_(qsv|vaapi|nvenc) ')"

# standalone server + static assets + drizzle migrations (applied at boot)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    PORT=7878 \
    HOSTNAME=0.0.0.0 \
    PUID=99 \
    PGID=100 \
    UMASK=022 \
    DOWNLOADS_DIR=/downloads \
    MOVIES_DIR=/movies \
    SERIES_DIR=/tv

VOLUME /config
EXPOSE 7878

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-7878}/api/v1/health" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
