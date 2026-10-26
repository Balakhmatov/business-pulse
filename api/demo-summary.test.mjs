import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSummary,withDemoBooks } from '../demo-data.mjs';
const date='2026-10-19';
const sale=(id,amount,financial_basis,quantity_milli=1000)=>({date,id,amount,financial_basis,quantity_milli,item:'Услуга',status:'sale'});
test('Demo separates cash and completed sales and uses the same industry quantities as the app',()=>{
 const d={rows:[sale('a',600,'cash_receipts'),sale('a',1000,'recognized_revenue',2000),sale('b',300,'cash_receipts')]};
 const report=demoSummary(d,'clinic',date);
 assert.equal(report.revenue30_kopecks,90000);
 assert.equal(report.financial_books.recognized_revenue.amount30_kopecks,100000);
 assert.equal(report.volume.value,2);
 assert.equal(report.unpaid_customer_debt_available,false);
 assert.equal(demoSummary(d,'clinic',date,'recognized_revenue').revenue30_kopecks,100000);
 assert.equal(demoSummary(d,'cafe',date).volume.value,2);
});
test('Unknown imported amounts stay outside both books; missing quantities are not invented',()=>{
 const unknown=demoSummary({rows:[sale('a',500,undefined)]},'store',date);
 assert.equal(unknown.primary_basis,'unverified');
 assert.equal(unknown.financial_books.cash_receipts.available,false);
 assert.equal(unknown.financial_books.recognized_revenue.available,false);
 const missing=demoSummary({rows:[sale('a',500,'recognized_revenue',null)]},'store',date);
 assert.equal(missing.volume.value,null);
});
test('Synthetic demo books retain refunds and quantities in separate streams',()=>{
 const rows=withDemoBooks([{...sale('a',-500,null,2000),status:'refund'}]);
 const r=demoSummary({rows},'store',date);
 assert.equal(r.financial_books.recognized_revenue.amount30_kopecks,-50000);
 assert.equal(r.volume.value,-2);
 assert.equal(rows.length,2);
});

test('Demo analysis links changes to operation count and average and updates with financial basis',async()=>{
 const {demoAnalysis}=await import('../demo-data.mjs');const rows=[];
 for(let i=0;i<60;i++){
  const day=new Date(Date.parse('2026-10-19T12:00:00Z')-i*86400000).toISOString().slice(0,10);
  for(const basis of ['cash_receipts','recognized_revenue'])rows.push({...sale('id'+i,basis==='cash_receipts'?(i<30?112:100):200,basis),date:day});
 }
 const d={rows},cash=demoSummary(d,'cafe',date),done=demoSummary(d,'cafe',date,'recognized_revenue');
 const analysis=demoAnalysis(d,cash);
 assert.match(analysis.summary,/12,0%/);
 assert.match(analysis.cards[0].explanation,/Число операций изменилось на 0,0%/);
 assert.match(analysis.cards[0].explanation,/средний чек — на \+12,0%/);
 assert.match(demoAnalysis(d,done).cards[0].evidence,/0,0%/);
 assert.notEqual(analysis.summary,demoAnalysis(d,done).summary);
});
test('Demo analysis with incomplete history avoids invented comparisons; unknown amounts have no financial conclusions',async()=>{
 const {demoAnalysis}=await import('../demo-data.mjs');
 const d={rows:[sale('a',100,'cash_receipts')]};
 const a=demoAnalysis(d,demoSummary(d,'cafe',date));
 assert.match(a.cards[0].title,/нужна история/);
 assert.doesNotMatch(a.summary,/Изменение к прошлому периоду/);
 const unknown={rows:[sale('a',100,undefined)]};
 assert.deepEqual(demoAnalysis(unknown,demoSummary(unknown,'cafe',date)).cards,[]);
});

test('Public demo offers 7, 30 and 90 days of complete reporting and period-aware narratives',async()=>{
  const {demoAnalysis}=await import('../demo-data.mjs');
  const end='2026-10-19',rows=[];
  for(let i=0;i<180;i++){
    const date=new Date(Date.parse(end+'T00:00:00Z')-i*86400000).toISOString().slice(0,10);
    rows.push({...sale('order-'+i,i<90?120:100,'cash_receipts'),date});
  }
  const d={rows};
  const lastWeek=demoSummary(d,'cafe',end,null,7);
  const lastMonth=demoSummary(d,'cafe',end,null,30);
  const threeMonths=demoSummary(d,'cafe',end,null,90);
  assert.equal(lastWeek.period.days,7);
  assert.equal(lastWeek.chart7.length,7);
  assert.equal(lastMonth.period.days,30);
  assert.equal(threeMonths.period.days,90);
  assert.equal(threeMonths.chart7.length,13);
  assert.equal(threeMonths.chart_granularity,'week');
  assert.equal(threeMonths.revenue30_kopecks,1080000);
  assert.equal(threeMonths.previous30_kopecks,900000);
  assert.equal(threeMonths.change_percent,20);
  assert.equal(threeMonths.chart7.reduce((sum,x)=>sum+x.amount_kopecks,0),1080000);
  const narrative=demoAnalysis(d,threeMonths);
  assert.match(narrative.summary,/90 дней/);
  assert.match(narrative.cards[0].evidence,/20,0%/);
  assert.throws(()=>demoSummary(d,'cafe',end,null,91),/90 дней/);
});
