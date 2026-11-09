#!/usr/bin/env bash
# One-time setup. No production app release or database copy takes place.
set -Eeuo pipefail
umask 022
REPO=/opt/business-pulse-management-stage
STORE=/var/lib/business-pulse-management-stage
STAGE_USER=business-pulse-stage
REMOTE=https://github.com/Balakhmatov/business-pulse.git
NODE=/usr/local/bin/node-business-pulse
SERVICE=business-pulse-management-stage.service
DEPLOY=business-pulse-management-stage-deploy
if [[ $(id -u) != 0 ]]; then echo 'Run as root'; exit 1; fi
for cmd in git python3 curl nginx systemctl flock runuser; do command -v "$cmd" >/dev/null || { echo "Missing $cmd"; exit 1; }; done
[[ -x "$NODE" ]] || { echo "Node 22.21.1+ required at $NODE"; exit 1; }
"$NODE" --input-type=module -e "import {DatabaseSync} from 'node:sqlite';new DatabaseSync(':memory:').close()"
if [[ ! -e "$REPO" ]]; then
    git clone --single-branch --branch dev "$REMOTE" "$REPO"
fi
[[ $(git -C "$REPO" remote get-url origin) == "$REMOTE" ]]
[[ $(git -C "$REPO" branch --show-current) == dev ]]
[[ -z $(git -C "$REPO" status --porcelain) ]] || { echo 'Stage checkout has local changes; refusing to overwrite'; exit 1; }
id "$STAGE_USER" >/dev/null 2>&1 || useradd --system --home "$STORE" --shell /usr/sbin/nologin "$STAGE_USER"
install -d -m 700 -o "$STAGE_USER" -g "$STAGE_USER" "$STORE"
install -d -m 700 /etc/business-pulse-management-stage
if [[ ! -e /etc/business-pulse-management-stage/app.env ]]; then
    (umask 077; printf '%s\n' 'BPM_ORIGIN=https://stage.cityai.site' 'BPM_BASE_PATH=/businesspulse' > /etc/business-pulse-management-stage/app.env)
fi
systemctl stop "$DEPLOY.timer" 2>/dev/null || true
exec 8>/run/lock/business-pulse-management-stage-deploy.lock
flock -x -w 240 8
# Stage uses a separate service user, not production's files or secrets.
chmod 755 "$REPO"
find "$REPO/management" -type d -exec chmod 755 {} +
find "$REPO/management" -type f \( -name '*.mjs' -o -name '*.js' -o -name '*.html' -o -name '*.css' \) -exec chmod 644 {} +
runuser -u "$STAGE_USER" -- "$NODE" --test "$REPO"/management/*.test.mjs
if ! systemctl is-active --quiet "$SERVICE"; then
    python3 - <<'PYPORT'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 3129))
PYPORT
fi
bash "$REPO/management/deploy/freeze-production.sh"
install -m 644 "$REPO/management/deploy/$SERVICE" "/etc/systemd/system/$SERVICE"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"
curl --noproxy 127.0.0.1 -fsS --retry 5 --retry-all-errors --retry-delay 1 --max-time 5 http://127.0.0.1:3129/businesspulse/api/health
bash "$REPO/management/deploy/install-stage-route.sh"
install -d -m 700 "$STORE/deploy-state"
git -C "$REPO" rev-parse HEAD > "$STORE/deploy-state/deployed"
rm -f -- "$STORE/deploy-state/failed"
install -m 755 "$REPO/management/deploy/stage-autodeploy.sh" "/usr/local/sbin/$DEPLOY"
install -m 644 "$REPO/management/deploy/$DEPLOY.service" "/etc/systemd/system/$DEPLOY.service"
install -m 644 "$REPO/management/deploy/$DEPLOY.timer" "/etc/systemd/system/$DEPLOY.timer"
systemctl daemon-reload
systemctl enable --now "$DEPLOY.timer"
systemctl is-active --quiet business-pulse-management.service
printf '\nSTAGE ready: https://stage.cityai.site/businesspulse/\nPush to dev updates STAGE only. Production is frozen with manual releases.\n'
printf 'Create a separate stage owner: bash %s/management/deploy/create-stage-owner.sh\n' "$REPO"
