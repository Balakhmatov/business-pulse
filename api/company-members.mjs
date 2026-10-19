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
  let row;
  const hasMembers=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_members'").get();
  if(hasMembers)row=db.prepare('SELECT c.* FROM companies c JOIN company_members m ON m.company_id=c.id WHERE m.telegram_id=?').get(String(telegramId));
  if(row)return {...row,access_role:'member'};
  row=db.prepare('SELECT * FROM companies WHERE owner_id=? ORDER BY created_at,id LIMIT 1').get(String(telegramId));
  return row?{...row,access_role:'owner'}:null;
}
