#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

REPO=/opt/business-pulse
STORE=/var/lib/business-pulse
API_SERVICE=business-pulse-api.service
BOT_SERVICE=business-pulse.service
MARKER="$STORE/.deployed-commit"

exec 9>/run/lock/business-pulse-deploy.lock
flock -x -w 120 9

if [[ "$(id -u)" != "0" ]]; then echo "Deploy requires root through a restricted sudo command"; exit 1; fi
if [[ "$(git -C "$REPO" remote get-url origin)" != "https://github.com/Balakhmatov/business-pulse.git" ]]; then
  echo "Unexpected Git remote, refusing deployment"; exit 1
fi
if [[ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]]; then
  echo "Uncommitted tracked changes in production checkout, refusing deployment"; exit 1
fi

OLD=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" fetch --quiet origin main
NEW=$(git -C "$REPO" rev-parse origin/main)
if [[ "$NEW" == "$OLD" && -f "$MARKER" && "$(cat "$MARKER")" == "$NEW" ]]; then
  echo "Business Pulse services are already deployed at $NEW"; exit 0
fi
# A manual git pull changes the checkout but NOT the running processes.
# Without a deployment marker, still restart/migrate safely on the first run.
git -C "$REPO" merge-base --is-ancestor "$OLD" "$NEW" || {
  echo "Non-fast-forward update refused"; exit 1;
}

install -d -o root -g root -m 700 "$STORE/backups"
BACKUP=$(mktemp -d "$STORE/backups/pre-deploy-XXXXXXXX")
SWITCHED=0
BACKUP_COMPLETE=0
PREVIOUS_MARKER="$(cat "$MARKER" 2>/dev/null || true)"

rollback() {
  local code=$?
  trap - ERR
  echo "Deployment failed; restoring only Business Pulse services and data."
  systemctl stop "$BOT_SERVICE" "$API_SERVICE" || true
  if [[ "$SWITCHED" == "1" ]]; then
    git -C "$REPO" reset --hard "$OLD" || true
    if [[ -n "$PREVIOUS_MARKER" ]]; then
      printf '%s\n' "$PREVIOUS_MARKER" > "$MARKER"
    else
      rm -f "$MARKER"
    fi
    if [[ "$BACKUP_COMPLETE" == "1" ]]; then
      for ext in "" "-wal" "-shm"; do
        rm -f "$STORE/pulse.db$ext"
        if [[ -f "$BACKUP/pulse.db$ext" ]]; then
          cp -a "$BACKUP/pulse.db$ext" "$STORE/pulse.db$ext"
        fi
      done
    fi
  fi
  systemctl start "$API_SERVICE" || true
  systemctl start "$BOT_SERVICE" || true
  exit "$code"
}
trap rollback ERR

# Quiesce both BP readers/writers before making a transactionally consistent file backup.
systemctl stop "$BOT_SERVICE" "$API_SERVICE"
for ext in "" "-wal" "-shm"; do
  if [[ -f "$STORE/pulse.db$ext" ]]; then
    cp -a "$STORE/pulse.db$ext" "$BACKUP/pulse.db$ext"
  fi
done
BACKUP_COMPLETE=1

SWITCHED=1
git -C "$REPO" merge --ff-only origin/main

# Repeat the tests on the VPS before migrating the production DB.
cd "$REPO"
runuser -u business-pulse -- /usr/local/bin/node-business-pulse --check api/server.mjs
runuser -u business-pulse -- /usr/local/bin/node-business-pulse --check bot/index.mjs
runuser -u business-pulse -- /usr/local/bin/node-business-pulse --experimental-sqlite --test api/accumulate.test.mjs bot/digest.test.mjs

systemctl start "$API_SERVICE"
ready=0
for i in $(seq 1 20); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3117/api/health \
    | grep -q '"db":true'; then
    ready=1; break
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then echo "Business Pulse API health check failed"; false; fi
systemctl start "$BOT_SERVICE"
sleep 3
systemctl is-active --quiet "$API_SERVICE"
systemctl is-active --quiet "$BOT_SERVICE"

printf '%s\n' "$NEW" > "$MARKER"
chmod 600 "$MARKER"
trap - ERR
echo "Business Pulse deployed $NEW; previous revision: $OLD"
echo "Consistent pre-deployment SQLite backup: $BACKUP"
