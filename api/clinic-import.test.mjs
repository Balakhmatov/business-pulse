import test from 'node:test';
import assert from 'node:assert/strict';
import smart from '../smart-import.js';
import {inferImportedBasis} from './financial-auto.mjs';
import {calculateFinancialSummary} from './finance-summary.mjs';
import {readFileSync} from 'node:fs';
const headers=['дата оказания','Номер визита','наименование услуги','количество','стоимость'];
test('clinic services sheet maps quantity, parses units and reports services separately from payments',()=>{
  const sheet=smart.detect([headers,['2026-10-24','v1','УЗИ','2','3000'],['2026-10-25','v2','Консультация','3','4500']],'Оказанные услуги');
  assert.deepEqual(sheet.mappingGuess,{date:0,id:1,item:2,amount:4,status:-1,quantity:3});
  assert.equal(smart.financialSemantics(headers,sheet.mappingGuess).basis,'reported_revenue');
  assert.equal(inferImportedBasis(headers,4).basis,'recognized_revenue');
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const parse=Function('dayStamp',html.slice(html.indexOf('function parseDate('),html.indexOf('const financialFlagLabels='))+'return parseImported;')(d=>d.toISOString().slice(0,10));
  const parsed=parse(sheet,sheet.mappingGuess);assert.equal(parsed.invalid,0);
  const rows=parsed.rows.map(r=>({...r,sold_on:r.date,source_id:r.id,amount_kopecks:Math.round(r.amount*100),financial_basis:'recognized_revenue'}));
  rows.push({sold_on:'2026-10-25',source_id:'p1',item:'Оплата',amount_kopecks:750000,status:'sale',financial_basis:'cash_receipts',quantity_milli:null});
  const r=calculateFinancialSummary(rows,{recognized_revenue:2,cash_receipts:1},'2026-10-25',null,'clinic');
  assert.equal(r.volume.value,5);
  assert.equal(r.financial_books.recognized_revenue.amount30_kopecks,750000);
  assert.equal(r.financial_books.cash_receipts.amount30_kopecks,750000);
});
test('ambiguous costs and billing, debt, advance or quantity columns stay unverified',()=>{
  for(const label of ['Начислено','К оплате','Цена за единицу','Количество','Задолженность'])
    assert.equal(inferImportedBasis([...headers.slice(0,4),label],4).basis,'unverified');
  assert.equal(inferImportedBasis(['Дата','Номер визита','Услуга','Количество','Стоимость'],4).basis,'unverified');
  assert.equal(inferImportedBasis([...headers,'Аванс'],4).basis,'unverified');
  assert.equal(inferImportedBasis(['Дата оплаты','ID платежа','Сумма оплаты'],2).basis,'cash_receipts');
});
