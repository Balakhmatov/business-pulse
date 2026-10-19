import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { TRIAL_MS,PLANS,ensureBillingSchema,ensureCompanyBilling,subscriptionFor,assertSubscription,paymentConfirmation,confirmReceivedPayment,reminderFor,addCalendarMonths } from './billing.mjs';

const START=Date.parse('2026-10-19T10:00:00Z');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("PRAGMA foreign_keys=ON;CREATE TABLE companies(id TEXT PRIMARY KEY,owner_id TEXT);INSERT INTO companies VALUES('a','101'),('b','202');CREATE TABLE operations(company_id TEXT,amount_kopecks INTEGER);");
  ensureBillingSchema(db,START);
  const c={id:'a',owner_id:'101'};return {db,c};
}
test('Discounts use standard monthly cost and do not stack',()=>{
  for(const p of Object.values(PLANS))assert.equal(p.discount,Math.round((1-p.price/(2490*p.months))*100));
  assert.equal(2490*6-PLANS.halfyear.price,4950);assert.equal(2490*12-PLANS.year.price,11890);
});
test('Trial lasts exactly 48 hours and is not reset by schema migration or another company access',t=>{
  const {db,c}=fixture(t);
  ensureBillingSchema(db,START+10000);ensureCompanyBilling(db,c,START+20000);
  assert.equal(subscriptionFor(db,c,START).trial_ends_ms,START+TRIAL_MS);
  assert.equal(subscriptionFor(db,c,START+TRIAL_MS-1).access,true);
  assert.equal(subscriptionFor(db,c,START+TRIAL_MS).access,false);
  assert.throws(()=>assertSubscription(db,c,START+TRIAL_MS),e=>e.status===402);
});
test('Manual verified payment is actor/company scoped and idempotent; preserves remaining trial',t=>{
  const {db,c}=fixture(t);
  const token=paymentConfirmation(db,c,'999','welcome',START+3600000);
  assert.throws(()=>confirmReceivedPayment(db,c,'404',token,START+3600000),/устарело/);
  assert.throws(()=>confirmReceivedPayment(db,{id:'b',owner_id:'202'},'999',token,START+3600000),/устарело/);
  const s=confirmReceivedPayment(db,c,'999',token,START+3600000);
  assert.equal(s.state,'paid');assert.equal(s.paid_until_ms,addCalendarMonths(START+TRIAL_MS,1));
  assert.equal(confirmReceivedPayment(db,c,'999',token,START+3600001).paid_until_ms,s.paid_until_ms);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_grants').get().n,1);
  assert.equal(db.prepare('SELECT amount_rubles FROM billing_grants').get().amount_rubles,1990);
  assert.equal(reminderFor(db,c,START+TRIAL_MS+1),null);
});
test('Promo ends at the trial deadline and cannot be renewed as a permanent discount',t=>{
  const {db,c}=fixture(t);
  const token=paymentConfirmation(db,c,'999','welcome',START+TRIAL_MS-1000);
  assert.throws(()=>confirmReceivedPayment(db,c,'999',token,START+TRIAL_MS),/устарело/);
  assert.throws(()=>paymentConfirmation(db,c,'999','welcome',START+TRIAL_MS),/48 часов/);
  const full=paymentConfirmation(db,c,'999','month',START+TRIAL_MS);
  const s=confirmReceivedPayment(db,c,'999',full,START+TRIAL_MS);
  assert.equal(s.monthly_price,2490);assert.equal(s.promo_available,false);
});
test('Reminders are per company, suppress inactive notice after upload, prioritize ending and expire correctly',t=>{
  const {db,c}=fixture(t);
  assert.equal(reminderFor(db,c,START+24*3600000-1),null);
  assert.equal(reminderFor(db,c,START+24*3600000).kind,'trial_unused');
  db.prepare("INSERT INTO billing_reminders VALUES('a','trial_unused',?)").run(START+24*3600000);
  assert.equal(reminderFor(db,c,START+25*3600000),null);
  db.prepare("INSERT INTO operations VALUES('b',10000)").run();
  assert.equal(reminderFor(db,{id:'b',owner_id:'202'},START+24*3600000),null);
  assert.equal(reminderFor(db,c,START+46*3600000).kind,'trial_ending');
  db.prepare("INSERT INTO billing_reminders VALUES('a','trial_ending',?)").run(START+46*3600000);
  assert.equal(reminderFor(db,c,START+47*3600000),null);
  assert.equal(reminderFor(db,c,START+48*3600000).kind,'trial_ended');
});
test('Calendar subscriptions clamp month-end and extend from already paid expiry',t=>{
  const {db,c}=fixture(t);
  assert.equal(new Date(addCalendarMonths(Date.parse('2028-01-31T10:00:00Z'),1)).toISOString(),'2028-02-29T10:00:00.000Z');
  const first=paymentConfirmation(db,c,'999','halfyear',START);
  const until=confirmReceivedPayment(db,c,'999',first,START).paid_until_ms;
  const next=paymentConfirmation(db,c,'999','year',START+1000);
  assert.equal(confirmReceivedPayment(db,c,'999',next,START+1000).paid_until_ms,addCalendarMonths(until,12));
});
