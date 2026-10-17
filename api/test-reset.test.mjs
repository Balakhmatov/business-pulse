import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resetTestData } from './test-reset.mjs';

function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec(
    "CREATE TABLE imports(company_id TEXT PRIMARY KEY,source TEXT NOT NULL);" +
    "CREATE TABLE operations(company_id TEXT NOT NULL,source_id TEXT NOT NULL);" +
    "CREATE TABLE ai_analyses(company_id TEXT PRIMARY KEY,payload TEXT);"
  );
  const add=(company,source,ids)=>{
    db.prepare('INSERT INTO imports(company_id,source) VALUES(?,?)').run(company,source);
    for(const id of ids)db.prepare('INSERT INTO operations(company_id,source_id) VALUES(?,?)').run(company,id);
    db.prepare('INSERT INTO ai_analyses(company_id,payload) VALUES(?,?)').run(company,'{}');
  };
  const count=(table,company)=>db.prepare('SELECT COUNT(*) AS n FROM '+table+' WHERE company_id=?').get(company).n;
  return {db,add,count,close:()=>db.close()};
}

test('Removes only own legacy and new-format test transactions and cached AI',t=>{
  const f=fixture();t.after(f.close);
  f.add('mine','Синтетический тестовый отчёт',['DEMO-59-0','DEMO-1-6','REF-12','DEMO-2026-10-16-0','REF-2026-10-16']);
  f.add('other','Синтетический тестовый отчёт',['DEMO-59-0']);
  const result=resetTestData(f.db,'mine');
  assert.equal(result.removed,5);
  for(const table of ['imports','operations','ai_analyses']) {
    assert.equal(f.count(table,'mine'),0);
    assert.equal(f.count(table,'other'),table==='operations'?1:1);
  }
});

test('Refuses to delete any mixed business and synthetic records',t=>{
  const f=fixture();t.after(f.close);
  f.add('mine','Синтетический тестовый отчёт',['DEMO-59-0','RECEIPT-REAL-123']);
  assert.throws(()=>resetTestData(f.db,'mine'),e=>e.status===409);
  assert.equal(f.count('operations','mine'),2);
  assert.equal(f.count('imports','mine'),1);
  assert.equal(f.count('ai_analyses','mine'),1);
});

test('Refuses even fully synthetic IDs when the file is not a recognized test source',t=>{
  const f=fixture();t.after(f.close);
  f.add('mine','retail-production-2026.csv',['DEMO-59-0']);
  assert.throws(()=>resetTestData(f.db,'mine'),e=>e.status===409);
  assert.equal(f.count('operations','mine'),1);
});

test('Refuses empty or unknown company; never touches other accounts',t=>{
  const f=fixture();t.after(f.close);
  f.add('other','Синтетический тестовый отчёт',['DEMO-59-0']);
  assert.throws(()=>resetTestData(f.db,'mine'),e=>e.status===409);
  assert.equal(f.count('operations','other'),1);
});
