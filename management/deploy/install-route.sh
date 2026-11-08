#!/usr/bin/env bash
# Add only the new location to the observed CityAI configuration.
set -Eeuo pipefail
if [[ $(id -u) != 0 ]]; then echo 'Run as root'; exit 1; fi
CONFIG=$(readlink -f /etc/nginx/sites-enabled/cityai)
SNIPPET=/opt/business-pulse-management/management/deploy/nginx.conf
if [[ ! -f "$CONFIG" || ! -f "$SNIPPET" ]]; then echo 'Configuration or management checkout missing'; exit 1; fi
nginx -t
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3128/businesspulse/api/health
install -d -m 700 /var/backups/business-pulse-management
BACKUP=$(mktemp /var/backups/business-pulse-management/cityai.XXXXXXXX.conf)
cp -a -- "$CONFIG" "$BACKUP"
python3 - "$CONFIG" "$SNIPPET" <<'PY'
import os, pathlib, shutil, sys, tempfile
config, snippet = map(pathlib.Path, sys.argv[1:])
source = config.read_text()
if '/businesspulse' in source:
    raise SystemExit('A businesspulse route already exists; inspect it instead of overwriting.')
anchor = '    location = /quorum'
if source.count(anchor) != 1:
    raise SystemExit('Nginx layout differs from the reviewed config; no changes made.')
addition = '\n'.join('    '+line if line else '' for line in snippet.read_text().splitlines())+'\n\n'
changed = source.replace(anchor, addition+anchor, 1)
fd, temp = tempfile.mkstemp(prefix='.bpm-', dir=config.parent)
try:
    with os.fdopen(fd, 'w') as f:
        f.write(changed)
    shutil.copystat(config, temp)
    os.chown(temp, config.stat().st_uid, config.stat().st_gid)
    os.replace(temp, config)
finally:
    if os.path.exists(temp): os.unlink(temp)
PY
if ! nginx -t; then
    cp -a -- "$BACKUP" "$CONFIG"
    echo "Validation failed; restored $CONFIG"
    exit 1
fi
if ! systemctl reload nginx; then
    cp -a -- "$BACKUP" "$CONFIG"
    echo "Reload failed; original config restored from $BACKUP"
    exit 1
fi
if ! curl --fail --silent --show-error --max-time 15 --resolve cityai.site:443:127.0.0.1 https://cityai.site/businesspulse/api/health; then
    cp -a -- "$BACKUP" "$CONFIG"
    nginx -t && systemctl reload nginx
    echo 'HTTPS health check failed; original route configuration restored.'
    exit 1
fi
printf '\nReady: https://cityai.site/businesspulse/\nBackup: %s\n' "$BACKUP"
