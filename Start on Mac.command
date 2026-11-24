#!/bin/bash
# Double-click this file to start Group Sorter on a Mac.

cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

wait_for_key() {
  echo ""
  read -n 1 -s -r -p "Press any key to close this window."
  echo ""
}

if [ ! -f "src/index.js" ]; then
  echo ""
  echo " This file must stay inside the Group Sorter folder."
  echo " Unzip the folder first, then open the unzipped folder and try again."
  wait_for_key
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo " One thing to install first: Node.js (free)."
  echo " A download page is opening. Install the version marked LTS,"
  echo " then double-click this file again."
  command -v open >/dev/null 2>&1 && open "https://nodejs.org/en/download"
  wait_for_key
  exit 1
fi

if [ ! -f "node_modules/.ready" ]; then
  echo ""
  echo " First-time setup. Downloading what the bot needs. This takes a minute or two..."
  echo ""
  if ! npm ci --omit=dev --no-audit --no-fund; then
    echo ""
    echo " Setup could not finish. Check the internet connection and double-click this file again."
    wait_for_key
    exit 1
  fi
  touch "node_modules/.ready"
fi

while true; do
  if command -v caffeinate >/dev/null 2>&1; then
    caffeinate -i node src/index.js   # keeps the Mac awake while the bot runs
  else
    node src/index.js
  fi
  code=$?
  if [ "$code" -eq 0 ] || [ "$code" -eq 130 ]; then
    break
  fi
  if [ "$code" -eq 2 ]; then
    wait_for_key
    break
  fi
  echo ""
  echo " The bot stopped unexpectedly. Starting it again in 5 seconds."
  echo " Close this window if you want it to stay stopped."
  sleep 5
done
