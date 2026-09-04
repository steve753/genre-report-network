#!/usr/bin/env bash
# Render the built page and drop full-page screenshots into the artifacts dir.
# Numeric SVG verification does not catch layout collisions — a rendered
# screenshot does (lesson of record, Mystery 001). GitHub's runner images ship
# Google Chrome; chromium variants are probed as fallbacks.
# Usage: screenshot.sh <public-root> <permalink-path> <out-dir>
set -euo pipefail
PUBLIC_ROOT="$1"   # the repo's public/ directory (served as site root)
REL="$2"           # e.g. /thriller/oct-2026/
OUT_DIR="$3"
PORT=8517
cd "$PUBLIC_ROOT"
python3 -m http.server "$PORT" >/dev/null 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT
sleep 1
CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"
"$CHROME" --headless=new --no-sandbox --disable-gpu --window-size=1100,1400 \
  --screenshot="$OUT_DIR/page-top.png" "http://localhost:$PORT$REL" 2>/dev/null
"$CHROME" --headless=new --no-sandbox --disable-gpu --window-size=1100,12000 \
  --screenshot="$OUT_DIR/page-full.png" "http://localhost:$PORT$REL" 2>/dev/null
"$CHROME" --headless=new --no-sandbox --disable-gpu --window-size=430,12000 \
  --screenshot="$OUT_DIR/page-mobile.png" "http://localhost:$PORT$REL" 2>/dev/null
for f in page-top page-full page-mobile; do
  [ -s "$OUT_DIR/$f.png" ] || { echo "screenshot $f.png missing or empty"; exit 1; }
done
echo "screenshots written to $OUT_DIR"
