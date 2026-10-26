import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import smart from '../smart-import.js';
import {createCustomerIdentity,calculateCustomerAnalytics} from './customer-analytics.mjs';
import {createAccumulator} from './accumulate.mjs';
import {createImportMapper} from './import-mapping.mjs';
import {calculateFinancialSummary} from './finance-summary.mjs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const personal=readFileSync(new URL('../personal.js',import.meta.url),'utf8');
const parse=Function('dayStamp','window',html.slice(html.indexOf('function parseDate('),html.indexOf('const financialFlagLabels='))+'return parseImported;')(d=>d.toISOString().slice(0,10),{BP_SmartImport:smart});
const mappingStart=personal.indexOf('const occurrenceCounts=new Map();');
const mappingEnd=personal.indexOf('if(rows.some(',mappingStart);
const payload=Function('result','window',personal.slice(mappingStart,mappingEnd)+'return rows;');
const convert=rows=>payload({rows},{BP_SmartImport:smart});
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id TEXT PRIMARY KEY);
 CREATE TABLE operations(id INTEGER PRIMARY KEY,company_id TEXT,sold_on TEXT,source_id TEXT,item TEXT,amount_kopecks INTEGER,status TEXT);
 CREATE TABLE imports(company_id TEXT PRIMARY KEY,source TEXT,row_count INTEGER,imported_at TEXT DEFAULT CURRENT_TIMESTAMP);
 INSERT INTO companies VALUES('a'),('b');`);
 const identity=createCustomerIdentity(db);
 const engine=createAccumulator(db,{customerKeyFor:(c,r)=>identity.key(c.id,r.customer_ref,r.customer_ref_kind)});
 return {db,identity,engine,ingest:(rows,source='clinic.xlsx')=>engine.ingest({id:'a'},{source,financial_basis:'unverified'},rows),rows:()=>db.prepare('SELECT * FROM operations ORDER BY id').all()};
}
test('Minimal clinic file with date, service, amount, surname and patronymic maps without IDs or extra fields',()=>{
 const file=smart.detect([
 ['Дата назначения','Что делали','Фамилия','Отчество','Кол-во','Сумма, руб.'],
 ['2026-01-01','Консультация','Семёнов','Петрович','1','1000'],
 ['2026-01-20','Консультация','Семенов','Петрович','1','2000']
 ],'clinic.xlsx');
 assert.equal(file.reportType,'operations');assert.equal(file.mappingGuess.id,-1);
 assert.equal(file.mappingGuess.customer,6);assert.equal(file.rows[0][6],'Семёнов Петрович');
 assert.equal(file.mappingGuess.item,1);assert.equal(file.mappingGuess.quantity,4);
 const result=parse(file,file.mappingGuess);assert.equal(result.invalid,0);assert.equal(result.rows.length,2);
 assert.ok(result.rows.every(row=>row.synthetic_id&&row.customer_ref_kind==='name'));
});
test('Full-name fallback normalizes case, whitespace and ё while not inventing certainty or fuzzy merges',t=>{
 const f=fixture(t);
 const first=f.identity.key('a','  Семёнов   Иван  Петрович ','name');
 assert.equal(first,f.identity.key('a','СЕМЕНОВ ИВАН ПЕТРОВИЧ','name'));
 assert.notEqual(first,f.identity.key('a','Семенов Иван Павлович','name'));
 assert.notEqual(first,f.identity.key('b','Семенов Иван Петрович','name'));
 assert.equal(f.identity.key('a','нет данных','name'),undefined);
 assert.equal(f.identity.key('a','Иванов','name'),undefined);
 assert.equal(smart.customerKind('ФИО врача'),null);
 assert.equal(smart.guess(['Дата','Сумма','ФИО','ID пациента'],[['2026-01-20','1000','Иванов Иванович','p1']]).mapping.customer,3);
});
test('Names link across dates; generated patient-day IDs are stable without exposing names; repeated import is idempotent',t=>{
 const f=fixture(t),file=smart.detect([
 ['Дата','Услуга','ФИО пациента','Сумма'],
 ['2026-01-01','Консультация','Семенов Петрович','1000'],
 ['2026-01-20','Консультация','Семёнов Петрович','2000'],
 ['2026-01-20','Анализ','Семёнов Петрович','500'],
 ['2026-01-20','Анализ','Семёнов Петрович','500']
 ],'minimal.xlsx');
 const parsed=parse(file,file.mappingGuess);assert.equal(parsed.rows.length,4);assert.equal(parsed.duplicate,0);
 const rows=convert(parsed.rows);assert.equal(f.ingest(rows).added,4);
 assert.equal(f.ingest(convert([...parsed.rows].reverse()),'renamed.csv').unchanged,4);
 const stored=f.rows();assert.equal(new Set(stored.map(r=>r.customer_key)).size,1);
 assert.equal(new Set(stored.map(r=>r.source_id)).size,2);
 assert.doesNotMatch(JSON.stringify(stored),/Семенов|Семёнов|Петрович/);
 const r=calculateCustomerAnalytics(stored,{from:'2026-01-01',to:'2026-01-31'},'unverified');
 assert.equal(r.financial.average_ltv_kopecks,400000);assert.equal(r.financial.name_based_patients,1);assert.equal(r.financial.estimated,true);
 assert.equal(r.visits.available,false);assert.equal(r.activity.returning_patients,1);assert.equal(r.activity.period_visits,2);
 assert.equal(r.activity.synthetic_rows,4);
});
test('Generated operation identity supports canonical row order and global occurrences across upload chunks',t=>{
 const f=fixture(t);const parsed=[];
 for(let i=0;i<7;i++)parsed.push({date:'2026-01-20',id:'AUTO-DAY',item:'Услуга',status:'sale',amount:1000+i,synthetic_id:true,customer_ref:i%2?'Семёнов Петрович':'Семенов   Петрович',customer_ref_kind:'name'});
 const rows=convert(parsed.reverse());f.ingest(rows.slice(0,3));f.ingest(rows.slice(3));
 assert.equal(f.rows().length,7);assert.equal(f.ingest(convert([...parsed].reverse())).unchanged,7);
 assert.equal(f.rows().reduce((n,r)=>n+r.amount_kopecks,0),702100);
 const batch=f.ingest([{...rows[0],amount_kopecks:999999}]);assert.equal(batch.updated,1);
 f.engine.undoLatest({id:'a'},batch.batch_id);assert.equal(f.rows().reduce((n,r)=>n+r.amount_kopecks,0),702100);
});
test('Equal full names can merge different people and are explicitly marked as estimated',t=>{
 const f=fixture(t);const name='Иванов Иван Иванович';
 f.ingest(convert([1,2].map(day=>({date:'2026-01-0'+day,id:'AUTO-DAY',item:'Приём',status:'sale',amount:1000,synthetic_id:true,customer_ref:name,customer_ref_kind:'name'}))));
 const r=calculateCustomerAnalytics(f.rows(),{from:'2026-01-01',to:'2026-01-31'},'unverified');
 assert.equal(r.financial.patients,1);assert.equal(r.activity.estimated,true);assert.equal(r.financial.name_based_patients,1);
 assert.equal(Object.hasOwn(r,'error_percent'),false);
});
test('Anonymous lines keep financial amounts, do not fabricate patient LTV, and can be reimported',t=>{
 const f=fixture(t);const row={date:'2026-01-20',id:'AUTO-DAY',item:'Услуга',status:'sale',amount_kopecks:10000,synthetic_id:true};
 assert.equal(f.ingest([row,row]).added,2);assert.equal(f.ingest([row,row]).unchanged,2);
 const r=calculateCustomerAnalytics(f.rows(),{from:'2026-01-01',to:'2026-01-31'},'unverified');
 assert.equal(r.available,false);assert.equal(r.financial.average_ltv_kopecks,null);
 const summary=calculateFinancialSummary(f.rows(),{unverified:2},'2026-01-31','unverified','clinic');
 assert.equal(summary.revenue30_kopecks,20000);
});
test('Unspecified financial basis still yields source quantities without calling them fulfilled services',()=>{
 const rows=[{sold_on:'2026-01-20',source_id:'x',item:'Услуга',amount_kopecks:10000,quantity_milli:3000,status:'sale',financial_basis:'unverified'}];
 const r=calculateFinancialSummary(rows,{unverified:1},'2026-01-31',null,'clinic');
 assert.equal(r.volume.value,3);assert.equal(r.volume.label,'Количество из отчёта');assert.equal(r.financial_books.recognized_revenue.amount30_kopecks,0);
});
test('Templates can remember a minimal layout without an operation ID',async t=>{
 const f=fixture(t),mapper=createImportMapper({db:f.db,apiKey:''});
 const head=['Дата','Услуга','ФИО','Сумма'],mapping={date:0,id:-1,item:1,amount:3,status:-1,customer:2};
 mapper.confirm({id:'a'},{head,mapping});assert.deepEqual((await mapper.resolve({id:'a'},{head})).mapping,mapping);
});
