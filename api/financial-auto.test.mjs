import test from 'node:test';
import assert from 'node:assert/strict';
import {inferImportedBasis} from './financial-auto.mjs';
import {buildHistoricalFacts} from './ai-period-facts.mjs';

test('Server classifies explicit received payments and completed services without guessing',()=>{
  assert.equal(inferImportedBasis(['Дата','ID','Сумма оплаты','Статус'],2).basis,'cash_receipts');
  assert.equal(inferImportedBasis(['Дата','Номер визита','Стоимость оказанных услуг'],2).basis,'recognized_revenue');
  assert.equal(inferImportedBasis(['Дата','ID','Сумма','Товар'],2).basis,'unverified');
  assert.equal(inferImportedBasis(['Дата','ID','Выручка','Статус'],2).basis,'unverified');
  assert.equal(inferImportedBasis(['Дата','ID','Начислено','Статус'],2).basis,'unverified');
  assert.equal(inferImportedBasis(['Дата','ID','Сумма предоплаты'],2).basis,'cash_receipts');
  assert.equal(inferImportedBasis(['Дата','ID','Стоимость выполненных работ','Аванс'],2).basis,'unverified');
  assert.equal(inferImportedBasis(['Дата'],2).basis,'unverified');
});

test('3-year analysis contains real monthly/yearly aggregates and no raw receipt IDs',()=>{
  const rows=[
    {sold_on:'2024-07-11',source_id:'SECRET-123',amount_kopecks:100000,status:'sale'},
    {sold_on:'2025-07-11',source_id:'SECRET-456',amount_kopecks:200000,status:'sale'},
    {sold_on:'2026-07-11',source_id:'SECRET-789',amount_kopecks:300000,status:'sale'}
  ];
  const report={period:{from:'2024-01-01',to:'2026-12-30',days:1095,
    previous_from:'2021-01-01',previous_to:'2023-12-31'},change_percent:null};
  const facts=buildHistoricalFacts(report,rows);
  assert.equal(Object.keys(facts).filter(k=>k.startsWith('month_')).length,3);
  assert.match(facts.year_2024,/1.?000 ₽/);
  assert.match(facts.year_2026,/3.?000 ₽/);
  assert.doesNotMatch(JSON.stringify(facts),/SECRET-123|SECRET-456|SECRET-789/);
});
