#!/usr/bin/env bash
# Only the isolated management service and its checkout/database are deployed.
set -Eeuo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export GIT_TERMINAL_PROMPT=0

REPO=/opt/business-pulse-management
STORE=/var/lib/business-pulse-management
STATE="$STORE/deploy-state"
REMOTE=https://github.com/Balakhmatov/business-pulse.git
BRANCH=feature/management-workspace
SERVICE=business-pulse-management.service
SERVICE_USER=business-pulse-management
NODE=/usr/local/bin/node-business-pulse
WORKER=/usr/local/sbin/business-pulse-management-deploy
LOCK=/run/lock/business-pulse-management-deploy.lock

if [[ $(id -u) != 0 ]]; then echo 'Autodeploy must run as root'; exit 1; fi
exec 9>"$LOCK"
flock -n 9 || exit 0
if [[ $(git -C "$REPO" remote get-url origin) != "$REMOTE" ]]; then echo 'Unexpected remote'; exit 1; fi
if [[ $(git -C "$REPO" branch --show-current) != "$BRANCH" ]]; then echo 'Unexpected checkout branch'; exit 1; fi
if [[ -n $(git -C "$REPO" status --porcelain) ]]; then echo 'Checkout has local changes; refusing to overwrite them'; exit 1; fi
install -d -m 700 "$STATE" "$STATE/backups"
MARKER="$STATE/deployed"
FAILED="$STATE/failed"

# Network failures leave the running application alone.
if ! REF=$(timeout 20s git -C "$REPO" ls-remote --exit-code origin "refs/heads/$BRANCH"); then
    echo 'GitHub unavailable; will retry at next timer tick'; exit 0
fi
read -r NEW REF_NAME <<< "$REF"
if [[ ! "$NEW" =~ ^[a-f0-9]{40}$ || "$REF_NAME" != "refs/heads/$BRANCH" ]]; then echo 'Invalid remote reference'; exit 1; fi
CURRENT=$(git -C "$REPO" rev-parse HEAD)
DEPLOYED=$(cat "$MARKER" 2>/dev/null || true)
if [[ "$NEW" == "$DEPLOYED" && "$CURRENT" == "$NEW" ]]; then exit 0; fi
if [[ "$NEW" == "$(cat "$FAILED" 2>/dev/null || true)" ]]; then echo "Skipping previously failed revision $NEW"; exit 0; fi
if ! timeout 40s git -C "$REPO" fetch --quiet origin "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"; then
    echo 'Git fetch unavailable or non-fast-forward; application unchanged'; exit 0
fi
NEW=$(git -C "$REPO" rev-parse "refs/remotes/origin/$BRANCH")
if [[ "$NEW" == "$(cat "$FAILED" 2>/dev/null || true)" ]]; then exit 0; fi
OLD=${DEPLOYED:-$CURRENT}
if [[ ! "$OLD" =~ ^[a-f0-9]{40}$ ]] || ! git -C "$REPO" cat-file -e "$OLD^{commit}"; then echo 'Invalid deployed marker'; exit 1; fi
git -C "$REPO" merge-base --is-ancestor "$CURRENT" "$NEW" || { echo 'Non-fast-forward checkout refused'; exit 1; }
git -C "$REPO" merge-base --is-ancestor "$OLD" "$NEW" || { echo 'Running revision is not an ancestor'; exit 1; }

CANDIDATE=$(mktemp -d /opt/bp-management-check.XXXXXXXX)
chmod 755 "$CANDIDATE"
BACKUP=''
STOPPED=0
SWITCHED=0
SNAPSHOT=0
cleanup() { rm -rf -- "$CANDIDATE"; }
trap cleanup EXIT
source_permissions() {
    chmod 755 "$REPO"
    find "$REPO/management" -type d -exec chmod 755 {} +
    find "$REPO/management" -type f \( -name '*.mjs' -o -name '*.js' -o -name '*.html' -o -name '*.css' \) -exec chmod 644 {} +
}
rollback() {
    local code=$?
    trap - ERR
    set +e
    printf '%s\n' "$NEW" > "$FAILED"
    if [[ "$STOPPED" == 1 ]]; then
        systemctl stop "$SERVICE"
        if [[ "$SWITCHED" == 1 ]]; then
            git -C "$REPO" reset --hard "$OLD"
            source_permissions
            if [[ "$SNAPSHOT" == 1 ]]; then
                rm -f -- "$STORE/management.db-wal" "$STORE/management.db-shm"
                cp -- "$BACKUP/management.db" "$STORE/management.db"
                chown "$SERVICE_USER:$SERVICE_USER" "$STORE/management.db"
                chmod 600 "$STORE/management.db"
            fi
        fi
        systemctl start "$SERVICE"
    fi
    echo "Deploy failed at $NEW; previous revision: $OLD; backup: ${BACKUP:-not required}"
    exit "$code"
}
trap rollback ERR

echo "Checking management revision $NEW"
git -C "$REPO" archive "$NEW" management | tar -x --no-same-owner -C "$CANDIDATE"
runuser -u "$SERVICE_USER" -- "$NODE" --check "$CANDIDATE/management/server.mjs"
runuser -u "$SERVICE_USER" -- "$NODE" --check "$CANDIDATE/management/public/app.js"
shopt -s nullglob
TESTS=("$CANDIDATE"/management/*.test.mjs)
if [[ ${#TESTS[@]} == 0 ]]; then echo 'No management tests in candidate'; false; fi
timeout 120s runuser -u "$SERVICE_USER" -- "$NODE" --test "${TESTS[@]}"
# Check again in case somebody edited the checkout during validation.
[[ -z $(git -C "$REPO" status --porcelain) ]]
BACKUP=$(mktemp -d "$STATE/backups/release-XXXXXXXX")
printf '%s\n' "$OLD" > "$BACKUP/revision"
STOPPED=1
systemctl stop "$SERVICE"
python3 - "$STORE/management.db" "$BACKUP/management.db" <<'PY'
import pathlib, sqlite3, sys
source, destination = sys.argv[1:]
if not pathlib.Path(source).is_file():
    raise SystemExit('Management database missing; no deployment performed')
with sqlite3.connect('file:'+source+'?mode=ro', uri=True) as src, sqlite3.connect(destination) as dst:
    src.backup(dst)
    if dst.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise SystemExit('Backup failed SQLite quick_check')
PY
SNAPSHOT=1
SWITCHED=1
git -C "$REPO" merge --ff-only "$NEW"
source_permissions
systemctl start "$SERVICE"
curl --noproxy 127.0.0.1 --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 1 --retry-max-time 25 --max-time 3 http://127.0.0.1:3128/businesspulse/api/health |
    python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True and d.get("service")=="business-pulse-management"'
systemctl is-active --quiet "$SERVICE"
curl --noproxy cityai.site --fail --silent --show-error --retry 3 --retry-all-errors --retry-delay 1 --retry-max-time 15 --max-time 3 --resolve cityai.site:443:127.0.0.1 https://cityai.site/businesspulse/api/health |
    python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True and d.get("service")=="business-pulse-management"'
# Update the runner itself atomically after successful validation.
install -m 755 "$REPO/management/deploy/autodeploy.sh" "$WORKER.next"
mv -f -- "$WORKER.next" "$WORKER"
printf '%s\n' "$NEW" > "$MARKER.next"
mv -f -- "$MARKER.next" "$MARKER"
rm -f -- "$FAILED"
trap - ERR
echo "Management deployed: $NEW. Database backup: $BACKUP/management.db"
