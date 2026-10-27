import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ensureBillingSchema} from './billing.mjs';
import {createTrialEmailReminders} from './trial-email-reminders.mjs';
const START=Date.parse('2026-10-27T09:00:00Z'),HOUR=3600000;
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE users(telegram_id TEXT PRIMARY KEY);
 CREATE TABLE companies(id TEXT PRIMARY KEY,owner_id TEXT,name TEXT,industry TEXT);
 CREATE TABLE operations(company_id TEXT);CREATE TABLE company_members(telegram_id TEXT,company_id TEXT);
 CREATE TABLE web_accounts(email TEXT,actor_id TEXT);CREATE TABLE account_links(company_id TEXT,web_actor_id TEXT,telegram_id TEXT);
 INSERT INTO companies VALUES('web','web:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Тестовая клиника','clinic');
 INSERT INTO web_accounts VALUES('owner@example.test','web:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');`);
 ensureBillingSchema(db);let clock=START;
 db.prepare('UPDATE company_billing SET trial_started_ms=?,trial_ends_ms=?,trial_granted_by=?').run(START,START+48*HOUR,'website-email-verified');
 const sent=[],logs=[],mail={ready:true,sendTrialReminder:async payload=>{sent.push(payload)}};
 const make=()=>createTrialEmailReminders({db,mail,now:()=>clock,log:s=>logs.push(s)});
 const worker=make();
 return {db,mail,sent,logs,worker,make,set:n=>clock=n,advance:n=>clock+=n};
}
test('Website trial emails follow 24/46/48h schedule once, persist across restart and share Telegram receipt',async t=>{
 const f=fixture(t);assert.equal((await f.worker.tick()).sent,0);
 f.set(START+24*HOUR);await f.worker.tick();await f.worker.tick();await f.make().tick();
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].kind,'trial_unused');assert.equal(f.sent[0].to,'owner@example.test');
 f.set(START+46*HOUR);await f.worker.tick();f.set(START+48*HOUR);await f.worker.tick();
 assert.deepEqual(f.sent.map(s=>s.kind),['trial_unused','trial_ending','trial_ended']);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_reminders').get().n,3);
 assert.ok(f.db.prepare('SELECT * FROM billing_email_deliveries').all().every(d=>d.status==='sent'));
});
test('Uploads suppress inactive reminder; payment stops further reminders and recipients remain owner-only',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO operations VALUES('web');INSERT INTO company_members VALUES('web:staff','web');INSERT INTO web_accounts VALUES('staff@example.test','web:staff');");
 f.set(START+24*HOUR);await f.worker.tick();assert.equal(f.sent.length,0);
 f.set(START+46*HOUR);await f.worker.tick();assert.equal(f.sent.length,1);assert.equal(f.sent[0].to,'owner@example.test');
 f.db.prepare("UPDATE company_billing SET plan='month',paid_until_ms=?").run(START+100*HOUR);
 f.set(START+48*HOUR);await f.worker.tick();assert.equal(f.sent.length,1);
});
test('Linked accounts keep Telegram as channel and existing Telegram receipts prevent email duplication',async t=>{
 const f=fixture(t);f.set(START+24*HOUR);
 f.db.exec("INSERT INTO account_links VALUES('web','web:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','101')");
 await f.worker.tick();assert.equal(f.sent.length,0);
 f.db.exec('DELETE FROM account_links');
 f.db.prepare('INSERT INTO billing_reminders VALUES(?,?,?)').run('web','trial_unused',START+24*HOUR);
 await f.worker.tick();assert.equal(f.sent.length,0);
});
test('Parallel workers cannot send the same notice; restart with ambiguous in-flight delivery does not resend',async t=>{
 const f=fixture(t);f.set(START+24*HOUR);let release;
 f.mail.sendTrialReminder=async payload=>{f.sent.push(payload);await new Promise(r=>release=r)};
 const pending=f.worker.tick();await f.make().tick();assert.equal(f.sent.length,1);
 release();await pending;await f.make().tick();assert.equal(f.sent.length,1);
 f.db.exec("DELETE FROM billing_reminders;UPDATE billing_email_deliveries SET status='sending',lease_until_ms=1");
 await f.make().tick();assert.equal(f.sent.length,1);assert.equal(f.db.prepare('SELECT status FROM billing_email_deliveries').get().status,'uncertain');
});
test('Definite send failures back off and retry; ambiguous SMTP delivery is never automatically repeated',async t=>{
 const f=fixture(t);f.set(START+24*HOUR);let attempts=0;
 f.mail.sendTrialReminder=async p=>{attempts++;if(attempts===1)throw Object.assign(Error('private provider text'),{deliveryUncertain:false});f.sent.push(p)};
 await f.worker.tick();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_reminders').get().n,0);
 await f.worker.tick();assert.equal(attempts,1);f.advance(5*60000);await f.make().tick();assert.equal(attempts,2);assert.equal(f.sent.length,1);
 f.set(START+46*HOUR);f.mail.sendTrialReminder=async()=>{attempts++;throw Error('unknown transport outcome')};await f.worker.tick();f.advance(20*60000);await f.make().tick();assert.equal(attempts,3);
 assert.ok(f.logs.every(s=>!s.includes('owner@example')&&!s.includes('private provider')));
});
test('Rollout skips historic expired trials, disabled mail, invalid addresses and administrative email accounts',async t=>{
 const f=fixture(t);f.db.prepare('UPDATE company_billing SET trial_ends_ms=?').run(START-1);
 await f.worker.tick();assert.equal(f.sent.length,0);
 f.db.prepare('UPDATE company_billing SET trial_ends_ms=?').run(START+48*HOUR);f.set(START+24*HOUR);
 f.mail.ready=false;await f.worker.tick();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_email_deliveries').get().n,0);
 f.mail.ready=true;const prior=process.env.BP_ADMIN_WEB_IDS;
 try{process.env.BP_ADMIN_WEB_IDS='web:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';await f.worker.tick();assert.equal(f.sent.length,0);}finally{if(prior===undefined)delete process.env.BP_ADMIN_WEB_IDS;else process.env.BP_ADMIN_WEB_IDS=prior;}
 f.db.prepare('UPDATE web_accounts SET email=?').run('bad\r\nBcc:other@example.test');await f.worker.tick();assert.equal(f.sent.length,0);
});
test('Trial ended notice is not sent after more than 24 hours of downtime',async t=>{
 const f=fixture(t);f.set(START+73*HOUR);await f.worker.tick();assert.equal(f.sent.length,0);
});
