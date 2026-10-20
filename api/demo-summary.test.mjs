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
