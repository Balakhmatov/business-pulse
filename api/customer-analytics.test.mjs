import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {calculateCustomerAnalytics,createCustomerIdentity} from './customer-analytics.mjs';
import {createAccumulator} from './accumulate.mjs';
import {createCorrectionService} from './corrections.mjs';
import {createImportMapper,validateMapping} from './import-mapping.mjs';
import {clearCompanyData} from './test-reset.mjs';
import smart from '../smart-import.js';
const period={from:'2026-01-15',to:'2026-01-31'};
const row=(day,id,patient,amount,basis='recognized_revenue',status='sale')=>({sold_on:day,source_id:id,customer_key:patient,amount_kopecks:amount,financial_basis:basis,status});
test('Observed LTV separates cash/services, nets refunds and reports incomplete identity coverage',()=>{
 const rows=[row('2026-01-01','a1','a',10000,'cash_receipts'),row('2026-01-20','a2','a',20000,'cash_receipts'),
 row('2026-01-25','b1','b',30000,'cash_receipts'),row('2026-01-30','ref','a',-2000,'cash_receipts','refund'),
 row('2026-01-30','unknown',null,9000,'cash_receipts'),row('2026-02-01','future','a',9000000,'cash_receipts'),
 row('2026-01-01','v1','a',5000),row('2026-01-01','v1','a',5000),row('2026-01-20','v2','a',20000),row('2026-01-25','v3','b',30000),
 row('2026-01-20','unverified','x',100000,'unverified')];
 const r=calculateCustomerAnalytics(rows,period,'cash_receipts');
 assert.equal(r.financial.average_ltv_kopecks,29000);assert.equal(r.financial.median_ltv_kopecks,29000);
 assert.equal(r.financial.net_kopecks,58000);assert.equal(r.financial.average_receipt_kopecks,19333);
 assert.deepEqual(r.financial.coverage,{identified_rows:4,total_rows:5,percent:80});
 assert.equal(r.visits.period_patients,2);assert.equal(r.visits.returning_patients,1);assert.equal(r.visits.returning_percent,50);
 assert.equal(r.visits.first_observed_patients,1);assert.equal(r.visits.period_visits,2);assert.equal(r.visits.average_gap_days,19);
 assert.deepEqual(r.visits.retention[0],{days:30,eligible:1,returned:1,percent:100});
 assert.equal(r.visits.retention[1].percent,null);
 assert.equal(calculateCustomerAnalytics(rows,period,'recognized_revenue').financial.average_ltv_kopecks,30000);
 assert.doesNotMatch(JSON.stringify(r),/customer_key|source_id|future|unverified/);
});
test('Payment installments do not become visits; same-day service lines/receipts are not returning patients',()=>{
 const rows=[row('2026-01-01','p1','a',5000,'cash_receipts'),row('2026-01-02','p2','a',5000,'cash_receipts')];
 let r=calculateCustomerAnalytics(rows,period,'cash_receipts');assert.equal(r.visits.available,false);
 rows.push(row('2026-01-20','v1','a',5000),row('2026-01-20','v1','a',5000),row('2026-01-20','v2','a',5000));
 r=calculateCustomerAnalytics(rows,period,'cash_receipts');assert.equal(r.visits.period_visits,2);assert.equal(r.visits.returning_patients,0);
 assert.equal(r.visits.average_gap_days,null);
 assert.equal(calculateCustomerAnalytics([row('2026-01-20','v',null,10000)],period,'recognized_revenue').available,false);
});
test('Retrospective cohort windows exclude future visits and unmatured patients',()=>{
 const rows=[row('2025-11-01','v1','a',10000),row('2026-02-01','v2','a',10000),row('2026-01-30','v3','b',10000)];
 const r=calculateCustomerAnalytics(rows,period,'recognized_revenue');
 assert.equal(r.visits.retention[0].eligible,1);assert.equal(r.visits.retention[0].returned,0);
 assert.equal(r.visits.cohorts[0].month,'2026-01');assert.equal(r.visits.cohorts[0].retention[0].percent,null);
 assert.equal(r.visits.absent_90_days,1);
});
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id TEXT PRIMARY KEY);
 CREATE TABLE operations(id INTEGER PRIMARY KEY,company_id TEXT,sold_on TEXT,source_id TEXT,item TEXT,amount_kopecks INTEGER,status TEXT);
 CREATE TABLE imports(company_id TEXT PRIMARY KEY,source TEXT,row_count INTEGER,imported_at TEXT DEFAULT CURRENT_TIMESTAMP);
 INSERT INTO companies VALUES('a'),('b');`);
 const accumulator=createAccumulator(db),identity=createCustomerIdentity(db);
 const make=(ref='patient-001',amount=10000)=>({date:'2026-01-20',id:'visit-001',item:'Услуга',amount_kopecks:amount,status:'sale',quantity_milli:1000,
 customer_key:identity.key('a',ref,'id')});
 return {db,identity,accumulator,make,ingest:rows=>accumulator.ingest({id:'a'},{source:'test.xlsx',financial_basis:'recognized_revenue'},rows)};
}
test('Customer keys are stable across restart, normalize contacts, isolate companies and do not store source identity',t=>{
 const f=fixture(t),{identity,db}=f;
 const key=identity.key('a','8 (999) 123-45-67','phone');
 assert.equal(key,createCustomerIdentity(db).key('a','+7 999 123 45 67','phone'));
 assert.notEqual(key,identity.key('b','+7 999 123 45 67','phone'));
 assert.equal(identity.key('a',' USER@Example.org ','email'),identity.key('a','user@example.org','email'));
 assert.notEqual(identity.key('a','001','id'),identity.key('a','1','id'));
 assert.match(identity.key('a','Иван Петров','name'),/^name-v1:/);
 assert.throws(()=>identity.key('a','Иван Петров','unsupported'));
 assert.equal(identity.key('a','ошибка +79991234567','phone'),undefined);
 assert.equal(identity.key('a','—','phone'),undefined);assert.equal(identity.key('a','нет','email'),undefined);
 assert.equal(identity.key('a','','id'),undefined);
 f.ingest([{...f.make(),customer_key:key}]);
 const stored=JSON.stringify(db.prepare('SELECT * FROM operations').all())+JSON.stringify(db.prepare('SELECT * FROM import_batch_changes').all());
 assert.doesNotMatch(stored,/\+?7[ ()-]*999[ ()-]*123[ ()-]*45[ ()-]*67|patient-001|user@example|customer_ref/i);assert.match(stored,new RegExp(key));
});
test('Patient enrichment does not duplicate money; missing field preserves links; undo restores associations',t=>{
 const f=fixture(t);const plain={...f.make(),customer_key:undefined};
 f.ingest([plain]);const enriched=f.ingest([f.make()]);assert.equal(enriched.added,0);assert.equal(enriched.updated,1);
 assert.equal(f.db.prepare('SELECT SUM(amount_kopecks) n FROM operations').get().n,10000);
 assert.equal(f.ingest([plain]).unchanged,1);
 const change=f.ingest([f.make('patient-002')]);assert.equal(change.updated,1);
 f.accumulator.undoLatest({id:'a'},change.batch_id);
 assert.equal(f.db.prepare('SELECT customer_key FROM operations').get().customer_key,f.make().customer_key);
 const corrupt=f.ingest([f.make('patient-003')]);f.db.prepare('UPDATE operations SET customer_key=?').run('changed-later');
 assert.throws(()=>f.accumulator.undoLatest({id:'a'},corrupt.batch_id),/изменились/);
});
test('Corrections preserve patient links, sign identity changes, and undo restores hashed customer keys',t=>{
 const f=fixture(t);f.ingest([f.make()]);
 const service=createCorrectionService({db:f.db,secret:'customer-test-secret-for-confirmation',now:()=>Date.parse('2026-01-31T12:00:00Z')});
 const input={source:'correction.xlsx',financial_basis:'recognized_revenue',rows:[f.make('patient-002',12000)],cancelled_ids:[]};
 const preview=service.preview({id:'a'},input);
 assert.throws(()=>service.apply({id:'a'},{...input,rows:[f.make('patient-003',12000)],...preview}),/изменились/);
 const result=service.apply({id:'a'},{...input,...preview});
 assert.equal(f.db.prepare('SELECT customer_key FROM operations').get().customer_key,f.make('patient-002').customer_key);
 f.accumulator.undoLatest({id:'a'},result.batch_id);
 assert.equal(f.db.prepare('SELECT customer_key FROM operations').get().customer_key,f.make().customer_key);
 const noPatient={...f.make(),customer_key:undefined,amount_kopecks:13000};
 const p={...input,rows:[noPatient]};service.apply({id:'a'},{...p,...service.preview({id:'a'},p)});
 assert.equal(f.db.prepare('SELECT customer_key FROM operations').get().customer_key,f.make().customer_key);
});
test('Clearing company data removes hashed associations and company key, leaves other companies untouched',t=>{
 const f=fixture(t);f.ingest([f.make()]);f.identity.key('b','other','id');
 const old=f.make().customer_key;
 clearCompanyData(f.db,{id:'a',access_role:'owner'},'owner','DELETE_ALL_COMPANY_DATA');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_identity_secrets WHERE company_id=?').get('a').n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_identity_secrets WHERE company_id=?').get('b').n,1);
 assert.notEqual(f.make().customer_key,old);
});
test('Smart import prefers patient ID to contact, never assigns it as receipt, and parser carries optional references',()=>{
 const head=['Дата оказания','Номер визита','Наименование услуги','Количество','Стоимость','ID пациента','Телефон','ФИО'];
 const table=[head,['2026-01-20','v1','Услуга','2','10000','001','+79991234567','Иван Петров']];
 const detected=smart.detect(table,'clinic.xlsx');assert.equal(detected.mappingGuess.customer,5);assert.equal(detected.mappingGuess.id,1);
 assert.equal(smart.guess(['Дата','ID пациента','Сумма'],[['2026-01-20','001','10000']]).mapping.id,-1);
 assert.equal(smart.customerKind('Телефон врача'),null);assert.equal(smart.customerKind('ФИО пациента'),'name');
 assert.equal(smart.customerKind('ID пациента (МИС)'),'id');
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const parse=Function('dayStamp','window',html.slice(html.indexOf('function parseDate('),html.indexOf('const financialFlagLabels='))+'return parseImported;')(d=>d.toISOString().slice(0,10),{BP_SmartImport:smart});
 const parsed=parse(detected,detected.mappingGuess);assert.equal(parsed.rows[0].customer_ref,'001');assert.equal(parsed.rows[0].customer_ref_kind,'id');
 assert.equal(parse(detected,{...detected.mappingGuess,customer:7}).rows[0].customer_ref_kind,'name');
 const saved=validateMapping(head,detected.mappingGuess);assert.equal(saved.customer,5);
 assert.throws(()=>validateMapping(head,{...saved,customer:saved.amount}),/Пациент/);
});
test('Patient column is remembered in company templates without requiring it from old mappings',async t=>{
 const f=fixture(t),mapper=createImportMapper({db:f.db,apiKey:''});
 const head=['Дата','Номер визита','Сумма','ID пациента'];
 const mapping={date:0,id:1,item:-1,amount:2,status:-1,customer:3};
 mapper.confirm({id:'a'},{head,mapping});
 assert.equal((await mapper.resolve({id:'a'},{head})).mapping.customer,3);
 assert.equal((await mapper.resolve({id:'b'},{head})).mapping,null);
});

// Keep patient-level identity out of model inputs, including aggregate facts.
test('AI receives aggregate patient metrics without source references or hashed patient keys',async t=>{
 const {createAI}=await import('./ai.mjs');const {calculateFinancialSummary}=await import('./finance-summary.mjs');
 const f=fixture(t);const source='private-patient-id';f.ingest([f.make(source)]);
 const r={from:'2026-01-20',to:'2026-01-26',days:7};let input;
 const rows=()=>f.db.prepare('SELECT * FROM operations').all();
 const report=(c,basis,range=r)=>{
  const summary=calculateFinancialSummary(rows(),{recognized_revenue:1},range.to,basis,'clinic',range);
  return {...summary,customers:calculateCustomerAnalytics(rows(),summary.period,summary.primary_basis)};
 };
 const ai=createAI({db:f.db,report,listOperations:rows,apiKey:'test',fetchFn:async(url,options)=>{
  input=JSON.parse(options.body).input;
  return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Доступна история пациентов.',issues:[{title:'Короткая история',explanation:'Показатель ограничен историей.',recommendation:'Дополните историю.',evidence_ids:['observed_ltv']}],positives:[]})}]}]})};
 }});
 ai.get({id:'a',industry:'clinic'},r);await new Promise(resolve=>setImmediate(resolve));
 assert.match(input,/observed_ltv|returning_patients/);
 assert.doesNotMatch(input,/private-patient-id|customer_key|customer_ref/);
 assert.ok(!input.includes(f.make(source).customer_key));
 assert.equal(ai.get({id:'a',industry:'clinic'},r).status,'ready');
});

test('Import hashes patient identity inside the write transaction and rolls back secret and rows together',t=>{
 const f=fixture(t);
 const engine=createAccumulator(f.db,{customerKeyFor:(c,r)=>f.identity.key(c.id,r.customer_ref,r.customer_ref_kind)});
 const base={date:'2026-01-20',item:'Услуга',amount_kopecks:10000,status:'sale',customer_ref:'+79991234567',customer_ref_kind:'phone'};
 assert.throws(()=>engine.ingest({id:'a'},{source:'test.xlsx'},[{...base,id:'v1'},{...base,id:'v2',customer_ref_kind:'unsupported'}]),/ID, телефон/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operations').get().n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_identity_secrets').get().n,0);
});
