#!/bin/bash
# Double-click to install the agioDesign bridge (macOS).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Download it from https://nodejs.org, then run this again."
else
  node install.mjs install
fi
echo
read -n 1 -s -r -p "Press any key to close this window…"
