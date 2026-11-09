#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $(id -u) != 0 ]]; then echo 'Run as root'; exit 1; fi
# Stage credentials are independent; production is not opened.
cd /opt/business-pulse-management-stage
export BPM_DB_FILE=/var/lib/business-pulse-management-stage/management.db
EXISTING=$(runuser -u business-pulse-stage -- /usr/local/bin/node-business-pulse --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync('/var/lib/business-pulse-management-stage/management.db',{readOnly:true});console.log(d.prepare(\"SELECT count(*) n FROM mg_members WHERE role='owner'\").get().n);d.close()")
if [[ "$EXISTING" != 0 ]]; then echo 'Stage already has an owner. Use its separate credentials.'; exit 0; fi
read -r -p 'Название компании STAGE: ' BPM_COMPANY
read -r -p 'Имя владельца: ' BPM_OWNER_NAME
read -r -p 'Email: ' BPM_OWNER_EMAIL
read -r -s -p 'Пароль (от 12 символов): ' BPM_OWNER_PASSWORD
printf '\n'
export BPM_COMPANY BPM_OWNER_NAME BPM_OWNER_EMAIL BPM_OWNER_PASSWORD
trap 'unset BPM_OWNER_PASSWORD' EXIT
runuser --preserve-environment -u business-pulse-stage -- /usr/local/bin/node-business-pulse /opt/business-pulse-management-stage/management/owner.mjs
