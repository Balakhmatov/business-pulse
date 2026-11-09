#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $(id -u) != 0 ]]; then echo 'Run as root'; exit 1; fi
CONFIG=$(readlink -f /etc/nginx/sites-enabled/cityai-staging)
DEPLOY=/opt/business-pulse-management-stage/management/deploy
[[ -f "$CONFIG" && -f "$DEPLOY/stage-nginx.conf" ]] || { echo 'Existing cityai-staging Nginx configuration is required'; exit 1; }
exec 7>/run/lock/business-pulse-stage-nginx.lock
flock -x -w 60 7
nginx -t
curl --noproxy 127.0.0.1 -fsS --max-time 10 http://127.0.0.1:3129/businesspulse/api/health
install -d -m 700 /var/backups/business-pulse-management-stage
BACKUP=$(mktemp /var/backups/business-pulse-management-stage/nginx.XXXXXXXX.conf)
cp -a -- "$CONFIG" "$BACKUP"
python3 "$DEPLOY/nginx-stage-route.py" "$CONFIG" "$DEPLOY/stage-nginx.conf"
restore() {
    cp -a -- "$BACKUP" "$CONFIG"
    nginx -t && systemctl reload nginx
    echo "Stage route failed; original stage config restored from $BACKUP"
}
if ! nginx -t; then restore; exit 1; fi
if ! systemctl reload nginx; then restore; exit 1; fi
if ! curl --noproxy stage.cityai.site -fsS --retry 5 --retry-all-errors --retry-delay 1 --retry-max-time 30 --max-time 5 --resolve stage.cityai.site:443:127.0.0.1 https://stage.cityai.site/businesspulse/api/health; then
    restore; exit 1
fi
printf '\nStage route ready. Backup: %s\n' "$BACKUP"
