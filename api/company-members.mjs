// One active company per Telegram account for the MVP. Existing personal data
// stays in its own company when an employee is linked to a shared workspace.
export function ensureCompanyMembers(db){
  db.exec('CREATE TABLE IF NOT EXISTS company_members ('+
    'telegram_id TEXT PRIMARY KEY REFERENCES users(telegram_id),'+
    'company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,'+
    'created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);'+
    'CREATE INDEX IF NOT EXISTS ix_company_members_company ON company_members(company_id);');
}

export function companyForUser(db,telegramId){
  const actor=String(telegramId);
  // Linked email/password and Telegram credentials resolve to the SAME
  // company, with full owner privileges and shared data/billing.
  const hasLinks=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_links'").get();
  if(hasLinks){
    const linked=db.prepare('SELECT c.* FROM account_links l JOIN companies c ON c.id=l.company_id '+
      'WHERE l.web_actor_id=? OR l.telegram_id=?').get(actor,actor);
    if(linked)return {...linked,access_role:'owner'};
  }
  let row;
  const hasMembers=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_members'").get();
  if(hasMembers)row=db.prepare('SELECT c.* FROM companies c JOIN company_members m ON m.company_id=c.id WHERE m.telegram_id=?').get(String(telegramId));
  if(row)return {...row,access_role:'member'};
  row=db.prepare('SELECT * FROM companies WHERE owner_id=? ORDER BY created_at,id LIMIT 1').get(String(telegramId));
  return row?{...row,access_role:'owner'}:null;
}

// Caller owns the write transaction; shared by operator commands and invitations.
export function addCompanyMember(db,company,memberId){
  memberId=String(memberId);
  if(!/^[1-9]\d{0,15}$/.test(memberId))throw Error('Некорректный аккаунт сотрудника.');
  if(memberId===String(company.owner_id))throw Error('Руководитель уже имеет доступ к компании.');
  const existing=db.prepare('SELECT company_id FROM company_members WHERE telegram_id=?').get(memberId);
  if(existing&&existing.company_id!==company.id)throw Error('Этот сотрудник уже подключён к другой компании.');
  if(db.prepare('SELECT 1 FROM companies c WHERE c.owner_id=? AND ('+
    'EXISTS(SELECT 1 FROM operations o WHERE o.company_id=c.id) OR '+
    'EXISTS(SELECT 1 FROM company_members m WHERE m.company_id=c.id)) LIMIT 1').get(memberId))
    throw Error('У этого аккаунта уже есть собственная компания с данными или сотрудниками. Автоматическое объединение компаний не поддерживается.');
  db.prepare('INSERT OR IGNORE INTO users(telegram_id) VALUES(?)').run(memberId);
  db.prepare('INSERT OR IGNORE INTO company_members(telegram_id,company_id) VALUES(?,?)').run(memberId,company.id);
}
