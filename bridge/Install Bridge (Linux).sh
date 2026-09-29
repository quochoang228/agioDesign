#!/bin/sh
# Run (or double-click → "Run in terminal") to install the agioDesign bridge (Linux).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it (https://nodejs.org or your package manager), then run this again."
else
  node install.mjs install
fi
echo
printf "Press Enter to close…"
read _
