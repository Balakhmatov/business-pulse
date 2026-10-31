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

test('clinic export keeps zero-price services, treats VisitID=0 as missing, and avoids repeated visit totals',()=>{
  const headers=['VisitID','PatientID','Пол','Дата рождения','Полных лет','Дата создания записи',
    'Дата визита','Специальность','Дата создания услуги','Услуга',
    'Стоимость услуги по факту оплаты','Статус визита','Источник обращения',
    'Канал','Кампания','Согласие на коммуникацию','Сумма визита'];
  const line=(visit,patient,item,amount,total)=>{
    const values=Array(headers.length).fill('');
    values[0]=visit;values[1]=patient;values[8]='15.07.2026';
    values[9]=item;values[10]=amount;values[16]=total;
    return values;
  };
  const table=smart.detect([headers,
    line('0','patient-a','Осмотр',0,0),
    line('0','patient-b','УЗИ',1800,1800),
    line('298943','patient-c','Анестезия',330,4560),
    line('298943','patient-c','Лечение',4230,4560)],'Клиника');
  assert.equal(table.mappingGuess.amount,10,'service-level sum should be preferred over visit total');
  assert.equal(table.mappingGuess.customer,1);
  const chosen={date:8,id:0,item:9,amount:10,status:11,customer:1,quantity:-1};
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const parserSource=html.slice(html.indexOf('function parseDate('),html.indexOf('const financialFlagLabels='));
  const parser=Function('dayStamp','window',parserSource+'return parseImported;')(
    date=>date.toISOString().slice(0,10),{BP_SmartImport:smart});
  const parsed=parser(table,chosen);
  assert.equal(parsed.invalid,0);
  assert.equal(parsed.rows.length,4);
  assert.equal(parsed.rows[0].amount,0);
  assert.equal(parsed.rows[0].synthetic_id,true);
  assert.equal(parsed.rows[1].synthetic_id,true);
  assert.equal(parsed.rows[0].customer_ref,'patient-a');
  assert.equal(parsed.rows[1].customer_ref,'patient-b');
  assert.equal(parsed.rows[2].id,'298943');
  assert.equal(parsed.rows.reduce((sum,row)=>sum+row.amount,0),6360);
  assert.equal(smart.financialSemantics(headers,{...chosen,amount:16}).blocksImport,true);
  assert.equal(smart.financialSemantics(headers,chosen).basis,'cash_receipts');
  assert.equal(inferImportedBasis(headers,10).basis,'cash_receipts');
});

test('Long medical service labels from spreadsheets are kept intact by the parser',()=>{
  const longName='Медицинская услуга с подробным описанием состава обследования и перечнем контрольных диагностических действий. '.repeat(3).trim();
  assert.ok(longName.length>270&&longName.length<512);
  const file=smart.detect([
    ['Дата оказания','Номер визита','Наименование услуги','Стоимость'],
    ['2026-10-25','S-1',longName,'0']
  ],'medical-services.xlsx');
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const parser=Function('dayStamp',html.slice(html.indexOf('function parseDate('),html.indexOf('const financialFlagLabels='))+'return parseImported;')(
    date=>date.toISOString().slice(0,10));
  const mapped={date:0,id:1,item:2,amount:3,status:-1,quantity:-1};
  const result=parser(file,mapped);
  assert.equal(result.invalid,0);
  assert.equal(result.rows[0].item,longName);
  assert.equal(result.rows[0].amount,0);
});
