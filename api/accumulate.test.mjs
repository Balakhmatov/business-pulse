import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createAccumulator } from './accumulate.mjs';
// Keep mapping tests in the existing trusted VPS deployment test entrypoint.
import './import-mapping.test.mjs';
import './ai-insights.test.mjs';
import './corrections.test.mjs';
import './finance-summary.test.mjs';
import excel from '../excel-adapter.js';
import smart from '../smart-import.js';
import { calculateFinancialSummary } from './finance-summary.mjs';

test('Downloaded sample identifies received payments and computes net cash after refunds',t=>{
  const server=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
  const source=server.slice(server.indexOf('const sampleCatalog='),server.indexOf('function sendSample('));
  const shift=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  const sample=Function('shift','mskToday',source+'return generateSample;')(shift,()=> '2026-10-26');
  const csv=sample('clinic').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(line=>line.split(';'));
  assert.equal(smart.financialSemantics(csv[0],{amount:3}).basis,'cash_receipts');
  assert.equal(smart.financialSemantics(['Дата','Чек','Услуга','Сумма','Статус'],{amount:3}).basis,'unknown');
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const parserSource=html.slice(html.indexOf('function parseDate('),html.indexOf('const financialFlagLabels='));
  const parse=Function('dayStamp',parserSource+'return parseImported;')(
    date=>date.toISOString().slice(0,10));
  const parsed=parse({headerRow:1,rows:csv.slice(1)},{date:0,id:1,item:2,amount:3,status:4,quantity:-1});
  assert.equal(parsed.invalid,0);
  assert.equal(parsed.rows.length,425);
  const f=makeFixture();t.after(f.close);
  const engine=f.importer();
  const rows=parsed.rows.map(x=>({...x,amount_kopecks:Math.round(x.amount*100)}));
  const input={source:'sample.csv',financial_basis:'cash_receipts'};
  assert.equal(engine.ingest({id:'a'},input,rows).added,425);
  assert.equal(engine.ingest({id:'a'},input,rows).unchanged,425);
  const entries=f.db.prepare('SELECT * FROM operations').all();
  const report=calculateFinancialSummary(entries,{cash_receipts:425},'2026-10-25','cash_receipts','clinic');
  assert.equal(report.revenue30_kopecks,71400000);
  assert.equal(report.financial_books.unverified.stored_rows,0);
});

function makeFixture(){
  const dir=mkdtempSync(path.join(tmpdir(),'bp-accumulate-'));
  const db=new DatabaseSync(path.join(dir,'operations.db'));
  db.exec(
    'PRAGMA foreign_keys=ON;' +
    'CREATE TABLE users(telegram_id TEXT PRIMARY KEY);' +
    'CREATE TABLE companies(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(telegram_id),name TEXT NOT NULL,industry TEXT NOT NULL);' +
    'CREATE TABLE operations(id INTEGER PRIMARY KEY AUTOINCREMENT,company_id TEXT NOT NULL REFERENCES companies(id),sold_on TEXT NOT NULL,source_id TEXT NOT NULL,item TEXT NOT NULL,amount_kopecks INTEGER NOT NULL,status TEXT NOT NULL);' +
    'CREATE TABLE imports(company_id TEXT PRIMARY KEY REFERENCES companies(id),imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,source TEXT NOT NULL,row_count INTEGER NOT NULL);'
  );
  db.prepare('INSERT INTO users VALUES(?)').run('1');
  db.prepare('INSERT INTO users VALUES(?)').run('2');
  db.prepare('INSERT INTO companies VALUES(?,?,?,?)').run('a','1','A','other');
  db.prepare('INSERT INTO companies VALUES(?,?,?,?)').run('b','2','B','other');
  const close=()=>{db.close();rmSync(dir,{recursive:true,force:true});};
  const all=(id='a')=>db.prepare('SELECT sold_on,source_id,item,amount_kopecks,status FROM operations WHERE company_id=? ORDER BY sold_on,id').all(id);
  const amount=(id='a')=>all(id).reduce((sum,row)=>sum+row.amount_kopecks,0);
  const importer=()=>createAccumulator(db);
  const row=(date,id,amount,item='Услуга',status='sale')=>({date,id,item,amount_kopecks:amount,status});
  const run=(engine,rows,source='Синтетический тестовый отчёт',company='a')=>engine.ingest({id:company},{source},rows);
  return {db,close,all,amount,importer,row,run};
}
test('Migrate legacy rows in place without destroying history',t=>{
  const f=makeFixture();t.after(f.close);
  f.db.prepare('INSERT INTO operations(company_id,sold_on,source_id,item,amount_kopecks,status) VALUES(?,?,?,?,?,?)')
    .run('a','2026-10-15','old-1','Услуга',50000,'sale');
  f.db.prepare('INSERT INTO imports(company_id,source,row_count) VALUES(?,?,?)')
    .run('a','Legacy CSV',1);
  const engine=f.importer();
  assert.equal(f.amount(),50000);
  assert.equal(f.all().length,1);
  assert.equal(f.db.prepare('SELECT import_key FROM operations').get().import_key.length,64);
  assert.equal(f.db.prepare('SELECT last_change_at FROM imports').get().last_change_at!==null,true);
  const same=f.run(engine,[f.row('2026-10-15','old-1',50000)]);
  assert.deepEqual([same.added,same.updated,same.unchanged,same.total],[0,0,1,1]);
});
test('Accumulate daily deltas, avoid double count, and correct an existing amount',t=>{
  const f=makeFixture();t.after(f.close);const engine=f.importer();
  const original=[f.row('2026-10-14','r1',10000),f.row('2026-10-15','r2',20000)];
  assert.equal(f.run(engine,original).added,2);
  assert.equal(f.amount(),30000);
  const overlap=[original[1],f.row('2026-10-16','r3',30000)];
  const next=f.run(engine,overlap,'file-2.csv');
  assert.deepEqual([next.added,next.updated,next.unchanged,next.total],[1,0,1,3]);
  assert.equal(f.amount(),60000);
  const repeated=f.run(engine,overlap,'file-2.csv');
  assert.deepEqual([repeated.added,repeated.updated,repeated.unchanged,repeated.total],[0,0,2,3]);
  assert.equal(f.amount(),60000);
  const corrected=f.run(engine,[f.row('2026-10-15','r2',25000)],'corrected.csv');
  assert.deepEqual([corrected.added,corrected.updated,corrected.total],[0,1,3]);
  assert.equal(f.amount(),65000);
  assert.equal(f.db.prepare('SELECT row_count FROM imports WHERE company_id=?').get('a').row_count,1);
  assert.equal(f.importer().ingest({id:'a'},{source:'Again'},[f.row('2026-10-16','r3',30000)]).unchanged,1);
});
test('Refunds are separate operations and company data never mix',t=>{
  const f=makeFixture();t.after(f.close);const engine=f.importer();
  f.run(engine,[f.row('2026-10-15','receipt-X',10000,'Сервис')]);
  f.run(engine,[f.row('2026-10-15','receipt-X',-10000,'Сервис','refund')]);
  f.run(engine,[f.row('2026-10-15','receipt-X',500000,'Сервис')],'shop.csv','b');
  assert.equal(f.amount('a'),0);
  assert.equal(f.all('a').length,2);
  assert.equal(f.amount('b'),500000);
});
test('A failed import is fully rolled back: operations and metadata unchanged',t=>{
  const f=makeFixture();t.after(f.close);const engine=f.importer();
  f.run(engine,[f.row('2026-10-15','safe',15000)]);
  assert.throws(()=>f.run(engine,[
    f.row('2026-10-16','new',9000),f.row('2026-10-17','bad',Symbol('invalid bind'))
  ]),/symbol|type|bind|unsupported|invalid/i);
  assert.equal(f.all().length,1);
  assert.equal(f.amount(),15000);
});

test('Excel table handles dates, blank cells and numeric amounts without changing identity',()=>{
  const matrix=[
    ['Дата','Номер чека','Товар или услуга','Сумма','Статус'],
    [new Date('2026-10-17T00:00:00.000Z'),'00125','УЗИ',3540,'оплата'],
    [null,null,null,null,null],
    ['2026-10-18','00007','Приём',1700,'оплата']
  ];
  const parsed=excel.table(matrix,'import.xlsx');
  assert.equal(parsed.head[0],'Дата');
  assert.equal(parsed.rows.length,2);
  assert.deepEqual(parsed.rows[0],['2026-10-17','00125','УЗИ','3540','оплата']);
  assert.deepEqual(parsed.rows[1],['2026-10-18','00007','Приём','1700','оплата']);
});

test('Excel workbook lets user choose between multiple sheets before importing',async()=>{
  const old=globalThis.readXlsxFile;
  globalThis.readXlsxFile=async (file,options)=>{
    if(options.getSheets)return [{name:'Сводка'},{name:'Продажи'}];
    return options.sheet==='Продажи'
      ? [['Дата','Чек','Сумма'],[new Date('2026-10-17T00:00:00.000Z'),'00001',1500]]
      : [['Дата','Чек'],['2026-10-17','не продажа']];
  };
  try{
    const book=await excel.workbook({name:'multiple.xlsx'});
    assert.deepEqual(book.names,['Сводка','Продажи']);
    const selected=await book.readSheet('Продажи');
    assert.equal(selected.rows[0][1],'00001');
    assert.equal(selected.rows[0][0],'2026-10-17');
    await assert.rejects(()=>book.readSheet('Неизвестный'),/Такого листа/);
  }finally{
    if(old===undefined)delete globalThis.readXlsxFile;
    else globalThis.readXlsxFile=old;
  }
});

test('Excel empty and malformed sheets are refused rather than imported',()=>{
  assert.throws(()=>excel.table([['Дата','Сумма']],'blank.xlsx'),/нет строк/);
  assert.throws(()=>excel.table([['Дата'],['2026-10-17']],'one-column.xlsx'),/меньше двух/);
  assert.equal(excel.text(null),'');
  assert.equal(excel.text(0),'0');
});

test('Smart import finds actual header below title/preamble, maps synonyms, skips totals',()=>{
  const matrix=[
    ['Выгрузка из учетной системы. Отчет 01.10–18.10'],
    ['Подразделение: офис'],[],
    ['Дата закрытия','Код реализации','Номенклатура','Фактически оплачено','Вид движения','Ответственный'],
    ['2026-10-15','R100','МРТ','4500','оплата','Менеджер'],
    ['2026-10-16','R101','УЗИ','2500','оплата','Менеджер'],
    ['Итого','','','7000','','']
  ];
  const info=smart.detect(matrix,'real-export.xlsx');
  assert.equal(info.headerRow,4);
  assert.equal(info.head.length,6);
  assert.equal(info.rows.length,2);
  assert.equal(info.excludedRows,1);
  assert.equal(info.reportType,'operations');
  assert.deepEqual(info.mappingGuess,{date:0,id:1,item:2,amount:3,status:4});
});
test('Smart import handles many extraneous columns and unknown headers using content',()=>{
  const head=['Date X','Receipt X','Service X','Amount X','Status X',...Array.from({length:22},(_,i)=>'Extra '+i)];
  const rows=[
    ['2026-10-15','00012','Стоматология','2500','оплата',...Array(22).fill('abc')],
    ['2026-10-16','00013','Терапевт','3500','возврат',...Array(22).fill('abc')],
    ['2026-10-17','00014','УЗИ','4500','оплата',...Array(22).fill('abc')]
  ];
  const result=smart.detect([head,...rows],'many.csv');
  assert.equal(result.head.length,27);
  assert.equal(result.headerRow,1);
  assert.equal(result.rows.length,3);
  assert.equal(result.mappingGuess.date,0);
  assert.equal(result.mappingGuess.amount,3);
  assert.equal(result.mappingGuess.id,1);
  assert.equal(result.hasManyColumns,true);
});
test('Smart import rejects summary financial reports before any import',()=>{
  const file=smart.detect([
    ['Сводный отчёт по дням'],
    ['Дата','Выручка','Количество чеков'],
    ['2026-10-15','50000','20'],
    ['2026-10-16','46000','18']
  ],'unknown.xlsx');
  assert.equal(file.reportType,'aggregate');
  assert.equal(file.mappingGuess.id,-1);
  assert.ok(file.warnings.some(x=>x.includes('сводный')));
});
test('Smart import refuses single-line report and impossible preamble',()=>{
  assert.throws(()=>smart.detect([['Только заголовок']],'broken.csv'),/нет строк/i);
  assert.throws(()=>smart.detect([['Отчёт'],['Строка']],'broken.xlsx'),/Не удалось найти строку заголовков/);
});

test('Smart import selects actually paid revenue, not unit price or quantity',()=>{
  const file=smart.detect([
    ['Дата','Номер чека','Название','Стоимость','Оплачено','Цена','Количество'],
    ['2026-10-15','001','УЗИ','3000','2850','1500','2'],
    ['2026-10-16','002','Приём','4000','3500','1000','4']
  ],'clinic.xlsx');
  assert.equal(file.reportType,'operations');
  assert.equal(file.mappingGuess.amount,4);
  assert.equal(file.mappingGuess.id,1);
});
test('Smart import must ask a human when multiple equal monetary columns could be revenue',()=>{
  const file=smart.detect([
    ['Дата','Номер чека','Название','Сумма','Стоимость'],
    ['2026-10-15','001','УЗИ','3000','3000'],
    ['2026-10-16','002','Приём','4000','4000']
  ],'report.xlsx');
  assert.equal(file.mappingGuess.amount,-1);
  assert.ok(file.warnings.some(x=>x.includes('Несколько столбцов')));
});

test('Fallback Excel reader recovers explicit blank cells and shorter total row',async()=>{
  const oldReader=globalThis.readXlsxFile;
  const oldExcel=globalThis.ExcelJS;
  const oldSmart=globalThis.BP_SmartImport;
  const names=['Дата закрытия','Код реализации','Номенклатура','Стоимость','Фактически оплачено',
    'Вид движения','Цена за единицу','Количество',...Array.from({length:19},(_,i)=>'Доп. '+i)];
  const matrix=[
    ['Тестовая выгрузка продаж'],
    ['Период 17.10.2026'],[],
    names,
    [new Date('2026-10-17T00:00:00.000Z'),'SMART-101','Первичный приём',3500,3200,'оплата',3500,1,...Array(19).fill('x')],
    [new Date('2026-10-17T00:00:00.000Z'),'SMART-102','УЗИ',2800,2500,'оплата',2800,1,...Array(19).fill('x')],
    [new Date('2026-10-17T00:00:00.000Z'),'SMART-103','Анализы',2000,1500,'оплата',2000,1,...Array(19).fill('x')],
    ['Итого','','',8300,7200]
  ];
  let fallbackLoads=0;
  globalThis.BP_SmartImport=smart;
  globalThis.readXlsxFile=async(_file,opts)=>{
    if(opts.getSheets)return [{name:'Детальные продажи'}];
    throw new TypeError("Cannot read properties of undefined (reading 'trim')");
  };
  globalThis.ExcelJS={
    Workbook:class {
      worksheets=[];
      xlsx={load:async()=>{
        fallbackLoads++;
        this.worksheets=[{
          name:'Детальные продажи',rowCount:matrix.length,columnCount:27,
          getRow:i=>({getCell:j=>({value:matrix[i-1]?.[j-1]??null})})
        }];
      }};
    }
  };
  try{
    const file={name:'business_pulse_smart_import_test.xlsx',arrayBuffer:async()=>new ArrayBuffer(8)};
    const workbook=await excel.workbook(file);
    const report=await workbook.readSheet('Детальные продажи');
    assert.equal(report.headerRow,4);
    assert.equal(report.head.length,27);
    assert.equal(report.rows.length,3);
    assert.equal(report.mappingGuess.amount,4);
    assert.equal(report.excludedRows,1);
    assert.equal(report.rows.map(x=>Number(x[4])).reduce((a,b)=>a+b,0),7200);
    // Once a damaged sheet switched to fallback, parse the file only once.
    await workbook.readSheet('Детальные продажи');
    assert.equal(fallbackLoads,1);
  }finally{
    if(oldReader===undefined)delete globalThis.readXlsxFile;else globalThis.readXlsxFile=oldReader;
    if(oldExcel===undefined)delete globalThis.ExcelJS;else globalThis.ExcelJS=oldExcel;
    if(oldSmart===undefined)delete globalThis.BP_SmartImport;else globalThis.BP_SmartImport=oldSmart;
  }
});

test('Financial semantics distinguishes collected cash from accrual and debt',()=>{
  const heads=['Дата закрытия','Код реализации','Номенклатура','Начислено по прайсу','Факт поступления денег','Событие'];
  const cash=smart.financialSemantics(heads,{date:0,id:1,item:2,amount:4,status:5});
  assert.equal(cash.basis,'cash_receipts');
  assert.equal(cash.blocksImport,false);
  const accrual=smart.financialSemantics(heads,{date:0,id:1,item:2,amount:3,status:5});
  assert.equal(accrual.basis,'accrual');
  assert.equal(accrual.blocksImport,true);
  const debt=smart.financialSemantics(['Дата','ID','Дебиторская задолженность'],{date:0,id:1,amount:2});
  assert.equal(debt.blocksImport,true);
});
test('Financial semantics blocks prepayments, tax and unit prices as transaction revenue',()=>{
  for(const label of ['Аванс клиента','Предоплата','НДС сумма','Цена за единицу','Сумма долга']){
    const info=smart.financialSemantics(['Дата','Чек',label],{date:0,id:1,amount:2});
    assert.equal(info.blocksImport,true,'Expected block: '+label);
  }
});
test('Financial semantics requires explicit confirmation on mixed payments, advances, refunds',()=>{
  const head=['Дата','Чек','Оплачено','Сумма предоплаты','Частично оплачено','Возврат'];
  const x=smart.financialSemantics(head,{date:0,id:1,amount:2,status:5});
  assert.equal(x.basis,'cash_receipts');
  assert.equal(x.blocksImport,false);
  assert.equal(x.requiresConfirmation,true);
  assert.ok(x.flags.includes('advance_present'));
  assert.ok(x.flags.includes('partial_present'));
  assert.ok(x.flags.includes('refund_present'));
});
test('Normal existing CSV import is still allowed without forcing financial checkbox',()=>{
  const info=smart.financialSemantics(['Дата','Номер чека','Товар или услуга','Сумма','Статус'],
      {date:0,id:1,item:2,amount:3,status:4});
  assert.equal(info.blocksImport,false);
  assert.equal(info.requiresConfirmation,false);
});


test('Previously AI-only ledger export now identifies actual paid amount and stable ledger row ID locally',()=>{
  const matrix=[
    ['Синтетическая выгрузка'],[],
    ['Дата фиксации','№ записи журнала','Предмет выполнения',
      'Начислено по прайсу','Факт поступления денег','Событие',
      'Кол-во единиц','Скидка','Точка','Маркер группы','Метод расчёта','Программа'],
    ['2026-10-17','LEDGER-AI-101','Консультация',2500,2100,'Продажа',1,400,'Основная','Тест','Карта','Демонстрация'],
    ['2026-10-17','LEDGER-AI-102','УЗИ',4700,4300,'Продажа',1,400,'Основная','Тест','Карта','Демонстрация'],
    ['2026-10-17','LEDGER-AI-103','Анализы',1800,1500,'Продажа',1,300,'Основная','Тест','Карта','Демонстрация'],
    ['Итого','','',9000,7900]
  ];
  const result=smart.detect(matrix,'unusual.xlsx');
  assert.deepEqual(result.mappingGuess,{date:0,id:1,item:2,amount:4,status:5});
  assert.equal(result.rows.length,3);
  assert.equal(result.rows.reduce((sum,row)=>sum+Number(row[result.mappingGuess.amount]),0),7900);
  assert.equal(result.excludedRows,1);
  assert.equal(smart.financialSemantics(result.head,result.mappingGuess).basis,'cash_receipts');
});


test('Ordinary paid transactions never require an extra confirmation for generic AI caveats',()=>{
  const local=smart.financialSemantics(
    ['Дата фиксации','№ записи журнала','Предмет выполнения',
      'Начислено по прайсу','Факт поступления денег','Событие'],
    {date:0,id:1,item:2,amount:4,status:5});
  assert.equal(local.blocksImport,false);
  assert.equal(local.requiresConfirmation,false);
  for(const ai of [
    {basis:'cash_receipts',confidence:'high',risk_flags:[]},
    {basis:'cash_receipts',confidence:'medium',risk_flags:['refunds','tax_or_vat','status_uncertain','accruals']},
    {basis:'unknown',confidence:'low',risk_flags:[]}
  ]){
    const review=smart.financialConfirmation(local,ai);
    assert.equal(review.blocked,false);
    assert.equal(review.needsConfirm,false,'No extra confirmation for '+ai.basis);
  }
});

test('A mere refund or tax header is an informational notice, not a blocking checkbox',()=>{
  const local=smart.financialSemantics(
    ['Дата','Чек','Оплачено','Статус возврата','НДС'],
    {date:0,id:1,amount:2,status:3});
  assert.equal(local.requiresConfirmation,false);
  assert.equal(smart.financialConfirmation(local,{
    basis:'cash_receipts',risk_flags:['refunds','tax_or_vat']
  }).needsConfirm,false);
});

test('Confirmed financial risks still require acknowledgment',()=>{
  const local=smart.financialSemantics(
    ['Дата','Чек','Оплачено','Сумма аванса','Частичная оплата'],
    {date:0,id:1,amount:2});
  assert.equal(local.blocksImport,false);
  assert.equal(local.requiresConfirmation,true);
  assert.equal(smart.financialConfirmation(local,{
    basis:'cash_receipts',risk_flags:[]
  }).needsConfirm,true);
  const plain=smart.financialSemantics(['Дата','Чек','Оплачено'],{amount:2});
  for(const ai of [
    {basis:'cash_receipts',risk_flags:['prepayments']},
    {basis:'cash_receipts',risk_flags:['partial_payments']},
    {basis:'cash_receipts',risk_flags:['double_counting']},
    {basis:'mixed',risk_flags:[]}
  ]){
    assert.equal(smart.financialConfirmation(plain,ai).needsConfirm,true,
      'Material risk should require confirmation: '+JSON.stringify(ai));
  }
});

test('Hard financial blocks cannot be bypassed by model suggestions',()=>{
  const local=smart.financialSemantics(
    ['Дата','Чек','Аванс клиента'],{date:0,id:1,amount:2});
  const decision=smart.financialConfirmation(local,{
    basis:'cash_receipts',risk_flags:[]
  });
  assert.equal(decision.blocked,true);
  assert.equal(decision.needsConfirm,false);
});


test('Import history keeps scoped batch statistics and rollback restores original operations',t=>{
  const f=makeFixture();t.after(f.close);const engine=f.importer();
  const first=f.run(engine,[f.row('2026-10-13','R1',10000)],'first.xlsx');
  const second=f.run(engine,[
    f.row('2026-10-13','R1',15000),
    f.row('2026-10-14','R2',20000)
  ],'corrected.xlsx');
  assert.equal(f.amount(),35000);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM import_batch_changes').get().n,3);
  const entries=engine.history({id:'a'});
  assert.equal(entries.length,2);
  assert.equal(entries[0].source,'corrected.xlsx');
  assert.deepEqual([entries[0].added,entries[0].updated,entries[0].unchanged],[1,1,0]);
  assert.equal(entries[0].can_undo,true);
  assert.equal(entries[1].can_undo,false);
  assert.equal(engine.history({id:'b'}).length,0);
  const undone=engine.undoLatest({id:'a'},second.batch_id);
  assert.deepEqual([undone.removed,undone.restored,undone.total],[1,1,1]);
  assert.equal(f.amount(),10000);
  assert.equal(f.db.prepare('SELECT source FROM imports WHERE company_id=?').get('a').source,'first.xlsx');
  const entriesAfter=engine.history({id:'a'});
  assert.equal(entriesAfter[0].undone,true);
  assert.equal(entriesAfter[1].can_undo,true);
  assert.equal(engine.undoLatest({id:'a'},first.batch_id).total,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM imports WHERE company_id=?').get('a').n,0);
});
test('Undo is rejected for a nonlatest batch, other company, wrong ID and repeated undo',t=>{
  const f=makeFixture();t.after(f.close);const engine=f.importer();
  const one=f.run(engine,[f.row('2026-10-13','R1',10000)],'first.csv');
  const two=f.run(engine,[f.row('2026-10-14','R2',20000)],'second.csv');
  const amt=f.amount();
  assert.throws(()=>engine.undoLatest({id:'a'},one.batch_id),/последнюю/i);
  assert.throws(()=>engine.undoLatest({id:'b'},two.batch_id),/последнюю/i);
  assert.throws(()=>engine.undoLatest({id:'a'},-1),/номер/i);
  assert.equal(f.amount(),amt);
  engine.undoLatest({id:'a'},two.batch_id);
  assert.throws(()=>engine.undoLatest({id:'a'},two.batch_id),/последнюю/i);
});
test('Undo removes only the latest newly added transactions; unchanged rows are not deleted',t=>{
  const f=makeFixture();t.after(f.close);const engine=f.importer();
  f.run(engine,[f.row('2026-10-13','A',10000)],'a.csv');
  const delta=f.run(engine,[
    f.row('2026-10-13','A',10000),
    f.row('2026-10-14','B',20000),
  ],'b.csv');
  assert.equal(delta.unchanged,1);
  assert.equal(delta.added,1);
  engine.undoLatest({id:'a'},delta.batch_id);
  assert.equal(f.amount(),10000);
  assert.equal(f.all().length,1);
});
test('Undo fails atomically if a changed operation no longer matches its recorded amount',t=>{
  const f=makeFixture();t.after(f.close);const engine=f.importer();
  const batch=f.run(engine,[
    f.row('2026-10-13','A',10000),
    f.row('2026-10-14','B',20000)
  ],'bad.csv');
  f.db.prepare('UPDATE operations SET amount_kopecks=? WHERE source_id=?').run(25000,'B');
  assert.throws(()=>engine.undoLatest({id:'a'},batch.batch_id),/изменились/i);
  assert.equal(f.all().length,2);
  assert.equal(f.amount(),35000);
  assert.equal(engine.history({id:'a'})[0].undone,false);
});


test('UI parser must never silently drop malformed financial rows',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const start=html.indexOf('function parseDate(');
  const end=html.indexOf('const financialFlagLabels=',start);
  assert.ok(start>=0&&end>start,'Import parser exists in Mini App');
  const parseImported=Function('dayStamp',html.slice(start,end)+'return parseImported;')(
    date=>date.toISOString().slice(0,10));
  const parsed=parseImported({
    headerRow:4,head:['Дата','Чек','Сумма','Статус'],
    rows:[
      ['2026-10-17','A','1700','оплата'],
      ['2026-10-17','B','Ошибка 2500','оплата'],
      ['2026-10-17','','900','оплата'],
      ['2026-10-17','C','','отмена'],
      ['2026-10-17','D','2000','ожидание']
    ]
  },{date:0,id:1,amount:2,status:3,item:-1});
  assert.equal(parsed.rows.length,1);
  assert.equal(parsed.invalid,2);
  assert.equal(parsed.cancelled,1);
  assert.equal(parsed.skipped,2);
  assert.match(parsed.invalidExamples.join(' '),/строка 6.*строка 7/);
});
test('UI parser accepts a complete CSV with multiple currency formats and zero errors',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const source=html.slice(html.indexOf('function parseDate('),html.indexOf('const financialFlagLabels='));
  const parseImported=Function('dayStamp',source+'return parseImported;')(
    date=>date.toISOString().slice(0,10));
  const parsed=parseImported({headerRow:1,rows:[
    ['2026-10-17','A','1 500 ₽','оплата'],
    ['2026-10-18','B','2 350,50','оплата'],
  ]},{date:0,id:1,amount:2,status:3,item:-1});
  assert.equal(parsed.invalid,0);
  assert.equal(parsed.cancelled,0);
  assert.deepEqual(parsed.rows.map(r=>r.amount),[1500,2350.5]);
  const format=Function('dayStamp',source+'return parseAmount;')(date=>date.toISOString().slice(0,10));
  assert.equal(format('1,234'),null);
  assert.equal(format('1.234'),null);
  assert.equal(format('1,234,567'),1234567);
});

test('Verified cash and earned revenue imports with identical source IDs remain isolated and reversible',t=>{
  const f=makeFixture();t.after(f.close);
  const engine=f.importer();
  const cash=engine.ingest({id:'a'},{
    source:'cash.csv',financial_basis:'cash_receipts'
  },[f.row('2026-10-16','same-ID',100000)]);
  const earned=engine.ingest({id:'a'},{
    source:'performed.xlsx',financial_basis:'recognized_revenue'
  },[f.row('2026-10-16','same-ID',80000)]);
  assert.equal(cash.added,1);
  assert.equal(cash.book_total,1);
  assert.equal(earned.added,1);
  assert.equal(earned.book_total,1);
  const actual=f.db.prepare(
    'SELECT financial_basis,amount_kopecks FROM operations WHERE company_id=? ORDER BY financial_basis'
  ).all('a').map(row=>({...row}));
  assert.deepEqual(actual,[
    {financial_basis:'cash_receipts',amount_kopecks:100000},
    {financial_basis:'recognized_revenue',amount_kopecks:80000}
  ]);
  const duplicate=engine.ingest({id:'a'},{
    source:'cash-repeated.csv',financial_basis:'cash_receipts'
  },[f.row('2026-10-16','same-ID',100000)]);
  assert.equal(duplicate.unchanged,1);
  assert.equal(duplicate.added,0);
  assert.equal(engine.history({id:'a'})[0].financial_basis,'cash_receipts');
  engine.undoLatest({id:'a'},duplicate.batch_id);
  engine.undoLatest({id:'a'},earned.batch_id);
  assert.deepEqual(f.db.prepare(
    'SELECT financial_basis,amount_kopecks FROM operations WHERE company_id=?'
  ).all('a').map(row=>({...row})),[{financial_basis:'cash_receipts',amount_kopecks:100000}]);
});

test('Legacy operations are unverified and retain their exact identity after finance migration',t=>{
  const f=makeFixture();t.after(f.close);
  const engine=f.importer();
  f.run(engine,[f.row('2026-10-16','old-key',250000)]);
  const first=f.db.prepare(
    'SELECT import_key,financial_basis FROM operations WHERE source_id=?'
  ).get('old-key');
  assert.equal(first.financial_basis,'unverified');
  const restarted=f.importer();
  assert.equal(f.db.prepare('SELECT import_key FROM operations').get().import_key,first.import_key);
  const again=f.run(restarted,[f.row('2026-10-16','old-key',250000)]);
  assert.equal(again.unchanged,1);
  assert.equal(again.added,0);
  assert.throws(()=>restarted.ingest({id:'a'},{
    source:'bad.xlsx',financial_basis:'magical_revenue'
  },[f.row('2026-10-16','old-key',250000)]),/тип финансовых данных/i);
  assert.equal(f.all().length,1);
});

test('A performed-service Excel with Russian ID операции auto-maps and saves 8,000 RUB earned revenue',t=>{
  const columns=['Дата оказания услуги','ID операции','Оказанная услуга','Выручка по оказанным услугам','Статус'];
  const values=['2026-10-17','BP-FIN-REV-001','Оказанная услуга','8000','Оказано'];
  const d=smart.detect([columns,values],'business_pulse_test_revenue_8000.xlsx');
  assert.deepEqual(d.mappingGuess,{date:0,id:1,item:2,amount:3,status:4});
  assert.equal(smart.financialSemantics(columns,d.mappingGuess).basis,'reported_revenue');
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const source=html.slice(html.indexOf('function parseDate('),html.indexOf('const financialFlagLabels='));
  const parseImported=Function('dayStamp',source+'return parseImported;')(
    date=>date.toISOString().slice(0,10));
  const parsed=parseImported(d,d.mappingGuess);
  assert.equal(parsed.invalid,0);
  assert.equal(parsed.cancelled,0);
  assert.deepEqual(parsed.rows,[{
    date:'2026-10-17',id:'BP-FIN-REV-001',
    item:'Оказанная услуга',amount:8000,status:'sale'
  }]);
  const f=makeFixture();t.after(f.close);const engine=f.importer();
  const imported=engine.ingest({id:'a'},{
    source:'business_pulse_test_revenue_8000.xlsx',financial_basis:'recognized_revenue'
  },parsed.rows.map(x=>({...x,amount_kopecks:Math.round(x.amount*100)})));
  assert.equal(imported.added,1);
  assert.equal(imported.book_total,1);
  assert.equal(f.db.prepare(
    'SELECT financial_basis,amount_kopecks FROM operations WHERE source_id=?'
  ).get('BP-FIN-REV-001').financial_basis,'recognized_revenue');
  assert.equal(f.amount(),800000);
});
test('ID операции is recognized but ID клиента and ID товара cannot replace receipt identity',()=>{
  const cols=['Дата','ID клиента','ID товара','Номер чека','Сумма','Статус'];
  const sample=['2026-10-17','customer-1','SKU-1','BP-ORDER-777','8000','Оплачено'];
  const mapping=smart.detect([cols,sample],'transactions.xlsx').mappingGuess;
  assert.equal(mapping.id,3);
  assert.equal(mapping.amount,4);
});


test('Owner-facing interface uses clear Payments and Sales terminology, keeping source accounting types intact',()=>{
  const personal=readFileSync(new URL('../personal.js',import.meta.url),'utf8');
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.match(personal,/recognized_revenue:'Продажи'/);
  assert.match(personal,/clinic:\{paid:'Оплачено пациентами',done:'Оказано услуг на сумму'/);
  assert.match(personal,/store:\{paid:'Оплачено покупателями',done:'Продано товаров на сумму'/);
  assert.match(personal,/industryMoneyLabels/);
  assert.match(personal,/Полученные деньги \(включая авансы\)/);
  assert.match(personal,/Просто выставленные счета и авансы за будущие услуги не включены/);
  assert.match(personal,/Нужно уточнить данные/);
  assert.match(personal,/Не оплачено клиентами: нет данных для расчёта/);
  assert.doesNotMatch(personal,/Выручка за 30 дней/);
  assert.match(html,/const positiveLabel=selectedBook==='recognized_revenue'\?'Продажа'/);
  assert.match(html,/selectedBook==='cash_receipts'\?'Оплата':'Операция'/);
  assert.match(html,/Пока не с чем сравнить/);
  assert.match(html,/Что означают суммы в этом столбце/);
});

test('Optional quantity column is parsed and imported, missing entries stay unknown',t=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const source=html.slice(html.indexOf('function parseDate('),html.indexOf('const financialFlagLabels='));
  const parser=Function('dayStamp',source+'return parseImported;')(
    date=>date.toISOString().slice(0,10));
  const header=['Дата','Номер чека','Товар или услуга','Сумма','Статус','Количество'];
  const detected=smart.detect([header,
    ['2026-10-17','visit-1','Уколы','2000','оказано','3'],
    ['2026-10-17','visit-2','Осмотр','1000','оказано','2,5']
  ],'clinic.xlsx');
  const values={...detected.mappingGuess,quantity:5};
  const parsed=parser(detected,values);
  assert.equal(parsed.invalid,0);
  assert.deepEqual(parsed.rows.map(x=>x.quantity_milli),[3000,2500]);
  const f=makeFixture();t.after(f.close);
  const engine=f.importer();
  const rows=parsed.rows.map(x=>({...x,amount_kopecks:Math.round(x.amount*100)}));
  const added=engine.ingest({id:'a'},{source:'clinic.xlsx',financial_basis:'recognized_revenue'},rows);
  assert.equal(added.added,2);
  assert.deepEqual(f.db.prepare(
    'SELECT quantity_milli FROM operations ORDER BY source_id'
  ).all().map(x=>x.quantity_milli),[3000,2500]);
  const invalid=parser({headerRow:1,rows:[['2026-10-17','bad','Уколы','2000','оказано','три']]},values);
  assert.equal(invalid.invalid,1);
});
test('Unit quantity corrections with unchanged amounts are reversible; legacy absent quantities remain null',t=>{
  const f=makeFixture();t.after(f.close);
  const engine=f.importer();
  const first={...f.row('2026-10-16','invoice-1',10000),quantity_milli:2000};
  const a=engine.ingest({id:'a'},{source:'a.xlsx',financial_basis:'recognized_revenue'},[first]);
  assert.equal(a.added,1);
  const changed={...first,quantity_milli:5000};
  const batch=engine.ingest({id:'a'},{source:'b.xlsx',financial_basis:'recognized_revenue'},[changed]);
  assert.equal(batch.updated,1);
  assert.equal(f.db.prepare('SELECT quantity_milli FROM operations').get().quantity_milli,5000);
  engine.undoLatest({id:'a'},batch.batch_id);
  assert.equal(f.db.prepare('SELECT quantity_milli FROM operations').get().quantity_milli,2000);
  const other=engine.ingest({id:'a'},{source:'no-qty.xlsx',financial_basis:'recognized_revenue'},[
    f.row('2026-10-17','invoice-2',20000)]);
  assert.equal(other.added,1);
  assert.equal(f.db.prepare('SELECT quantity_milli FROM operations WHERE source_id=?').get('invoice-2').quantity_milli,null);
  engine.undoLatest({id:'a'},other.batch_id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n,1);
});

