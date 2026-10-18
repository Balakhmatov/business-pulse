import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createAccumulator } from './accumulate.mjs';
// Keep mapping tests in the existing trusted VPS deployment test entrypoint.
import './import-mapping.test.mjs';
import excel from '../excel-adapter.js';
import smart from '../smart-import.js';

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
