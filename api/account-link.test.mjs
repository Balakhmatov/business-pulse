import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAccountLink} from './account-link.mjs';
import {companyForUser,ensureCompanyMembers} from './company-members.mjs';
import {ensureBillingSchema,startCompanyTrial,subscriptionFor} from './billing.mjs';

function fixture(t){
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;'+
    'CREATE TABLE users(telegram_id TEXT PRIMARY KEY);'+
    'CREATE TABLE companies(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(telegram_id),name TEXT NOT NULL,industry TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);'+
    'CREATE TABLE web_accounts(email TEXT PRIMARY KEY,actor_id TEXT UNIQUE NOT NULL REFERENCES users(telegram_id));'+
    'CREATE TABLE operations(company_id TEXT REFERENCES companies(id),amount_kopecks INTEGER);'+
    "INSERT INTO users VALUES('web:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'),('101'),('202');"+
    "INSERT INTO companies VALUES('web-company','web:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa','Кафе Онлайн','cafe'),('tg-company','101','Кафе Telegram','cafe');"+
    "INSERT INTO web_accounts VALUES('owner@example.org','web:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');");
  ensureCompanyMembers(db);ensureCompanyBilling(db);
  const link=createAccountLink(db,()=>Date.parse('2026-10-26T12:00:00Z'));
  t.after(()=>db.close());
  return {db,link,web:'web:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'};
}
function ensureCompanyBilling(db){ensureBillingSchema(db,Date.parse('2026-10-26T12:00:00Z'));}
function tokenFrom(url){return new URL(url).searchParams.get('start').slice('link_'.length);}

test('Links email and Telegram to existing Telegram company when only it has data',t=>{
  const {db,link,web}=fixture(t);
  db.prepare("INSERT INTO operations VALUES('tg-company',15000)").run();
  const website=companyForUser(db,web);
  startCompanyTrial(db,website,'website-email-verified',Date.parse('2026-10-26T12:00:00Z'),new Set(['website-email-verified']));
  const token=tokenFrom(link.start(web).url);
  assert.equal(link.preview(token).company_name,'Кафе Онлайн');
  assert.equal(link.complete(token,'101').company_id,'tg-company');
  assert.equal(companyForUser(db,web).id,'tg-company');
  assert.equal(companyForUser(db,'101').id,'tg-company');
  assert.equal(companyForUser(db,web).access_role,'owner');
  assert.equal(subscriptionFor(db,companyForUser(db,web),Date.parse('2026-10-26T12:00:00Z')).state,'trial');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM operations').get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM companies WHERE id='web-company'").get().n,0);
  assert.throws(()=>link.complete(token,'101'),/истекла|использована/);
});
test('Keeps real website operations when Telegram company is empty',t=>{
  const {db,link,web}=fixture(t);
  db.prepare("INSERT INTO operations VALUES('web-company',25000)").run();
  const token=tokenFrom(link.start(web).url);
  assert.equal(link.complete(token,'101').company_id,'web-company');
  assert.equal(companyForUser(db,web).id,'web-company');
  assert.equal(companyForUser(db,'101').id,'web-company');
  assert.equal(db.prepare("SELECT owner_id FROM companies WHERE id='web-company'").get().owner_id,'101');
  assert.equal(db.prepare("SELECT amount_kopecks FROM operations WHERE company_id='web-company'").get().amount_kopecks,25000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM companies WHERE id='tg-company'").get().n,0);
});
test('Never auto-selects one data-filled company over another',t=>{
  const {db,link,web}=fixture(t);
  db.prepare("INSERT INTO operations VALUES('web-company',25000),('tg-company',35000)").run();
  const token=tokenFrom(link.start(web).url);
  assert.throws(()=>link.complete(token,'101'),/обоих кабинетах уже есть операции/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM operations').get().n,2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM companies').get().n,2);
  assert.equal(link.linked(web).linked,false);
});
test('Rejects link token replay and linking another employee or previously linked identity',t=>{
  const {db,link,web}=fixture(t);
  db.prepare("INSERT INTO company_members VALUES('202','tg-company',CURRENT_TIMESTAMP)").run();
  const token=tokenFrom(link.start(web).url);
  assert.throws(()=>link.complete(token,'202'),/сотрудник/);
  assert.equal(link.complete(token,'101').linked,true);
  assert.throws(()=>link.start(web),/уже привязан/);
  assert.throws(()=>link.complete(token,'202'),/истекла|использована/);
});
