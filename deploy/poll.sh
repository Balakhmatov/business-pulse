#!/usr/bin/env bash
# Lightweight VPS-side polling, no GitHub Actions and no GitHub SSH keys.
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export GIT_TERMINAL_PROMPT=0

REPO=/opt/business-pulse
MARKER=/var/lib/business-pulse/.deployed-commit
FAILED=/var/lib/business-pulse/.failed-deploy-commit
REMOTE=https://github.com/Balakhmatov/business-pulse.git

if [[ "$(id -u)" != "0" ]]; then echo "Run via systemd as root"; exit 1; fi
if [[ "$(git -C "$REPO" remote get-url origin)" != "$REMOTE" ]]; then
  echo "Unexpected Git remote; skipping deploy"; exit 1
fi

# Resolve just the main-branch SHA without downloading the entire repository.
# A temporary GitHub/network error must not stop working production services.
if ! result=$(timeout 20s git -C "$REPO" ls-remote origin refs/heads/main); then
  echo "GitHub check temporarily failed; retrying at next timer tick"
  exit 0
fi
read -r latest ref <<< "$result"
if [[ ! "$latest" =~ ^[0-9a-f]{40}$ || "$ref" != "refs/heads/main" ]]; then
  echo "Invalid GitHub main branch response"; exit 1
fi

deployed=$(cat "$MARKER" 2>/dev/null || true)
if [[ "$latest" == "$deployed" ]]; then exit 0; fi
# Do not flap the app every 15 seconds if a particular revision failed.
# Retry automatically when a new commit arrives.
if [[ -f "$FAILED" && "$(cat "$FAILED")" == "$latest" ]]; then exit 0; fi

echo "New BP revision detected: ${deployed:-not-yet-deployed} => $latest"
if /usr/local/sbin/business-pulse-deploy; then
  rm -f "$FAILED"
else
  printf '%s\n' "$latest" > "$FAILED"
  chmod 600 "$FAILED"
  echo "BP revision $latest failed; waiting for a new commit before retry"
  exit 1
fi
