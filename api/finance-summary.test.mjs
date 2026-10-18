import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateFinancialSummary} from './finance-summary.mjs';

const END='2026-10-17';
const entry=(basis,id,amount,date='2026-10-16',item='Тестовая услуга',status='sale')=>
  ({financial_basis:basis,source_id:id,amount_kopecks:amount,sold_on:date,item,status});
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
  assert.equal(r.financial_books.recognized_revenue.label,'Выручка по выполненным продажам');
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
