import { randomBytes,createHash } from 'node:crypto';
import { companyForUser } from './company-members.mjs';
import { ensureCompanyBilling,subscriptionFor } from './billing.mjs';

const digest=s=>createHash('sha256').update(s).digest('hex');
const tokenOK=s=>typeof s==='string'&&/^[a-f0-9]{48}$/.test(s);
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export function createAccountLink(db,now=Date.now) {
  db.exec('CREATE TABLE IF NOT EXISTS account_links ('+
    'web_actor_id TEXT PRIMARY KEY REFERENCES users(telegram_id),'+
    'telegram_id TEXT NOT NULL UNIQUE REFERENCES users(telegram_id),'+
    'company_id TEXT NOT NULL REFERENCES companies(id),'+
    'linked_ms INTEGER NOT NULL);'+
    'CREATE TABLE IF NOT EXISTS account_link_requests ('+
    'token_hash TEXT PRIMARY KEY,web_actor_id TEXT NOT NULL REFERENCES web_accounts(actor_id),'+
    'expires_ms INTEGER NOT NULL);');
  function linked(webActor) {
    const row=db.prepare('SELECT telegram_id,company_id FROM account_links WHERE web_actor_id=?').get(webActor);
    return row?{linked:true,telegram_id:row.telegram_id,company_id:row.company_id}:{linked:false};
  }
  function start(webActor){
    if(!/^web:[0-9a-f-]{36}$/.test(webActor||'')||
       !db.prepare('SELECT 1 FROM web_accounts WHERE actor_id=?').get(webActor))
      throw fail('Войдите на сайт по email.',401);
    if(linked(webActor).linked)throw fail('Telegram уже привязан к этому аккаунту.',409);
    const c=companyForUser(db,webActor);
    if(!c||c.access_role!=='owner')throw fail('Привязать Telegram может только владелец компании.',403);
    db.prepare('DELETE FROM account_link_requests WHERE expires_ms<=? OR web_actor_id=?').run(now(),webActor);
    const count=db.prepare('SELECT COUNT(*) AS n FROM account_link_requests').get().n;
    if(count>=1000)throw fail('Попробуйте повторить привязку чуть позже.',429);
    const token=randomBytes(24).toString('hex');
    db.prepare('INSERT INTO account_link_requests VALUES(?,?,?)').run(digest(token),webActor,now()+10*60000);
    return {url:'https://t.me/business_pulse_app_bot?start=link_'+token,expires_minutes:10};
  }
  function preview(token){
    if(!tokenOK(token))throw fail('Ссылка привязки недействительна.');
    const row=db.prepare('SELECT r.web_actor_id,c.name FROM account_link_requests r '+
      'JOIN companies c ON c.owner_id=r.web_actor_id '+
      'WHERE r.token_hash=? AND r.expires_ms>?').get(digest(token),now());
    if(!row)throw fail('Ссылка привязки истекла. Создайте новую на сайте.');
    return {company_name:row.name};
  }
  function complete(token,telegramActor){
    if(!tokenOK(token)||!/^[1-9]\d{0,15}$/.test(String(telegramActor)))
      throw fail('Ссылка привязки недействительна.');
    db.exec('BEGIN IMMEDIATE');
    try{
      const row=db.prepare('SELECT web_actor_id FROM account_link_requests WHERE token_hash=? AND expires_ms>?')
        .get(digest(token),now());
      if(!row)throw fail('Ссылка привязки истекла или уже использована.');
      const webActor=row.web_actor_id;
      if(db.prepare('SELECT 1 FROM account_links WHERE web_actor_id=? OR telegram_id=?')
        .get(webActor,String(telegramActor)))throw fail('Один из аккаунтов уже связан с другим.');
      const website=companyForUser(db,webActor),telegram=companyForUser(db,String(telegramActor));
      if(!website||website.access_role!=='owner')throw fail('Подключить можно только собственную компанию на сайте.',403);
      if(telegram&&telegram.access_role!=='owner')
        throw fail('Этот Telegram подключён как сотрудник другой компании. Обратитесь в поддержку.',409);
      if(telegram&&telegram.id===website.id)throw fail('Это уже одна компания.');
      const count=id=>db.prepare('SELECT COUNT(*) AS n FROM operations WHERE company_id=?').get(id).n;
      const webCount=count(website.id),tgCount=telegram?count(telegram.id):0;
      if(webCount&&tgCount)throw fail('В обоих кабинетах уже есть операции. Для безопасного объединения истории обратитесь в поддержку — данные не изменены.',409);
      const source=webCount?website:tgCount?telegram:website;
      const discarded=source.id===website.id?telegram:website;
      if(discarded){
        const members=db.prepare('SELECT COUNT(*) AS n FROM company_members WHERE company_id=?').get(discarded.id).n;
        const grants=db.prepare('SELECT COUNT(*) AS n FROM billing_grants WHERE company_id=?').get(discarded.id).n;
        if(members||grants)throw fail('В одной из компаний есть сотрудники или платежи. Для безопасного объединения обратитесь в поддержку.',409);
        // Preserve the longer paid/trial access if the surviving company has none.
        const before=subscriptionFor(db,discarded,now());
        const target=subscriptionFor(db,source,now());
        if(before?.state==='paid'&&target?.state!=='paid')
          throw fail('У второго аккаунта есть оплаченный доступ. Для переноса подписки обратитесь в поддержку.',409);
        if(before?.state==='trial'&&target?.state==='pending'){
          db.prepare('UPDATE company_billing SET trial_started_ms=?,trial_ends_ms=?,trial_granted_by=? WHERE company_id=?')
            .run(before.trial_started_ms,before.trial_ends_ms,before.trial_granted_by,source.id);
        }
        db.prepare('DELETE FROM companies WHERE id=?').run(discarded.id);
      }
      db.prepare('INSERT OR IGNORE INTO users(telegram_id) VALUES(?)').run(String(telegramActor));
      if(source.owner_id!==String(telegramActor))
        db.prepare('UPDATE companies SET owner_id=? WHERE id=?').run(String(telegramActor),source.id);
      db.prepare('INSERT INTO account_links VALUES(?,?,?,?)')
        .run(webActor,String(telegramActor),source.id,now());
      db.prepare('DELETE FROM account_link_requests WHERE web_actor_id=?').run(webActor);
      db.exec('COMMIT');
      return {linked:true,company_id:source.id,company_name:source.name};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  return {start,preview,complete,linked};
}
