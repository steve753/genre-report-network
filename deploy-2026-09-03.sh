#!/bin/sh
# Genre Report Network — gated production deploy, 2026-09-03 build.
# Registry: genre_reports.network.deploy_path (attended = disk delivery + gated script).
# Run with:  sh deploy-2026-09-03.sh
set -e
cd "$(dirname "$0")"
echo "Unpacking the 2026-09-03 build..."
rm -rf genre-report-network
tar xzf genre-report-network-2026-09-03.tar.gz
cd genre-report-network
echo ""
echo "This deploys to PRODUCTION at reports.stevepieper.com:"
echo "  - Worker: click-through confirm/unsubscribe (GET renders, POST mutates; RFC 8058 kept),"
echo "    six-genre routing, tier-correct DOI emails (no more 'Fantasy Monthly')"
echo "  - 21 pages: five new genres x (home/subscribe/q4-2026), thriller fine-print +"
echo "    first-name patches, /privacy/ and /terms/, updated network home"
echo "  - config/genres.json: six genres, 34 aliases (clears the fantasy-subscribe 400)"
echo ""
printf "Type DEPLOY to proceed (anything else aborts): "
read ans
[ "$ans" = "DEPLOY" ] || { echo "Aborted — nothing was deployed."; exit 1; }
npx wrangler@4 deploy
echo ""
echo "Done. Spot-check: https://reports.stevepieper.com/fantasy/ and a test subscribe."
