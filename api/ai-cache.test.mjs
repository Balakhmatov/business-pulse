import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAI } from './ai.mjs';
import { calculateFinancialSummary } from './finance-summary.mjs';
const range={from:'2026-10-19',to:'2026-10-25',days:7};
const other={from:'2026-10-12',to:'2026-10-18',days:7};
const answer={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Нужна проверка динамики.',issues:[{title:'Неполная история',explanation:'Данных для сравнения мало.',recommendation:'Загрузите предыдущий период.',evidence_ids:['revenue']}],positives:[]})}]}]};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
  const dir=mkdtempSync(path.join(tmpdir(),'pulse-ai-'));
  const file=path.join(dir,'test.db');
  const db=new DatabaseSync(file);db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE companies(id TEXT PRIMARY KEY);
    CREATE TABLE imports(company_id TEXT PRIMARY KEY);
    CREATE TABLE operations(id INTEGER PRIMARY KEY,company_id TEXT,sold_on TEXT,source_id TEXT,item TEXT,amount_kopecks INTEGER,status TEXT,financial_basis TEXT,quantity_milli INTEGER);
    INSERT INTO companies VALUES('a'),('b'); INSERT INTO imports VALUES('a'),('b');
    INSERT INTO operations VALUES(1,'a','2026-10-25','v','Услуга',10000,'sale','recognized_revenue',2000);
    INSERT INTO operations VALUES(2,'a','2026-10-25','p','Оплата',10000,'sale','cash_receipts',NULL);`);
  const second=new DatabaseSync(file);
  t.after(()=>{second.close();db.close();rmSync(dir,{recursive:true,force:true});});
  let calls=0, clock=1000000;const requests=[];
  const fetchFn=async()=>{calls++;return new Promise(resolve=>requests.push((value=answer)=>resolve({ok:true,json:async()=>value})));};
  function engine(connection=db){
    const report=(c,basis=null,r=range)=>{
      const rows=connection.prepare('SELECT * FROM operations WHERE company_id=?').all(c.id);
      const counts=Object.fromEntries(['recognized_revenue','cash_receipts','unverified'].map(b=>[b,rows.filter(x=>x.financial_basis===b).length]));
      return calculateFinancialSummary(rows,counts,r.to,basis||'recognized_revenue',c.industry,r);
    };
    return createAI({db:connection,report,listOperations:c=>connection.prepare('SELECT * FROM operations WHERE company_id=?').all(c.id),apiKey:'test',fetchFn,now:()=>clock});
  }
  return {db,engine,second,requests,calls:()=>calls,tick:n=>clock+=n};
}
const company={id:'a',industry:'clinic'};
test('DB cache is stable across refresh, workers, restart, range and financial basis',async t=>{
  const f=fixture(t),a=f.engine(),b=f.engine(f.second);
  assert.equal(a.get(company,range).status,'pending');
  for(let i=0;i<10;i++)b.get(company,range);
  assert.equal(f.calls(),1);
  f.requests.shift()();await settle();
  const first=a.get(company,range);assert.equal(first.status,'ready');
  assert.deepEqual(f.engine(f.second).get(company,range),first);
  b.get(company,other);a.get(company,range,'cash_receipts');
  assert.equal(f.calls(),3);
  while(f.requests.length)f.requests.shift()();await settle();
  assert.deepEqual(a.get(company,range),first);assert.equal(f.calls(),3);
  assert.equal(b.get(company,other).status,'ready');
  a.get({id:'b',industry:'clinic'},range);assert.equal(f.calls(),4);
  f.requests.shift()();await settle();
});
test('dataset mutations invalidate all ranges and late results cannot replace current data',async t=>{
  const f=fixture(t),a=f.engine();a.get(company,range);
  f.db.exec('UPDATE operations SET quantity_milli=3000 WHERE id=1');
  a.get(company,range);assert.equal(f.calls(),2);
  f.requests.shift()();await settle();assert.equal(a.get(company,range).status,'pending');
  f.requests.shift()();await settle();assert.equal(a.get(company,range).status,'ready');
  a.onImport(company);assert.equal(f.calls(),2); // identical reimport is not a new dataset
  f.db.exec('DELETE FROM operations WHERE id=1');a.get(company,range);assert.equal(f.calls(),3);
  f.requests.shift()();await settle();
  f.db.exec("INSERT INTO operations VALUES(1,'a','2026-10-25','v','Услуга',10000,'sale','recognized_revenue',2000)");
  a.get(company,range);assert.equal(f.calls(),4);f.requests.shift()();await settle();
});
test('abandoned lease recovers and outdated worker cannot overwrite its replacement',async t=>{
  const f=fixture(t),a=f.engine(),b=f.engine(f.second);a.get(company,range);
  f.tick(119999);b.get(company,range);assert.equal(f.calls(),1);
  f.tick(2);b.get(company,range);assert.equal(f.calls(),2);
  f.requests.shift()();await settle();assert.equal(a.get(company,range).status,'pending');
  f.requests.shift()();await settle();assert.equal(a.get(company,range).status,'ready');
});


test('failed generation backs off durably; only one worker retries after cooldown',async t=>{
  const f=fixture(t),a=f.engine(),b=f.engine(f.second);a.get(company,range);
  f.requests.shift()({status:'failed'});await settle();
  assert.equal(b.get(company,range).status,'error');assert.equal(f.calls(),1);
  f.tick(600001);assert.equal(a.get(company,range).status,'pending');b.get(company,range);
  assert.equal(f.calls(),2);f.requests.shift()();await settle();
  assert.equal(b.get(company,range).status,'ready');
});
