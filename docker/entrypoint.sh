#!/bin/sh
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-022}"

umask "$UMASK"

# --- ensure a group + user mapped to PUID:PGID (Debian shadow utils) ---
if ! getent group "$PGID" >/dev/null 2>&1; then
  groupadd -g "$PGID" mediabox 2>/dev/null || true
fi
GROUP_NAME="$(getent group "$PGID" | cut -d: -f1)"
[ -n "$GROUP_NAME" ] || GROUP_NAME="mediabox"

if ! getent passwd "$PUID" >/dev/null 2>&1; then
  useradd -u "$PUID" -g "$PGID" -M -N -s /usr/sbin/nologin mediabox 2>/dev/null || true
fi
USER_NAME="$(getent passwd "$PUID" | cut -d: -f1)"
[ -n "$USER_NAME" ] || USER_NAME="mediabox"

# --- GPU: add the runtime user to the group that owns the /dev/dri render
#     nodes so VAAPI/QSV hardware transcoding works. gosu keeps the user's
#     supplementary groups (a plain `docker --group-add` would be dropped). ---
if [ -d /dev/dri ]; then
  for dev in /dev/dri/renderD* /dev/dri/card*; do
    [ -e "$dev" ] || continue
    DRI_GID="$(stat -c '%g' "$dev" 2>/dev/null)" || continue
    DRI_GROUP="$(getent group "$DRI_GID" | cut -d: -f1)"
    if [ -z "$DRI_GROUP" ]; then
      DRI_GROUP="render_${DRI_GID}"
      groupadd -g "$DRI_GID" "$DRI_GROUP" 2>/dev/null || true
    fi
    usermod -aG "$DRI_GROUP" "$USER_NAME" 2>/dev/null || true
  done
fi

mkdir -p /config
# own the config dir only — never touch the media mounts
chown -R "$PUID:$PGID" /config

echo "[entrypoint] starting media-box as ${USER_NAME} (${PUID}:${PGID}) umask ${UMASK}"
exec gosu "$USER_NAME" node server.js
