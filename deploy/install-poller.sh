#!/usr/bin/env bash
# First-time setup: run as root after git pull, using bash deploy/install-poller.sh
set -Eeuo pipefail
if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root on the Business Pulse VPS"; exit 1
fi
cd /opt/business-pulse
bash -n deploy/release.sh
bash -n deploy/poll.sh

# Do not race the old deployment while refreshing the trusted root-owned scripts.
systemctl stop business-pulse-deploy.timer 2>/dev/null || true

# Trusted root-owned entrypoints: ordinary Git commits cannot replace these binaries.
install -o root -g root -m 755 deploy/release.sh /usr/local/sbin/business-pulse-deploy
install -o root -g root -m 755 deploy/poll.sh /usr/local/sbin/business-pulse-poll
install -o root -g root -m 644 deploy/business-pulse-deploy.service /etc/systemd/system/business-pulse-deploy.service
install -o root -g root -m 644 deploy/business-pulse-deploy.timer /etc/systemd/system/business-pulse-deploy.timer

systemctl daemon-reload
# An explicitly repaired/reinstalled deployment may retry a commit that failed
# with the old unsafe umask. The scheduler itself never retries bad commits.
rm -f /var/lib/business-pulse/.failed-deploy-commit

# Deploy once immediately; if this fails the timer will NOT be enabled.
# release.sh backs up SQLite and rolls back on failure.
systemctl start business-pulse-deploy.service
systemctl enable --now business-pulse-deploy.timer

echo "Business Pulse local GitHub polling enabled."
systemctl status business-pulse-deploy.timer --no-pager -l
echo "View the last deployment: journalctl -u business-pulse-deploy.service -n 40 --no-pager"
