#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
REPO=/opt/business-pulse-management
NODE=/usr/local/bin/node-business-pulse
SERVICE=business-pulse-management.service
STATE=/var/lib/business-pulse-management/deploy-state
if [[ $(id -u) != 0 ]]; then echo 'Run as root'; exit 1; fi
if [[ $(git -C "$REPO" remote get-url origin) != https://github.com/Balakhmatov/business-pulse.git ]]; then echo 'Unexpected remote'; exit 1; fi
if [[ $(git -C "$REPO" branch --show-current) != feature/management-workspace ]]; then echo 'Unexpected branch'; exit 1; fi
[[ -z $(git -C "$REPO" status --porcelain) ]] || { echo 'Local changes found; install stopped'; exit 1; }
# Stop the timer before replacing its runner; wait for a current deploy to finish.
systemctl stop business-pulse-management-deploy.timer 2>/dev/null || true
exec 9>/run/lock/business-pulse-management-deploy.lock
flock -x -w 180 9
"$NODE" --test "$REPO"/management/*.test.mjs
systemctl restart "$SERVICE"
curl --noproxy 127.0.0.1 --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 1 --max-time 3 http://127.0.0.1:3128/businesspulse/api/health
install -d -m 700 "$STATE"
git -C "$REPO" rev-parse HEAD > "$STATE/deployed"
rm -f -- "$STATE/failed"
install -m 755 "$REPO/management/deploy/autodeploy.sh" /usr/local/sbin/business-pulse-management-deploy
install -m 644 "$REPO/management/deploy/business-pulse-management-deploy.service" /etc/systemd/system/business-pulse-management-deploy.service
install -m 644 "$REPO/management/deploy/business-pulse-management-deploy.timer" /etc/systemd/system/business-pulse-management-deploy.timer
systemctl daemon-reload
systemctl enable --now business-pulse-management-deploy.timer
systemctl list-timers business-pulse-management-deploy.timer --no-pager
echo 'Management autodeploy enabled: feature/management-workspace, every 30 seconds.'
