#!/bin/sh
# Invoke the genre-data-pull Edge Function (stage 1, DR-0159).
# Usage:  sh pull-data.sh fantasy     (or: shared)
# Tokens are read from your environment or prompted — they never live in files.
set -e
GENRE="${1:?usage: sh pull-data.sh <genre|shared>}"
if [ -z "$SUPABASE_ANON_KEY" ]; then
  printf "Supabase anon key (Settings > API > anon public): "
  stty -echo; read SUPABASE_ANON_KEY; stty echo; echo ""
fi
if [ -z "$DATA_PULL_TOKEN" ]; then
  printf "DATA_PULL_TOKEN (the function secret you set): "
  stty -echo; read DATA_PULL_TOKEN; stty echo; echo ""
fi
curl -sS -X POST "https://mybnrqouoqavmbaywzoa.supabase.co/functions/v1/genre-data-pull" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "x-pull-token: $DATA_PULL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"genre\":\"$GENRE\"}"
echo ""
