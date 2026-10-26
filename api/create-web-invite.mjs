import { DatabaseSync } from 'node:sqlite';
import { createWebsiteAccounts } from './website-accounts.mjs';

const name = (process.argv[2] || '').trim();
const industry = process.argv[3] || 'other';
if (!name) {
  console.error('Использование: node api/create-web-invite.mjs "Название компании" [clinic|store|cafe|other]');
  process.exit(1);
}
const file = process.env.BP_DB_FILE || '/var/lib/business-pulse/pulse.db';
const db = new DatabaseSync(file);
try {
  const invitation = createWebsiteAccounts(db).createInvite(name, industry);
  console.log('Приглашение для компании: ' + name);
  console.log('Одноразовый код: ' + invitation.code);
  console.log('Срок: 7 дней. После регистрации откроются 48 часов тестирования.');
  console.log('Открыть: https://balakhmatov.github.io/business-pulse/index.html?login=1');
  console.log('Передавайте код клиенту только в личном сообщении. Код не появляется в URL.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
