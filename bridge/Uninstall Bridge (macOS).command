#!/bin/bash
# Double-click to uninstall the HTML to Figma bridge (macOS).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Download it from https://nodejs.org, then run this again."
else
  node install.mjs uninstall
fi
echo
read -n 1 -s -r -p "Press any key to close this window…"
