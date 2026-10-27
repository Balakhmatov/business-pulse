import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ensureBillingSchema} from './billing.mjs';
import {createPayments} from './yookassa.mjs';
import {createPlatformAdmin,isPlatformAdmin} from './platform-admin.mjs';
const at=Date.parse('2026-10-27T08:00:00Z'),DAY=86400000;
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE users(telegram_id TEXT PRIMARY KEY);
 CREATE TABLE companies(id TEXT PRIMARY KEY,owner_id TEXT,name TEXT,industry TEXT,created_at TEXT);
 CREATE TABLE operations(company_id TEXT,item TEXT,customer_key TEXT);
 CREATE TABLE company_members(company_id TEXT,telegram_id TEXT);
 CREATE TABLE imports(company_id TEXT,imported_at TEXT,last_change_at TEXT);
 CREATE TABLE web_accounts(actor_id TEXT,email TEXT,password_hash TEXT);
 CREATE TABLE account_links(company_id TEXT,web_actor_id TEXT,telegram_id TEXT);
 INSERT INTO companies VALUES('paid','101','Клиника','clinic','2026-10-25 08:00:00'),('expired','102','Магазин','store','2026-09-01 00:00:00'),('trial','103','Кафе','cafe','2026-10-26 00:00:00'),('pending','104','Новая','other','2026-10-27 00:00:00'),('admin','1296951270','Владелец','other','2026-08-01 00:00:00');
 INSERT INTO operations VALUES('paid','secret patient data','secret-key'),('paid','item2',NULL);
 INSERT INTO company_members VALUES('admin','999');
 INSERT INTO web_accounts VALUES('web:owner','owner@example.test','secret-password-hash'),('web:client','client@example.test','other-secret');
 INSERT INTO account_links VALUES('admin','web:owner','1296951270'),('paid','web:client','101');
 INSERT INTO imports VALUES('paid','2026-10-26 10:00:00','2026-10-25 00:00:00');`);
 ensureBillingSchema(db,at);createPayments({db,shopId:'',secretKey:''});
 db.prepare('UPDATE company_billing SET paid_until_ms=?,plan=? WHERE company_id=?').run(at+3*DAY,'month','paid');
 db.prepare('UPDATE company_billing SET paid_until_ms=?,plan=? WHERE company_id=?').run(at-DAY,'month','expired');
 db.prepare('UPDATE company_billing SET trial_started_ms=?,trial_ends_ms=?,trial_granted_by=? WHERE company_id=?').run(at-DAY,at+DAY,'1296951270','trial');
 const pay=db.prepare('INSERT INTO billing_payments(id,company_id,actor_id,plan,amount,created_ms,provider_id,status,applied_ms) VALUES(?,?,?,?,?,?,?,?,?)');
 pay.run('p1','paid','101','month',249000,at-DAY,'provider1','succeeded',at-DAY);
 pay.run('p2','paid','101','month',249000,at-1000,'provider2','pending',null);
 pay.run('p3','trial','103','welcome',199000,at-500,'provider3','needs_review',null);
 pay.run('p4','expired','102','month',249000,at-1000,'provider4','canceled',null);
 const grant=db.prepare('INSERT INTO billing_grants VALUES(?,?,?,?,?,?,?)');
 grant.run('yookassa:p1','paid','101','month',2490,at-DAY,at+3*DAY);
 grant.run('manual1','paid','101','month',2490,at-2*DAY,at+3*DAY);
 grant.run('old','expired','102','month',2490,at-60*DAY,at-DAY);
 grant.run('admin-payment','admin','1296951270','month',2490,at-DAY,at+30*DAY);
 const service=createPlatformAdmin(db,()=>at),call=(route,params={})=>service.handle('1296951270',route,new URLSearchParams(params));
 return {db,service,call};
}
test('Platform admin authorizes a person or verified linked account; company staff and clients are denied',t=>{
 const f=fixture(t);for(const id of ['101','999','web:client','web:unknown','']){assert.equal(isPlatformAdmin(f.db,id),false);assert.throws(()=>f.service.handle(id,'overview'),e=>e.status===403)}
 assert.equal(isPlatformAdmin(f.db,'web:owner'),true);assert.deepEqual(f.service.handle('web:owner','access'),{admin:true});
});
test('Commercial KPIs count applied receipts once, exclude operator and respect chosen period',t=>{
 const {call}=fixture(t),s=call('overview').summary;
 assert.equal(s.companies,4);assert.equal(s.admin_companies,1);assert.equal(s.paid,1);assert.equal(s.trial,1);assert.equal(s.expired,1);assert.equal(s.pending,1);assert.equal(s.expiring_7d,2);assert.equal(s.with_data,1);assert.equal(s.imports_7d,1);
 assert.equal(s.receipts_kopecks,498000);assert.equal(s.receipt_count,2);assert.equal(s.paying_companies,1);assert.equal(s.payment_review,1);assert.equal(s.payment_open,1);assert.equal(s.payment_canceled,1);
 assert.equal(call('overview',{days:'all'}).summary.receipts_kopecks,747000);
});
test('Company filters, identity and subscription expiry are accurate; no private operations or credentials leave admin API',t=>{
 const {call}=fixture(t);assert.equal(call('companies',{status:'expiring'}).total,2);assert.equal(call('companies',{q:'owner@example'}).total,1);assert.equal(call('companies',{status:'no_data'}).total,4);
 const paid=call('companies',{status:'paid'}).items[0];assert.equal(paid.days_left,3);assert.equal(paid.operation_count,2);
 const json=JSON.stringify([call('companies'),call('payments'),call('overview')]);for(const secret of ['secret-password','secret patient','secret-key','payment_url','password_hash'])assert.ok(!json.includes(secret));
});
test('Payment history shows manual and provider records once and filters company, pending attempts and date range',t=>{
 const {call}=fixture(t);assert.equal(call('payments').total,6);assert.equal(call('payments',{company_id:'paid'}).total,3);assert.equal(call('payments',{status:'pending'}).total,1);assert.equal(call('payments',{days:'all'}).total,7);
 const list=call('payments',{status:'succeeded',company_id:'paid'});assert.equal(list.total,2);assert.equal(list.items.reduce((s,p)=>s+p.amount_kopecks,0),498000);
});
test('Admin read endpoints are bounded, validated and do not mutate stored data',t=>{
 const {db,call}=fixture(t);const before=db.prepare('SELECT * FROM company_billing').all();
 for(const params of [{page:'0'},{page:'1 OR 1=1'},{status:'invalid'},{q:'a'.repeat(121)},{days:'365'}])assert.throws(()=>call('companies',params),e=>e.status===400);
 assert.equal(call('companies',{q:"' OR 1=1 --"}).total,0);assert.equal(call('companies',{page:'2'}).items.length,0);
 assert.throws(()=>call('missing'),e=>e.status===404);assert.deepEqual(db.prepare('SELECT * FROM company_billing').all(),before);
});

test('Admin allowlist and verified account link are checked on every request; empty configuration disables access',t=>{
 const {db,service}=fixture(t),previous=process.env.BP_ADMIN_IDS;
 try{
  process.env.BP_ADMIN_IDS='';
  for(const actor of ['1296951270','web:owner',''])assert.throws(()=>service.handle(actor,'access'),e=>e.status===403);
  process.env.BP_ADMIN_IDS='1296951270';assert.equal(service.handle('web:owner','access').admin,true);
  db.prepare('DELETE FROM account_links WHERE web_actor_id=?').run('web:owner');
  assert.throws(()=>service.handle('web:owner','companies'),e=>e.status===403);
 }finally{if(previous===undefined)delete process.env.BP_ADMIN_IDS;else process.env.BP_ADMIN_IDS=previous;}
});


test('Successful provider payment without applied access stays visible in the review filter',t=>{
 const {db,call}=fixture(t);
 db.prepare("UPDATE billing_payments SET status='succeeded' WHERE id='p2'").run();
 const review=call('payments',{status:'needs_review'});
 assert.equal(review.total,2);assert.ok(review.items.some(p=>p.id==='p2'));
 assert.equal(call('overview').summary.receipts_kopecks,498000,'Unapplied success must not invent a receipt');
});
