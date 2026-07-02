# ---- build stage ----
# glibc (bookworm) base so the compiled native modules (better-sqlite3, sharp)
# match the glibc runtime below.
FROM node:24-bookworm-slim AS build
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
FROM node:24-bookworm-slim
WORKDIR /app

# Core: ffmpeg (built with vaapi + nvenc), gosu (privilege drop), tzdata, wget
# (healthcheck), and the free VAAPI runtime (AMD via mesa, generic libva).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg gosu tzdata wget \
        libva2 libva-drm2 vainfo mesa-va-drivers \
    && rm -rf /var/lib/apt/lists/*

# Best-effort: modern Intel QuickSync driver (non-free repo). Never fails the
# build — software transcoding + AMD/NVIDIA still work without it.
RUN sed -i 's/^Components: main/Components: main contrib non-free non-free-firmware/' \
      /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    apt-get update \
    && apt-get install -y --no-install-recommends intel-media-va-driver-non-free || true; \
    rm -rf /var/lib/apt/lists/*

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
