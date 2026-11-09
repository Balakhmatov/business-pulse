#!/usr/bin/env bash
# Pin the current app without restarting it or changing its database/configuration.
set -Eeuo pipefail
REPO=/opt/business-pulse-management
REMOTE=https://github.com/Balakhmatov/business-pulse.git
EXPECTED=$(cat "$(dirname "$(readlink -f "$0")")/stable-revision")
if [[ $(id -u) != 0 ]]; then echo 'Run as root'; exit 1; fi
[[ "$EXPECTED" =~ ^[a-f0-9]{40}$ ]]
[[ $(git -C "$REPO" remote get-url origin) == "$REMOTE" ]]
if systemctl cat business-pulse-management-deploy.timer >/dev/null 2>&1; then
    systemctl disable --now business-pulse-management-deploy.timer
fi
# Let an in-flight deployment finish; do not terminate it halfway through a backup.
exec 9>/run/lock/business-pulse-management-deploy.lock
flock -x -w 240 9
[[ -z $(git -C "$REPO" status --porcelain) ]] || { echo 'Production has local changes; no files changed'; exit 1; }
CURRENT=$(git -C "$REPO" rev-parse HEAD)
BRANCH=$(git -C "$REPO" branch --show-current)
DEPLOYED=$(cat /var/lib/business-pulse-management/deploy-state/deployed 2>/dev/null || true)
[[ -z "$DEPLOYED" || "$DEPLOYED" == "$CURRENT" ]] || { echo 'Checkout and deployed marker differ; inspect production'; exit 1; }
if [[ "$BRANCH" == feature/management-workspace ]]; then
    [[ "$CURRENT" == "$EXPECTED" ]] || { echo "Current production differs from reviewed revision $EXPECTED; no checkout changes made"; exit 1; }
elif [[ "$BRANCH" != production ]]; then
    echo 'Unexpected production checkout branch'; exit 1
fi
git -C "$REPO" fetch --quiet origin refs/heads/production:refs/remotes/origin/production
[[ $(git -C "$REPO" rev-parse origin/production) == "$CURRENT" ]] || { echo 'Remote production differs from the running checkout; refusing to change app code'; exit 1; }
if [[ "$BRANCH" != production ]]; then
    if git -C "$REPO" show-ref --verify --quiet refs/heads/production; then
        [[ $(git -C "$REPO" rev-parse production) == "$CURRENT" ]] || { echo 'Existing local production branch differs'; exit 1; }
        git -C "$REPO" switch production
    else
        git -C "$REPO" switch -c production --track origin/production
    fi
fi
[[ $(git -C "$REPO" rev-parse HEAD) == "$CURRENT" ]]
systemctl is-active --quiet business-pulse-management.service
curl --noproxy 127.0.0.1 -fsS --max-time 10 http://127.0.0.1:3128/businesspulse/api/health
printf '\nProduction pinned at %s. Autodeploy disabled; app was not restarted.\n' "$CURRENT"
