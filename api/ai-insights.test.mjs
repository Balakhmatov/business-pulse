import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInsightFacts } from './ai-insights.mjs';

const end='2026-10-25';
const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
function fixture(){
  const rows=[];
  for(let i=179;i>=0;i--){
    const date=shift(end,-i);
    const amount=i<30?70000:180000;
    for(const [item,value] of [['Пицца Пепперони',amount],['Десерт',15000]]){
      rows.push({sold_on:date,source_id:'private-receipt-'+date,
        item,amount_kopecks:value,status:'sale'});
    }
  }
  return rows;
}
test('extended AI facts include six rolling 30-day periods and grounded product decline',()=>{
  const facts=buildInsightFacts({as_of:end,period:{from:shift(end,-29)}},fixture());
  assert.ok(facts.window_1);
  assert.ok(facts.window_6);
  assert.match(facts.product_top_1,/Пицца Пепперони/);
  assert.match(facts.product_decline_1,/Пицца Пепперони/);
  assert.match(facts.receipts_driver,/число чеков/);
  assert.doesNotMatch(JSON.stringify(facts),/private-receipt/);
});
test('AI facts omit phone/email-like item names and missing older periods',()=>{
  const rows=[{sold_on:end,source_id:'secret',item:'person@example.org',
    amount_kopecks:50000,status:'sale'}];
  const facts=buildInsightFacts({as_of:end,period:{from:shift(end,-29)}},rows);
  assert.ok(!Object.keys(facts).some(k=>k.startsWith('window_')));
  assert.doesNotMatch(JSON.stringify(facts),/person@example.org|secret/);
});
