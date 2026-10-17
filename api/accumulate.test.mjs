import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createAccumulator } from './accumulate.mjs';

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
