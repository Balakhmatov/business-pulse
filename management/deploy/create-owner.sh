#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $(id -u) != 0 ]]; then echo 'Run as root'; exit 1; fi
export BPM_DB_FILE=/var/lib/business-pulse-management/management.db
read -r -p 'Название компании: ' BPM_COMPANY
read -r -p 'Имя владельца: ' BPM_OWNER_NAME
read -r -p 'Email: ' BPM_OWNER_EMAIL
read -r -s -p 'Пароль (от 12 символов): ' BPM_OWNER_PASSWORD
printf '\n'
export BPM_COMPANY BPM_OWNER_NAME BPM_OWNER_EMAIL BPM_OWNER_PASSWORD
trap 'unset BPM_OWNER_PASSWORD' EXIT
runuser --preserve-environment -u business-pulse-management -- /usr/local/bin/node-business-pulse /opt/business-pulse-management/management/owner.mjs
