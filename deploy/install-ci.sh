#!/usr/bin/env bash
# Run ONCE as root on VPS: bash deploy/install-ci.sh /root/business-pulse-ci.pub
set -Eeuo pipefail
PUBKEY=${1:-}
if [[ "$(id -u)" != "0" || -z "$PUBKEY" || ! -f "$PUBKEY" ]]; then
  echo "Usage (as root): bash deploy/install-ci.sh /root/business-pulse-ci.pub"
  exit 1
fi
read -r KIND BLOB COMMENT < "$PUBKEY"
if [[ "$KIND" != "ssh-ed25519" || ! "$BLOB" =~ ^[a-zA-Z0-9+/=]+$ ]]; then
  echo "Expected a normal ssh-ed25519 public key"; exit 1
fi
if ! id bp-deploy >/dev/null 2>&1; then
  useradd --create-home --user-group --shell /bin/bash bp-deploy
fi

# Deployed executable is a ROOT-OWNED COPY, not a live script from the repo.
# Restricted SSH key forces one command and prevents an interactive shell.
install -o root -g root -m 755 /opt/business-pulse/deploy/release.sh \
  /usr/local/sbin/business-pulse-deploy
install -d -o bp-deploy -g bp-deploy -m 700 /home/bp-deploy/.ssh
printf 'restrict,command="sudo -n /usr/local/sbin/business-pulse-deploy" %s %s %s\n' \
  "$KIND" "$BLOB" "${COMMENT:-bp-github}" \
  > /home/bp-deploy/.ssh/authorized_keys
chown bp-deploy:bp-deploy /home/bp-deploy/.ssh/authorized_keys
chmod 600 /home/bp-deploy/.ssh/authorized_keys

printf '%s\n' 'bp-deploy ALL=(root) NOPASSWD: /usr/local/sbin/business-pulse-deploy' \
  > /etc/sudoers.d/business-pulse-deploy
chmod 440 /etc/sudoers.d/business-pulse-deploy
visudo -cf /etc/sudoers.d/business-pulse-deploy >/dev/null

echo "Restricted BP deployment user configured."
echo "VPS SSH public host key for GitHub secret BP_DEPLOY_KNOWN_HOSTS:"
awk '{print "194.31.174.8 " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
echo "GitHub secret BP_DEPLOY_HOST: 194.31.174.8"
echo "GitHub Actions deployment is still DISABLED until BP_DEPLOY_ENABLED is set to true."
