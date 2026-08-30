#!/usr/bin/env bash
#
# publish.sh — build the app, encrypt it, and deploy.
#
# The whole loop in one command:
#
#     ./publish.sh
#
# It asks for the passphrase rather than reading it from the environment, so it
# never lands in your shell history. Pass --no-push to build without deploying.
#
# Node is the only toolchain here — the build needs it, and node:crypto does the
# encryption — so this runs anywhere Node does, phone included.

set -euo pipefail
cd "$(dirname "$0")"

# --no-push is ours; anything else is forwarded to build_site.mjs, which is how
# --change-passphrase reaches it.
PUSH=1
BUILD_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--no-push" ]; then PUSH=0; else BUILD_ARGS+=("$arg"); fi
done

die() { printf '\npublish.sh: %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null || die "node is missing.
  Debian/Ubuntu:  sudo apt install nodejs npm
  macOS:          brew install node
  Termux:         pkg install nodejs"
command -v npm >/dev/null || die "npm is missing — install it alongside Node."

# backup.mjs uses global fetch, which arrived in Node 18.
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18 or newer is needed (this is $(node -v))."

[ -d node_modules ] || die "dependencies are not installed.  npm install"

[ -f routine.json ] || [ -f routine.enc ] || die "neither routine.json nor routine.enc is here.
Start from the sample and edit it:
  cp routine.sample.json routine.json"

if [ -z "${BACKLOG_PASSPHRASE:-}" ]; then
  printf 'Passphrase: ' >&2
  read -rs BACKLOG_PASSPHRASE
  printf '\n' >&2
  [ -n "$BACKLOG_PASSPHRASE" ] || die "empty passphrase."
  export BACKLOG_PASSPHRASE
fi

# --- 1. build the app and encrypt it into docs/ ---
echo
echo "[1/2] building and encrypting"
node build_site.mjs ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}

# The log is only ever in the Worker. A build cannot lose it, but a passphrase
# change makes it unreadable, so say so rather than let it be discovered later.
if [ -f worker.json ] && [ ! -f vault.json ]; then
  die "vault.json vanished — a rebuild would seal the site under a new key and
orphan everything already stored in the Worker. Restore vault.json from git."
fi

# --- 2. publish ---
echo
echo "[2/2] publishing"
git add docs vault.json routine.enc
if git diff --cached --quiet; then
  echo "nothing changed — the published site is already up to date"
  exit 0
fi

git diff --cached --stat | tail -1

if [ "$PUSH" = "0" ]; then
  echo "staged but not pushed (--no-push). Commit and push when ready."
  exit 0
fi

git commit -q -m "Update the published tracker"
git push -q origin HEAD

echo
echo "pushed. GitHub Actions is deploying now — the site updates in a minute or two."
