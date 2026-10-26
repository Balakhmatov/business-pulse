import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createWebsiteAccounts } from './website-accounts.mjs';
import { createWebsiteSelfService } from './website-selfservice.mjs';
import { ensureBillingSchema,subscriptionFor } from './billing.mjs';

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;'+
    'CREATE TABLE users(telegram_id TEXT PRIMARY KEY,created_at TEXT DEFAULT CURRENT_TIMESTAMP);'+
    'CREATE TABLE companies(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(telegram_id),'+
    'name TEXT NOT NULL,industry TEXT NOT NULL DEFAULT \'other\',created_at TEXT DEFAULT CURRENT_TIMESTAMP);');
  ensureBillingSchema(db);
  let now=1000000000;
  const web=createWebsiteAccounts(db,()=>now);
  const self=createWebsiteSelfService(db,()=>now);
  const signup=(email='owner@example.com')=>self.beginSignup({
    email,password:'strong-password-2026',company_name:'Кафе Вкус',industry:'cafe',accepted_terms:true
  });
  return {db,web,self,signup,advance:ms=>(now+=ms),now:()=>now};
}
test('self signup creates no account or trial until email verification',()=>{
  const x=fixture();
  const pending=x.signup();
  assert.match(pending.token,/^[a-f0-9]{48}$/);
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM web_accounts').get().n,0);
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM companies').get().n,0);
  const result=x.self.verifySignup(pending.token);
  const actor=x.web.actor(result.token);
  assert.match(actor,/^web:/);
  const company=x.db.prepare('SELECT * FROM companies WHERE owner_id=?').get(actor);
  assert.equal(company.name,'Кафе Вкус');
  assert.equal(company.industry,'cafe');
  assert.equal(subscriptionFor(x.db,company,x.now()).state,'trial');
  assert.throws(()=>x.self.verifySignup(pending.token),/истекла|использована/);
  assert.equal(x.self.beginSignup({
    email:'owner@example.com',password:'new-password-5678',
    company_name:'Другая компания',accepted_terms:true
  }),null);
  x.db.close();
});
test('verification expires after 24h and cannot start free trial',()=>{
  const x=fixture(),request=x.signup();
  x.advance(24*3600000+1);
  assert.throws(()=>x.self.verifySignup(request.token),/истекла/);
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM web_accounts').get().n,0);
  x.db.close();
});
test('password reset is one-time, time-limited, invalidates active sessions',()=>{
  const x=fixture(),verify=x.signup();
  const active=x.self.verifySignup(verify.token).token;
  assert.ok(x.web.actor(active));
  assert.equal(x.self.beginReset('unknown@example.com'),null);
  const reset=x.self.beginReset('owner@example.com');
  assert.match(reset.token,/^[a-f0-9]{48}$/);
  assert.deepEqual(x.self.finishReset({token:reset.token,password:'new-password-4567'}),{ok:true});
  assert.equal(x.web.actor(active),null);
  assert.throws(()=>x.self.finishReset({token:reset.token,password:'another-password'}),/использована|истекла/);
  assert.throws(()=>x.web.login({email:'owner@example.com',password:'strong-password-2026'}),/Неверный/);
  assert.ok(x.web.actor(x.web.login({email:'owner@example.com',password:'new-password-4567'}).token));
  x.db.close();
});
test('password reset token expires and mail throttle applies per address',()=>{
  const x=fixture(),verify=x.signup();
  x.self.verifySignup(verify.token);
  const a=x.self.beginReset('owner@example.com');
  assert.throws(()=>x.self.beginReset('owner@example.com'),/Слишком много/);
  x.advance(31*60000);
  assert.throws(()=>x.self.finishReset({token:a.token,password:'new-password-5678'}),/истекла|использована/);
  x.db.close();
});
test('optional invitation registration still works',()=>{
  const x=fixture(),inv=x.web.createInvite('Кондитерская','cafe');
  const legacy=x.web.register({email:'invite@example.com',password:'strong-password-2026',invite:inv.code,accepted_terms:true});
  assert.ok(x.web.actor(legacy.token));
  x.db.close();
});
