import { randomBytes } from 'node:crypto';

export const TRIAL_MS=48*60*60*1000;
export const PLANS={
  month:{name:'1 месяц',months:1,price:2490,discount:0},
  welcome:{name:'Первый месяц в тестовый период',months:1,price:1990,discount:20},
  halfyear:{name:'6 месяцев',months:6,price:9990,discount:33},
  year:{name:'12 месяцев',months:12,price:17990,discount:40}
};
export const rub=value=>value.toLocaleString('ru-RU')+' ₽';
export const isAdminCompany=c=>new Set((process.env.BP_ADMIN_IDS??'1296951270').split(',').map(x=>x.trim())).has(String(c.owner_id));
// Permanent access is limited to the service administrator's OWN company.
// A website admin must be explicitly allowlisted or securely linked to a
// Telegram administrator. A staff role in another company never qualifies.
export function isAdminWorkspace(db,c){
  if(!c||!c.id||!c.owner_id)return false;
  // Do not elevate based on a forged in-memory company object.
  const actual=db.prepare('SELECT owner_id FROM companies WHERE id=?').get(c.id);
  if(!actual||String(actual.owner_id)!==String(c.owner_id))return false;
  if(isAdminCompany(c))return true;
  const owner=String(c.owner_id);
  if(!/^web:[0-9a-f-]{36}$/.test(owner))return false;
  const webIds=new Set((process.env.BP_ADMIN_WEB_IDS||'').split(',').map(s=>s.trim()));
  if(webIds.has(owner)&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_accounts'").get()&&
    db.prepare('SELECT 1 FROM web_accounts WHERE actor_id=?').get(owner))return true;
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_links'").get())return false;
  const link=db.prepare('SELECT telegram_id FROM account_links WHERE company_id=? AND web_actor_id=?').get(c.id,owner);
  return Boolean(link&&isAdminCompany({owner_id:link.telegram_id}));
}

export function ensureBillingSchema(db,at=Date.now()){
  db.exec('CREATE TABLE IF NOT EXISTS company_billing (company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,trial_started_ms INTEGER NOT NULL,trial_ends_ms INTEGER NOT NULL,paid_until_ms INTEGER,plan TEXT);'+
    'CREATE TABLE IF NOT EXISTS billing_reminders (company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,kind TEXT NOT NULL,sent_ms INTEGER NOT NULL,PRIMARY KEY(company_id,kind));'+
    'CREATE TABLE IF NOT EXISTS billing_confirmations (token TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,actor_id TEXT NOT NULL,plan TEXT NOT NULL,expires_ms INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);'+
    'CREATE TABLE IF NOT EXISTS billing_grants (token TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,actor_id TEXT NOT NULL,plan TEXT NOT NULL,amount_rubles INTEGER NOT NULL,confirmed_ms INTEGER NOT NULL,paid_until_ms INTEGER NOT NULL);');
  db.exec(`CREATE TABLE IF NOT EXISTS billing_email_deliveries (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,kind TEXT NOT NULL,
    status TEXT NOT NULL,token TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt_ms INTEGER NOT NULL,
    lease_until_ms INTEGER NOT NULL,sent_ms INTEGER,
    PRIMARY KEY(company_id,kind));
    CREATE TABLE IF NOT EXISTS billing_email_meta(key TEXT PRIMARY KEY,value_ms INTEGER NOT NULL);`);
  // Old automatic trials are not authorizations. Paid subscriptions are preserved.
  if(!db.prepare('PRAGMA table_info(company_billing)').all().some(x=>x.name==='trial_granted_by'))
    db.exec('ALTER TABLE company_billing ADD COLUMN trial_granted_by TEXT');
  db.prepare('INSERT OR IGNORE INTO company_billing(company_id,trial_started_ms,trial_ends_ms) SELECT id,0,0 FROM companies').run();
}
export function ensureCompanyBilling(db,c,at=Date.now()){
  db.prepare('INSERT OR IGNORE INTO company_billing(company_id,trial_started_ms,trial_ends_ms) VALUES(?,0,0)').run(c.id);
}
export function startCompanyTrial(db,c,actor,at=Date.now(),adminIds){
  const allowed=adminIds?adminIds.has(String(actor)):isAdminCompany({owner_id:actor});
  if(!allowed)throw Error('Тестовый доступ включает только администратор.');
  ensureCompanyBilling(db,c,at);
  const s=subscriptionFor(db,c,at);
  if(s.state==='paid'||s.state==='admin')throw Error('У компании уже есть доступ.');
  const result=db.prepare('UPDATE company_billing SET trial_started_ms=?,trial_ends_ms=?,trial_granted_by=? WHERE company_id=? AND trial_granted_by IS NULL AND plan IS NULL').run(at,at+TRIAL_MS,String(actor),c.id);
  if(result.changes!==1)throw Error('Пробный период уже выдавался. Повторное включение недоступно.');
  return subscriptionFor(db,c,at);
}
export function subscriptionFor(db,c,at=Date.now()){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_billing'").get())return null;
  const row=db.prepare('SELECT * FROM company_billing WHERE company_id=?').get(c.id);
  if(!row)return null;
  const granted=Boolean(row.trial_granted_by),paid=Number(row.paid_until_ms)>at,trial=granted&&row.trial_started_ms<=at&&row.trial_ends_ms>at,admin=isAdminWorkspace(db,c);
  return {...row,trial_started_ms:granted?row.trial_started_ms:0,trial_ends_ms:granted?row.trial_ends_ms:0,
    state:admin?'admin':paid?'paid':trial?'trial':!granted&&row.plan===null?'pending':'expired',access:admin||paid||trial,
    promo_available:trial&&row.plan===null,remaining_trial_ms:granted?Math.max(0,row.trial_ends_ms-at):0,
    monthly_price:trial&&row.plan===null?1990:2490};
}
export function assertSubscription(db,c,at=Date.now()){
  const s=subscriptionFor(db,c,at);
  if(!s?.access){const e=Error('Доступ к компании закрыт. Оплатите подписку или обратитесь в поддержку для включения пробного периода. Данные компании сохранены.');e.status=402;e.code='SUBSCRIPTION_REQUIRED';throw e;}
}
export function pricesText(s){
  const status=s?.state==='paid'?'Подписка оплачена до '+mskDate(s.paid_until_ms)+'.':s?.state==='pending'?'Доступ пока не активирован. Для начала работы оплатите подписку.':s?.state==='expired'?'Доступ завершён. Данные компании сохранены.':s?.state==='trial'?'Ваш тестовый период — до '+mskDate(s.trial_ends_ms)+'.':'';
  return '<b>Цены «Бизнес Пульс»</b>\n\n'+
    '— 1 месяц — <b>2 490 ₽</b>\n\n'+
    'Первый месяц — <b>1 990 ₽ вместо 2 490 ₽</b> (−20%) при оплате в течение тестовых 48 часов.\n\n'+
    '— 6 месяцев — <b>9 990 ₽</b> (−33%, экономия 4 950 ₽)\n\n'+
    '— 12 месяцев — <b>17 990 ₽</b> (−40%, экономия 11 890 ₽)\n\n'+
    (status?status+'\n\n':'')+
    'Пробные 48 часов включаются администратором по согласованию.';
}
export function mskDate(ms){return new Date(ms).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'})+' МСК';}
export function addCalendarMonths(ms,months){
  const d=new Date(ms),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
  d.setUTCDate(Math.min(day,last));return d.getTime();
}
export function paymentConfirmation(db,c,actor,plan,at=Date.now()){
  if(!Object.hasOwn(PLANS,plan))throw Error('Выберите тариф из списка.');
  const s=subscriptionFor(db,c,at);
  if(plan==='welcome'&&!s?.promo_available)throw Error('Цена 1 990 ₽ доступна только для первой оплаты в течение тестовых 48 часов.');
  db.prepare('DELETE FROM billing_confirmations WHERE expires_ms<? AND used=0').run(at);
  const token=randomBytes(12).toString('hex');
  const expires=plan==='welcome'?Math.min(at+10*60000,s.trial_ends_ms):at+10*60000;
  db.prepare('INSERT INTO billing_confirmations(token,company_id,actor_id,plan,expires_ms) VALUES(?,?,?,?,?)').run(token,c.id,String(actor),plan,expires);
  return token;
}
export function confirmReceivedPayment(db,c,actor,token,at=Date.now()){
  db.exec('BEGIN IMMEDIATE');
  try{
    const q=db.prepare('SELECT * FROM billing_confirmations WHERE token=? AND company_id=? AND actor_id=?').get(token,c.id,String(actor));
    if(!q||q.expires_ms<=at)throw Error('Подтверждение оплаты устарело. Выберите тариф заново.');
    if(q.used){db.exec('COMMIT');return subscriptionFor(db,c,at);}
    const s=subscriptionFor(db,c,at),plan=PLANS[q.plan];
    if(q.plan==='welcome'&&!s.promo_available)throw Error('Срок действия цены 1 990 ₽ завершён.');
    const end=addCalendarMonths(Math.max(at,s.trial_ends_ms,s.paid_until_ms||0),plan.months);
    db.prepare('UPDATE company_billing SET paid_until_ms=?,plan=? WHERE company_id=?').run(end,q.plan,c.id);
    db.prepare('UPDATE billing_confirmations SET used=1 WHERE token=?').run(token);
    db.prepare('INSERT INTO billing_grants VALUES(?,?,?,?,?,?,?)').run(token,c.id,String(actor),q.plan,plan.price,at,end);
    db.exec('COMMIT');return subscriptionFor(db,c,at);
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function reminderFor(db,c,at=Date.now()){
  const s=subscriptionFor(db,c,at);
  if(!s||!s.trial_granted_by||(s.state==='admin'||s.state==='paid')||s.plan!==null)return null;
  const elapsed=at-s.trial_started_ms;
  let kind;
  if(at>=s.trial_ends_ms)kind='trial_ended';
  else if(at>=s.trial_ends_ms-2*3600000)kind='trial_ending';
  else if(elapsed>=24*3600000&&!db.prepare('SELECT 1 FROM operations WHERE company_id=? LIMIT 1').get(c.id))kind='trial_unused';
  if(!kind||db.prepare('SELECT 1 FROM billing_reminders WHERE company_id=? AND kind=?').get(c.id,kind))return null;
  return {kind,text:trialReminderText(kind,s.trial_ends_ms)};
}
export function trialReminderText(kind,trialEndsMs){
  if(!['trial_unused','trial_ending','trial_ended'].includes(kind))throw Error('Неизвестное уведомление.');
  let text;
  if(kind==='trial_unused')text='Вашему бизнесу нужен контроль.\n\nПервый день тестового периода уже прошёл, а данные пока не загружены.\n\nЗагрузите CSV или Excel и получите аналитику вашего бизнеса.\n\nПервый месяц — 1 990 ₽ вместо 2 490 ₽\nСкидка 20% при оплате до '+mskDate(trialEndsMs)+'.';
  else if(kind==='trial_ending')text='Тестовый период скоро закончится\n\nБесплатный доступ действует до '+mskDate(trialEndsMs)+'.\n\nУспейте оформить подписку со скидкой:\n\n— Первый месяц — 1 990 ₽ вместо 2 490 ₽\nСкидка 20% при оплате в тестовый период\n\n— 6 месяцев — 9 990 ₽\nСкидка 33%, экономия 4 950 ₽\n\n— 12 месяцев — 17 990 ₽\nСкидка 40%, экономия 11 890 ₽';
  else text='Тестовый период завершился\n\nДанные вашей компании сохранены. Для продолжения работы выберите подписку:\n\n— 1 месяц — 2 490 ₽\n\n— 6 месяцев — 9 990 ₽\nСкидка 33%, экономия 4 950 ₽\n\n— 12 месяцев — 17 990 ₽\nСкидка 40%, экономия 11 890 ₽';
  return text;
}
