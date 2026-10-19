import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensurePaymentLinks,checkedPaymentURL,paymentCatalog,savePaymentLink } from './payment-links.mjs';
test('Payment links accept only HTTPS YooKassa hosts; reject credentials, lookalike hosts and active scripts',()=>{
  assert.equal(checkedPaymentURL('https://yoomoney.ru/checkout/payments/test'),'https://yoomoney.ru/checkout/payments/test');
  for(const u of ['javascript:alert(1)','http://yoomoney.ru/pay','https://yoomoney.ru.evil.org/pay','https://yookassa.ru@evil.org/pay','https://user:secret@yookassa.ru/pay','https://evil.org/pay','https://yookassa.ru:444/pay','https://yoomoney.ru/pay#script'])assert.throws(()=>checkedPaymentURL(u));
});
test('Public catalog contains fixed prices and configured links without payment administration data',()=>{
  const db=new DatabaseSync(':memory:');try{
    ensurePaymentLinks(db);ensurePaymentLinks(db);
    assert.equal(paymentCatalog(db).length,4);assert.ok(paymentCatalog(db).every(p=>p.payment_url===null));
    savePaymentLink(db,'year','https://yoomoney.ru/checkout/payments/year','999',1);
    assert.equal(paymentCatalog(db).find(p=>p.id==='year').price,17990);
    assert.equal(paymentCatalog(db).find(p=>p.id==='year').payment_url,'https://yoomoney.ru/checkout/payments/year');
    assert.ok(!JSON.stringify(paymentCatalog(db)).includes('updated_by'));
    assert.throws(()=>savePaymentLink(db,'free','https://yoomoney.ru/pay','999'));
  }finally{db.close();}
});
