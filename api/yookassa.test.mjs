import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureBillingSchema,subscriptionFor,TRIAL_MS } from './billing.mjs';
import { createPayments } from './yookassa.mjs';
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE companies(id TEXT PRIMARY KEY,owner_id TEXT);INSERT INTO companies VALUES('a','1'),('b','2');");
 let at=Date.now();ensureBillingSchema(db,at);const start=at,c={id:'a',owner_id:'1'},calls=[];let payment,status='pending',tamper={},lost=false;
 const service=createPayments({db,shopId:'shop',secretKey:'secret',now:()=>at,fetcher:async(url,options)=>{
  calls.push({url,options});
  if(options.method==='POST'){
   const body=JSON.parse(options.body);payment={id:'provider',amount:body.amount,metadata:body.metadata,recipient:{account_id:'shop'},confirmation:{confirmation_url:'https://yoomoney.ru/checkout/test'}};
   if(lost){lost=false;throw Error('timeout');}
  }
  return {ok:true,json:async()=>({...payment,status,paid:status==='succeeded',captured_at:new Date(at).toISOString(),...tamper})};
 }});
 return {db,c,service,calls,start,setTime:v=>at=v,setStatus:v=>status=v,tamper:v=>tamper=v,lose:()=>lost=true};
}
test('Server prices, SBP, company metadata, separate order and retry idempotence',async t=>{
 const f=fixture(t);f.lose();await assert.rejects(f.service.create(f.c,'1','month'));
 const first=f.calls[0];const result=await f.service.create(f.c,'1','month');
 assert.equal(f.calls[1].options.headers['Idempotence-Key'],first.options.headers['Idempotence-Key']);
 const body=JSON.parse(first.options.body);assert.deepEqual(body.amount,{value:'2490.00',currency:'RUB'});assert.equal(body.payment_method_data.type,'sbp');assert.equal(body.metadata.company_id,'a');assert.equal(body.capture,true);
 assert.equal(result.status,'pending');await f.service.create(f.c,'1','month');assert.equal(f.calls.filter(c=>c.options.method==='POST').length,2);
 await assert.rejects(f.service.create(f.c,'1','year'),/незавершённый/);
});
test('Only verified successful payment grants once; other company and pending grant nothing',async t=>{
 const f=fixture(t);await f.service.create(f.c,'1','halfyear');await f.service.refresh({id:'b'});
 assert.equal(subscriptionFor(f.db,f.c).plan,null);
 f.setStatus('succeeded');f.tamper({amount:{value:'1.00',currency:'RUB'}});await assert.rejects(f.service.refresh(f.c));
 f.tamper({metadata:{product:'cityai'}});await assert.rejects(f.service.refresh(f.c));
 f.tamper({test:true});await assert.rejects(f.service.refresh(f.c));
 f.tamper({});await f.service.refresh(f.c);const s=subscriptionFor(f.db,f.c);assert.equal(s.plan,'halfyear');
 await f.service.refresh(f.c);assert.equal(subscriptionFor(f.db,f.c).paid_until_ms,s.paid_until_ms);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_grants').get().n,1);
});
test('Welcome uses captured time, not delayed reconciliation time',async t=>{
 const f=fixture(t);await f.service.create(f.c,'1','welcome');f.setStatus('succeeded');
 f.tamper({captured_at:new Date(f.start+1000).toISOString()});f.setTime(f.start+TRIAL_MS+1000);await f.service.refresh(f.c);assert.equal(subscriptionFor(f.db,f.c).plan,'welcome');
});
test('Late promo payment requires review and expired trial can buy standard plan',async t=>{
 const f=fixture(t);await f.service.create(f.c,'1','welcome');f.setTime(f.start+TRIAL_MS+1000);f.setStatus('succeeded');await f.service.refresh(f.c);
 assert.equal(subscriptionFor(f.db,f.c).plan,null);assert.equal(f.db.prepare('SELECT status FROM billing_payments').get().status,'needs_review');
 const g=fixture(t);g.setTime(g.start+TRIAL_MS+1000);await assert.rejects(g.service.create(g.c,'1','welcome'),/48 часов/);await g.service.create(g.c,'1','year');
});
test('Concurrent clicks share one creation; canceled payment can be replaced',async t=>{
 const f=fixture(t);
 const results=await Promise.all([f.service.create(f.c,'1','month'),f.service.create(f.c,'1','month')]);
 assert.equal(results[0].id,results[1].id);assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
 f.setStatus('canceled');await f.service.refresh(f.c);assert.equal(subscriptionFor(f.db,f.c).plan,null);
});
test('Uncertain creation is never retried outside provider idempotence window',async t=>{
 const f=fixture(t);f.lose();await assert.rejects(f.service.create(f.c,'1','month'));
 f.setTime(f.start+24*3600000);await assert.rejects(f.service.create(f.c,'1','month'),/уточняется/);assert.equal(f.calls.length,1);
});
