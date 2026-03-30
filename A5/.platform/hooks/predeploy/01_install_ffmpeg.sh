#!/bin/bash
# Amazon Linux 2023 + Python EB: install ffmpeg for A5 (runs before app starts; more reliable than .ebextensions commands).
set -euo pipefail

log() { echo "[predeploy ffmpeg] $*"; }

if [[ -x /usr/local/bin/ffmpeg ]] && /usr/local/bin/ffmpeg -version >/dev/null 2>&1; then
  log "already present at /usr/local/bin/ffmpeg"
  exit 0
fi

if command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version >/dev/null 2>&1; then
  log "ffmpeg on PATH: $(command -v ffmpeg)"
  exit 0
fi

if command -v dnf >/dev/null 2>&1; then
  log "trying dnf install..."
  dnf install -y ffmpeg ffmpeg-libs libsndfile 2>/dev/null || dnf install -y ffmpeg-free libsndfile 2>/dev/null || true
fi

if command -v ffmpeg >/dev/null 2>&1; then
  log "installed via dnf: $(command -v ffmpeg)"
  exit 0
fi

log "installing static amd64 build to /usr/local/bin"
mkdir -p /usr/local/bin
cd /tmp
rm -rf ffmpeg-*-amd64-static ffmpeg-static.tar.xz 2>/dev/null || true
curl -fsSL -o ffmpeg-static.tar.xz "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
tar -xf ffmpeg-static.tar.xz
STATIC_DIR="$(find /tmp -maxdepth 1 -type d -name 'ffmpeg-*-amd64-static' | head -1)"
if [[ -z "$STATIC_DIR" || ! -f "$STATIC_DIR/ffmpeg" ]]; then
  log "ERROR: could not unpack static ffmpeg"
  exit 1
fi
install -m 0755 "$STATIC_DIR/ffmpeg" /usr/local/bin/ffmpeg
install -m 0755 "$STATIC_DIR/ffprobe" /usr/local/bin/ffprobe
/usr/local/bin/ffmpeg -version
/usr/local/bin/ffprobe -version
log "static ffmpeg installed OK"
