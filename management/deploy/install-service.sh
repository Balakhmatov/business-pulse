#!/usr/bin/env bash
# Installs only the new service. Never touches production BP, its DB, or Quorum.
set -Eeuo pipefail
if [[ $(id -u) != 0 ]]; then echo 'Run as root'; exit 1; fi
REPO=/opt/business-pulse-management
BRANCH=feature/management-workspace
REMOTE=https://github.com/Balakhmatov/business-pulse.git
NODE=/usr/local/bin/node-business-pulse
if [[ ! -x "$NODE" ]]; then echo "Node 22.21.1+ with node:sqlite required at $NODE"; exit 1; fi
"$NODE" --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');db.close()"
if [[ -e "$REPO" ]]; then echo "$REPO already exists. Inspect and update manually; installer will not overwrite it."; exit 1; fi
id business-pulse-management >/dev/null 2>&1 || useradd --system --home /var/lib/business-pulse-management --shell /usr/sbin/nologin business-pulse-management
install -d -m 700 -o business-pulse-management -g business-pulse-management /var/lib/business-pulse-management
install -d -m 700 /etc/business-pulse-management
git clone --branch "$BRANCH" --single-branch "$REMOTE" "$REPO"
"$NODE" --test "$REPO"/management/*.test.mjs
if [[ ! -e /etc/business-pulse-management/app.env ]]; then
    umask 077
    printf '%s\n' 'BPM_ORIGIN=https://cityai.site' 'BPM_BASE_PATH=/businesspulse' > /etc/business-pulse-management/app.env
fi
install -m 644 "$REPO/management/deploy/business-pulse-management.service" /etc/systemd/system/business-pulse-management.service
systemctl daemon-reload
systemctl enable --now business-pulse-management.service
curl --fail --max-time 10 --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:3128/businesspulse/api/health
printf '\nService installed. Next: create owner and add the Nginx location as described in management/README.md.\n'
