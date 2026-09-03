#!/bin/sh
# Genre Report Network — gated production deploy, 2026-09-03 Part 4 (thriller correction).
# Registry: genre_reports.network.deploy_path. Run with:  sh deploy-2026-09-03-part4.sh
set -e
cd "$(dirname "$0")"
echo "Unpacking the Part 4 build..."
rm -rf genre-report-network
tar xzf genre-report-network-2026-09-03-part4.tar.gz
cd genre-report-network
echo ""
echo "This deploys to PRODUCTION at reports.stevepieper.com:"
echo "  - THRILLER CORRECTION ONLY: both thriller pages replace the"
echo "    'engagement-based' label (ACX's term is 'Member Value') and the"
echo "    December 31 deadline (ACX says only 'by end of year'), with a dated,"
echo "    visible correction note. No other page or Worker change."
echo ""
printf "Type DEPLOY to proceed (anything else aborts): "
read ans
[ "$ans" = "DEPLOY" ] || { echo "Aborted — nothing was deployed."; exit 1; }
npx wrangler@4 deploy
echo ""
echo "Done. Spot-check: the correction note at the end of the first story on"
echo "https://reports.stevepieper.com/thriller/aug-2026/"
