#!/bin/bash
# Back up what exists only on this computer, so a broken Mac loses nothing:
#   - trade history (data/: the pump.fun trade and coin logs, saved Bybit trades)
#   - the bot wallet key (~/.pump-bot/wallet.json), the only way to the wallet's money
#   - settings (.env: Bybit and RPC keys)
#   - finished films (video/out/*.mp4)
# It goes to iCloud Drive when that is on (a copy off this Mac), else to the Desktop.
# Nothing is printed from the key or the settings, and nothing leaves your own accounts.
#
#   bash pump/backup.sh        run it again any time; it replaces the last backup

set -u
cd "$(dirname "$0")/.." || exit 1

ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
if [ -d "$ICLOUD" ]; then
  DEST="$ICLOUD/bot-backup"
  WHERE="iCloud Drive"
else
  DEST="$HOME/Desktop/bot-backup"
  WHERE="your Desktop"
fi
mkdir -p "$DEST" || { echo "✗ could not create $DEST"; exit 1; }
chmod 700 "$DEST"

saved=0

if [ -d data ]; then
  # caches can be downloaded again; leave them out
  if zip -qr "$DEST/trade-history.zip.tmp" data -x "data/research/cache/*" "data/microstructure/snapshots/*"; then
    mv -f "$DEST/trade-history.zip.tmp" "$DEST/trade-history.zip"
    echo "✓ trade history"
    saved=$((saved + 1))
  else
    rm -f "$DEST/trade-history.zip.tmp"
    echo "✗ trade history could not be zipped"
  fi
else
  echo "- no trade history in this folder (no data/ here)"
fi

WALLET="${PUMP_WALLET_FILE:-$HOME/.pump-bot/wallet.json}"
if [ -f "$WALLET" ]; then
  if cp -p "$WALLET" "$DEST/wallet.json" && chmod 600 "$DEST/wallet.json"; then
    echo "✓ bot wallet key"
    saved=$((saved + 1))
  else
    echo "✗ bot wallet key could not be copied"
  fi
else
  echo "- no bot wallet on this computer"
fi

if [ -f .env ]; then
  if cp -p .env "$DEST/env-settings.txt" && chmod 600 "$DEST/env-settings.txt"; then
    echo "✓ settings (.env)"
    saved=$((saved + 1))
  else
    echo "✗ settings could not be copied"
  fi
else
  echo "- no .env settings file here"
fi

if ls video/out/*.mp4 >/dev/null 2>&1; then
  mkdir -p "$DEST/films"
  if cp -p video/out/*.mp4 "$DEST/films/"; then
    echo "✓ films"
    saved=$((saved + 1))
  else
    echo "✗ films could not be copied"
  fi
fi

echo
if [ "$saved" -eq 0 ]; then
  echo "Nothing was found to back up. Run this from the bot folder (where you start the bot)."
  exit 1
fi
echo "Saved to $WHERE, in the folder bot-backup."
if [ "$WHERE" = "your Desktop" ]; then
  echo "iCloud Drive is off on this Mac, so this copy is still ON the Mac."
  echo "Move the bot-backup folder to a USB stick or a cloud drive to be safe."
fi
echo "wallet.json is the key to the bot wallet's money: never share that file."
