import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateFinancialSummary} from './finance-summary.mjs';

const END='2026-10-17';
const entry=(basis,id,amount,date='2026-10-16',item='Тестовая услуга',status='sale')=>
  ({financial_basis:basis,source_id:id,amount_kopecks:amount,sold_on:date,item,status});
test('Paid and fulfilled purchase is one row counted in both available books, without summing them',()=>{
  const row={...entry('paid_fulfilled','check-1',120000),quantity_milli:2000};
  const r=calculateFinancialSummary([row],{paid_fulfilled:1},END,null,'store');
  assert.equal(r.primary_basis,'cash_receipts');
  assert.equal(r.financial_books.cash_receipts.available,true);
  assert.equal(r.financial_books.recognized_revenue.available,true);
  assert.equal(r.financial_books.cash_receipts.amount30_kopecks,120000);
  assert.equal(r.financial_books.recognized_revenue.amount30_kopecks,120000);
  assert.equal(r.revenue30_kopecks,120000);
  assert.equal(r.volume.value,2);
  assert.equal(r.financial_books.unverified.available,false);
  const switchView=calculateFinancialSummary([row],{paid_fulfilled:1},END,'recognized_revenue','store');
  assert.equal(switchView.primary_basis,'recognized_revenue');
  assert.equal(switchView.revenue30_kopecks,120000);
});
test('Simultaneous receipts are additive only within their own book, never treated as two operations',()=>{
  const rows=[
    entry('paid_fulfilled','a',100000),
    entry('cash_receipts','advance',20000),
    entry('recognized_revenue','unpaid-sale',30000)
  ];
  const r=calculateFinancialSummary(rows,{paid_fulfilled:1,cash_receipts:1,recognized_revenue:1},END);
  assert.equal(r.financial_books.cash_receipts.amount30_kopecks,120000);
  assert.equal(r.financial_books.recognized_revenue.amount30_kopecks,130000);
  assert.equal(r.revenue30_kopecks,120000);
  assert.equal(r.financial_books.cash_receipts.stored_rows,2);
  assert.equal(r.financial_books.recognized_revenue.stored_rows,2);
});

test('Advance is cash collected, not recognized revenue; never add the two financial books',()=>{
  const rows=[
    entry('cash_receipts','advance',200000),
    entry('cash_receipts','final-payment',800000),
    entry('recognized_revenue','performed',800000),
    entry('unverified','legacy',9000000)
  ];
  const r=calculateFinancialSummary(rows,{cash_receipts:2,recognized_revenue:1,unverified:1},END);
  assert.equal(r.primary_basis,'cash_receipts');
  assert.equal(r.revenue30_kopecks,1000000);
  assert.equal(r.financial_books.cash_receipts.amount30_kopecks,1000000);
  assert.equal(r.financial_books.recognized_revenue.amount30_kopecks,800000);
  assert.equal(r.financial_books.unverified.amount30_kopecks,9000000);
  assert.equal(r.financial_books.cash_receipts.receipt_count,2);
  assert.equal(r.financial_books.recognized_revenue.receipt_count,1);
  assert.equal(r.financial_books.recognized_revenue.label,'Продажи (оказанные услуги и проданные товары)');
  assert.equal(r.financial_books.cash_receipts.chart7.at(-2).amount_kopecks,1000000);
});
test('Selecting a second ledger changes its metrics without blending old data',()=>{
  const rows=[
    entry('cash_receipts','A',200000),
    entry('recognized_revenue','B',300000),
    entry('unverified','C',99990000)
  ];
  const counts={cash_receipts:1,recognized_revenue:1,unverified:1};
  const earned=calculateFinancialSummary(rows,counts,END,'recognized_revenue');
  assert.equal(earned.primary_basis,'recognized_revenue');
  assert.equal(earned.revenue30_kopecks,300000);
  const old=calculateFinancialSummary(rows,counts,END,'unverified');
  assert.equal(old.revenue30_kopecks,99990000);
  const unknown=calculateFinancialSummary(rows,counts,END,'not-allowed');
  assert.equal(unknown.primary_basis,'cash_receipts');
});
test('Unverified imported history stays unverified after schema migration',()=>{
  const rows=[entry(undefined,'legacy-payment',110000)];
  const r=calculateFinancialSummary(rows,{unverified:1},END);
  assert.equal(r.primary_basis,'unverified');
  assert.equal(r.financial_books.unverified.available,true);
  assert.equal(r.financial_books.cash_receipts.available,false);
  assert.equal(r.financial_books.recognized_revenue.available,false);
  assert.equal(r.financial_books.cash_receipts.amount30_kopecks,0);
});
test('Cash refunds reduce receipts but do not reduce earned revenue unless source says so',()=>{
  const rows=[
    entry('cash_receipts','cash1',500000),
    entry('cash_receipts','refund1',-100000,'2026-10-16','Тестовая услуга','refund'),
    entry('recognized_revenue','completed',500000)
  ];
  const r=calculateFinancialSummary(rows,{cash_receipts:2,recognized_revenue:1},END);
  assert.equal(r.financial_books.cash_receipts.amount30_kopecks,400000);
  assert.equal(r.financial_books.recognized_revenue.amount30_kopecks,500000);
  assert.equal(r.financial_books.cash_receipts.receipt_count,1);
});
test('Zero operations in current 30 days is not proof of zero business activity',()=>{
  const rows=[entry('recognized_revenue','old',300000,'2026-09-01')];
  const r=calculateFinancialSummary(rows,{recognized_revenue:1},END);
  assert.equal(r.financial_books.recognized_revenue.available,true);
  assert.equal(r.financial_books.recognized_revenue.amount30_kopecks,0);
  assert.equal(r.financial_books.recognized_revenue.coverage.current_days,0);
  assert.equal(r.financial_books.recognized_revenue.change_percent,null);
});

test('Clinic and store count verified quantities, not receipt rows',()=>{
  const r1={...entry('recognized_revenue','visit-1',500000),quantity_milli:2000};
  const r2={...entry('recognized_revenue','visit-1',300000),item:'Injection',quantity_milli:3000};
  const refund={...entry('recognized_revenue','refund-1',-100000,'2026-10-16','Injection','refund'),quantity_milli:1000};
  const clinic=calculateFinancialSummary([r1,r2,refund],{recognized_revenue:3},END,null,'clinic');
  assert.equal(clinic.volume.label,'Оказано услуг');
  assert.equal(clinic.volume.value,4);
  assert.equal(clinic.volume.unit,'шт.');
  assert.equal(clinic.volume.coverage,'complete');
  assert.equal(clinic.financial_books.recognized_revenue.amount30_kopecks,700000);
  const store=calculateFinancialSummary([r1,r2],{recognized_revenue:2},END,null,'store');
  assert.equal(store.volume.label,'Продано товаров');
  assert.equal(store.volume.value,5);
  assert.equal(store.volume.unit,'шт.');
  assert.equal(store.unpaid_customer_debt_kopecks,null);
  assert.equal(store.unpaid_customer_debt_available,false);
});
test('Missing unit count cannot be guessed from line or receipt count',()=>{
  const first={...entry('recognized_revenue','A',200000),quantity_milli:2000};
  const second=entry('recognized_revenue','B',100000);
  const partial=calculateFinancialSummary([first,second],{recognized_revenue:2},END,null,'clinic');
  assert.equal(partial.volume.value,null);
  assert.equal(partial.volume.coverage,'incomplete');
  const legacy=calculateFinancialSummary([second],{recognized_revenue:1},END,null,'store');
  assert.equal(legacy.volume.value,null);
  assert.equal(legacy.volume.coverage,'incomplete');
  assert.equal(legacy.volume.basis,'recognized_revenue');
});
test('Auto jobs are unique order IDs, cafe uses unique paid check IDs',()=>{
  const jobs=[
    {...entry('recognized_revenue','job-1',300000),quantity_milli:1000},
    entry('recognized_revenue','job-1',100000,'2026-10-17','Labor'),
    entry('recognized_revenue','job-2',250000)
  ];
  const auto=calculateFinancialSummary(jobs,{recognized_revenue:3},END,null,'auto');
  assert.equal(auto.volume.value,2);
  assert.equal(auto.volume.label,'Выполнено заказов');
  const checks=[
    entry('cash_receipts','check-A',25000),entry('cash_receipts','check-A',15000,END,'Pastry'),
    entry('cash_receipts','check-B',20000),
    entry('recognized_revenue','done',40000)
  ];
  const cafe=calculateFinancialSummary(checks,{cash_receipts:3,recognized_revenue:1},END,null,'cafe');
  assert.equal(cafe.volume.value,3); // same check ID on different dates counts separately
  assert.equal(cafe.volume.label,'Количество чеков');
  assert.equal(cafe.volume.basis,'cash_receipts');
});
test('Other category counts identifiers in only one ledger, never adds cash and sales or infers debt',()=>{
  const entries=[
    entry('cash_receipts','sale',100000),entry('recognized_revenue','sale',100000),
    entry('unverified','legacy',4000000)
  ];
  const other=calculateFinancialSummary(entries,{cash_receipts:1,recognized_revenue:1,unverified:1},END,null,'other');
  assert.equal(other.volume.value,1);
  assert.equal(other.unpaid_customer_debt_kopecks,null);
  assert.equal(other.financial_books.cash_receipts.amount30_kopecks,100000);
  assert.equal(other.financial_books.recognized_revenue.amount30_kopecks,100000);
  assert.equal(other.financial_books.unverified.amount30_kopecks,4000000);
});

test('Custom 90-day and full-year summaries calculate all dates and equal prior periods',()=>{
  const end='2026-10-17';
  const shift=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  const from=shift(end,-89);
  const entries=[];
  for(let i=0;i<90;i++){
    entries.push(entry('cash_receipts','cur-'+i,15000,shift(from,i)));
    entries.push(entry('cash_receipts','prev-'+i,10000,shift(from,-90+i)));
  }
  const summary=calculateFinancialSummary(entries,{cash_receipts:180},end,null,'cafe',{from,to:end,days:90});
  assert.equal(summary.period.days,90);
  assert.equal(summary.revenue30_kopecks,1350000);
  assert.equal(summary.previous30_kopecks,900000);
  assert.equal(summary.change_percent,50);
  assert.equal(summary.chart_granularity,'week');
  assert.equal(summary.chart7.length,13);
  assert.equal(summary.chart7.reduce((v,x)=>v+x.amount_kopecks,0),summary.revenue30_kopecks);
  const history=calculateFinancialSummary(entries,{cash_receipts:180},end,null,'cafe',{
    from:shift(end,-364),to:end,days:365});
  assert.equal(history.chart_granularity,'month');
  assert.ok(history.chart7.length>=12);
  assert.equal(history.chart7.reduce((v,x)=>v+x.amount_kopecks,0),history.revenue30_kopecks);
});
test('Default summary still has exactly seven daily data points',()=>{
  const r=calculateFinancialSummary([entry('cash_receipts','A',15000)],{cash_receipts:1},END);
  assert.equal(r.period.days,30);
  assert.equal(r.chart7.length,7);
});
