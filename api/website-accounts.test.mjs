import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createWebsiteAccounts } from './website-accounts.mjs';
import { ensureBillingSchema, subscriptionFor } from './billing.mjs';

const createDb = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (telegram_id TEXT PRIMARY KEY,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE companies (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(telegram_id),
      name TEXT NOT NULL,industry TEXT NOT NULL DEFAULT 'other',created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  ensureBillingSchema(db);
  return db;
};
test('Invited website account receives independent company, trial and revocable session', () => {
  const db = createDb(); let at = 1000000;
  const web = createWebsiteAccounts(db, () => at);
  const invite = web.createInvite('Кондитерская');
  assert.match(invite.code, /^[a-f0-9]{48}$/);
  assert.throws(() => web.register({ email:'owner@example.com', password:'secret-pass-123', invite:invite.code }), /условия/);
  const {token} = web.register({ email:'owner@example.com',password:'secret-pass-123',invite:invite.code,accepted_terms:true });
  const actor = web.actor(token);
  assert.match(actor, /^web:/);
  const company = db.prepare('SELECT * FROM companies WHERE owner_id=?').get(actor);
  assert.equal(company.name, 'Кондитерская');
  assert.equal(subscriptionFor(db, company, at).access, true);
  assert.equal(subscriptionFor(db, company, at).state, 'trial');
  assert.throws(() => web.register({email:'x@example.com',password:'secret-pass-123',invite:invite.code,accepted_terms:true}), /использовано/);
  assert.throws(() => web.login({email:'owner@example.com',password:'wrong-password'}), /Неверный/);
  const logged = web.login({email:'OWNER@EXAMPLE.COM',password:'secret-pass-123'});
  assert.equal(web.actor(logged.token),actor);
  web.logout(logged.token);
  assert.equal(web.actor(logged.token),null);
  at += 48*3600000 + 1;
  assert.equal(subscriptionFor(db,company,at).access,false);
  at += 29*86400000;
  assert.equal(web.actor(token),null);
  db.close();
});
test('Invites isolate website customers; sessions from Telegram payment approval are not website accounts',()=>{
  const db=createDb();const web=createWebsiteAccounts(db);
  const input=(invite,email)=>({email,password:'a-secret-password',invite,accepted_terms:true});
  const a=web.register(input(web.createInvite('Кафе А').code,'a@example.com'));
  const b=web.register(input(web.createInvite('Кафе Б').code,'b@example.com'));
  const aId=web.actor(a.token),bId=web.actor(b.token);
  assert.notEqual(aId,bId);
  const companies=db.prepare('SELECT owner_id,id FROM companies ORDER BY owner_id').all();
  assert.equal(new Set(companies.map(c=>c.id)).size,2);
  const bogus='a'.repeat(48);
  db.prepare('INSERT INTO web_sessions VALUES(?,?,?)').run('sha-not-real','123456',Date.now()+86400000);
  assert.equal(web.actor(bogus),null);
  db.close();
});
