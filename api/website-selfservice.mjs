import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { ensureCompanyBilling, startCompanyTrial } from './billing.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const tokenOk=x=>typeof x==='string'&&/^[a-f0-9]{48}$/.test(x);
const invalid=(message,status=400)=>Object.assign(Error(message),{status});
function emailOf(input){
  const value=typeof input==='string'?input.trim().toLowerCase():'';
  if(value.length<6||value.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw invalid('Укажите корректный email.');
  return value;
}
function passwordCheck(password){
  if(typeof password!=='string'||password.length<10||password.length>128)
    throw invalid('Пароль должен содержать от 10 до 128 символов.');
}
const digest=(password,salt)=>scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex');
const HOUR=3600000,DAY=24*HOUR;

export function createWebsiteSelfService(db,now=Date.now){
  db.exec(
    'CREATE TABLE IF NOT EXISTS web_pending_signups ('+
      'email TEXT PRIMARY KEY,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,'+
      'company_name TEXT NOT NULL,industry TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,'+
      'expires_ms INTEGER NOT NULL);'+
    'CREATE TABLE IF NOT EXISTS web_password_resets ('+
      'email TEXT PRIMARY KEY REFERENCES web_accounts(email) ON DELETE CASCADE,'+
      'token_hash TEXT NOT NULL UNIQUE,expires_ms INTEGER NOT NULL);'+
    'CREATE TABLE IF NOT EXISTS web_mail_events ('+
      'kind TEXT NOT NULL,email_hash TEXT NOT NULL,sent_ms INTEGER NOT NULL);'+
    'CREATE INDEX IF NOT EXISTS ix_web_mail_events_date ON web_mail_events(sent_ms);'+
    'CREATE INDEX IF NOT EXISTS ix_web_mail_events_account ON web_mail_events(email_hash,kind,sent_ms);'
  );
  const account=db.prepare('SELECT actor_id FROM web_accounts WHERE email=?');
  function throttle(kind,email){
    const at=now();
    db.prepare('DELETE FROM web_mail_events WHERE sent_ms<?').run(at-DAY);
    const total=db.prepare('SELECT COUNT(*) AS n FROM web_mail_events').get().n;
    const target=db.prepare('SELECT COUNT(*) AS n,MAX(sent_ms) AS last FROM web_mail_events WHERE email_hash=? AND kind=?')
      .get(sha(email),kind);
    // Limit aggregate outgoing mail, per email and resend frequency.
    if(total>=150||target.n>=4||target.last!==null&&at-target.last<60000)
      throw invalid('Слишком много запросов. Попробуйте позже.',429);
    db.prepare('INSERT INTO web_mail_events(kind,email_hash,sent_ms) VALUES(?,?,?)').run(kind,sha(email),at);
  }
  function beginSignup({email:raw,password,company_name,industry='other',accepted_terms}={}){
    if(accepted_terms!==true)throw invalid('Примите условия сервиса.');
    const email=emailOf(raw);
    passwordCheck(password);
    const name=typeof company_name==='string'?company_name.trim():'';
    if(name.length<2||name.length>120)throw invalid('Укажите название компании (2–120 символов).');
    if(!['other','clinic','store','cafe','auto'].includes(industry))throw invalid('Неверный тип компании.');
    // If address already belongs to an account, return a generic success.
    if(account.get(email))return null;
    throttle('verify',email);
    const token=randomBytes(24).toString('hex'),salt=randomBytes(16).toString('hex'),at=now();
    db.prepare('DELETE FROM web_pending_signups WHERE expires_ms<=?').run(at);
    db.prepare(
      'INSERT INTO web_pending_signups (email,password_salt,password_hash,company_name,industry,token_hash,expires_ms)'+
      ' VALUES(?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET '+
      'password_salt=excluded.password_salt,password_hash=excluded.password_hash,'+
      'company_name=excluded.company_name,industry=excluded.industry,'+
      'token_hash=excluded.token_hash,expires_ms=excluded.expires_ms'
    ).run(email,salt,digest(password,salt),name,industry,sha(token),at+DAY);
    return {email,token};
  }
  function verifySignup(token){
    if(!tokenOk(token))throw invalid('Ссылка подтверждения недействительна.');
    db.exec('BEGIN IMMEDIATE');
    try{
      const at=now();
      const pending=db.prepare('SELECT * FROM web_pending_signups WHERE token_hash=? AND expires_ms>?').get(sha(token),at);
      if(!pending)throw invalid('Ссылка истекла или уже использована. Зарегистрируйтесь заново.');
      if(account.get(pending.email))throw invalid('Адрес уже зарегистрирован.');
      const actor='web:'+randomUUID(),companyId=randomUUID();
      db.prepare('INSERT INTO users(telegram_id) VALUES(?)').run(actor);
      db.prepare('INSERT INTO companies(id,owner_id,name,industry) VALUES(?,?,?,?)')
        .run(companyId,actor,pending.company_name,pending.industry);
      db.prepare('INSERT INTO web_accounts(email,actor_id,password_salt,password_hash,created_ms) VALUES(?,?,?,?,?)')
        .run(pending.email,actor,pending.password_salt,pending.password_hash,at);
      ensureCompanyBilling(db,{id:companyId,owner_id:actor});
      startCompanyTrial(db,{id:companyId,owner_id:actor},'website-email-verified',at,new Set(['website-email-verified']));
      db.prepare('DELETE FROM web_pending_signups WHERE email=?').run(pending.email);
      // Existing website account module recognizes the same sessions.
      const session=randomBytes(24).toString('hex');
      db.prepare('INSERT INTO web_sessions(token_hash,actor_id,expires_ms) VALUES(?,?,?)')
        .run(sha(session),actor,at+30*DAY);
      db.exec('COMMIT');
      return {token:session};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function beginReset(raw){
    const email=emailOf(raw);
    if(!account.get(email))return null;
    throttle('reset',email);
    const token=randomBytes(24).toString('hex');
    db.prepare(
      'INSERT INTO web_password_resets(email,token_hash,expires_ms) VALUES(?,?,?)'+
      ' ON CONFLICT(email) DO UPDATE SET token_hash=excluded.token_hash,expires_ms=excluded.expires_ms'
    ).run(email,sha(token),now()+30*60000);
    return {email,token};
  }
  function finishReset({token,password}={}){
    if(!tokenOk(token))throw invalid('Ссылка восстановления недействительна.');
    passwordCheck(password);
    db.exec('BEGIN IMMEDIATE');
    try{
      const record=db.prepare('SELECT email FROM web_password_resets WHERE token_hash=? AND expires_ms>?')
        .get(sha(token),now());
      if(!record)throw invalid('Ссылка истекла или уже использована. Запросите новую.');
      const actor=account.get(record.email);
      if(!actor)throw invalid('Ссылка восстановления недействительна.');
      const salt=randomBytes(16).toString('hex');
      db.prepare('UPDATE web_accounts SET password_salt=?,password_hash=? WHERE email=?')
        .run(salt,digest(password,salt),record.email);
      db.prepare('DELETE FROM web_sessions WHERE actor_id=?').run(actor.actor_id);
      db.prepare('DELETE FROM web_password_resets WHERE email=?').run(record.email);
      db.exec('COMMIT');
      return {ok:true};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  return {beginSignup,verifySignup,beginReset,finishReset};
}
