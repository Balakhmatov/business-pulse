import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { companyAdmin,adminCommand } from './company-admin.mjs';

function fixture(t){
  const dir=mkdtempSync(path.join(tmpdir(),'bp-admin-')),dbPath=path.join(dir,'db.sqlite');
  const db=new DatabaseSync(dbPath);
  db.exec("CREATE TABLE companies(id TEXT PRIMARY KEY,owner_id TEXT,name TEXT,industry TEXT,created_at TEXT);"+
    "INSERT INTO companies VALUES('a','101','Клиника','other','2026-10-18'),('b','202','Магазин','store','2026-10-17');"+
    "CREATE TABLE operations(company_id TEXT,amount_kopecks INTEGER);INSERT INTO operations VALUES('a',12345);"+
    "CREATE TABLE ai_analyses(company_id TEXT PRIMARY KEY,payload TEXT);INSERT INTO ai_analyses VALUES('a','cached'),('b','cached');");
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  return {db,dbPath};
}
const message=(from='999',chat=from,type='private')=>({from:{id:from},chat:{id:chat,type},text:'/industry 101 clinic'});
test('Only allowlisted private-chat sender can assign an industry',t=>{
  const f=fixture(t),admins=new Set(['999']);
  for(const m of [message('101'),message('101','999'),message('999','999','group')])
    assert.equal(adminCommand(m,admins,f),null);
  assert.equal(adminCommand(message(),new Set(),f),null);
  assert.equal(f.db.prepare("SELECT industry FROM companies WHERE id='a'").get().industry,'other');
  assert.match(adminCommand(message(),admins,f),/Отрасль назначена/);
  assert.equal(f.db.prepare("SELECT industry FROM companies WHERE id='a'").get().industry,'clinic');
});
test('Assignment preserves financial rows and other companies, invalidates only changed company AI',t=>{
  const f=fixture(t);
  companyAdmin({...f,action:'set',ownerId:'101',industry:'clinic'});
  assert.equal(f.db.prepare('SELECT amount_kopecks FROM operations').get().amount_kopecks,12345);
  assert.equal(f.db.prepare("SELECT industry FROM companies WHERE id='b'").get().industry,'store');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ai_analyses WHERE company_id='a'").get().n,0);
  assert.equal(f.db.prepare("SELECT payload FROM ai_analyses WHERE company_id='b'").get().payload,'cached');
  f.db.prepare("INSERT INTO ai_analyses VALUES('a','new')").run();
  companyAdmin({...f,action:'set',ownerId:'101',industry:'clinic'});
  assert.equal(f.db.prepare("SELECT payload FROM ai_analyses WHERE company_id='a'").get().payload,'new');
});
test('Unknown owner, invalid industry and ambiguous ownership fail without partial updates',t=>{
  const f=fixture(t);
  for(const [ownerId,industry] of [['404','clinic'],['101','invalid'],["101' OR 1=1",'clinic']])
    assert.throws(()=>companyAdmin({...f,action:'set',ownerId,industry}));
  f.db.prepare("INSERT INTO companies VALUES('c','101','Вторая','other','2026-10-19')").run();
  assert.throws(()=>companyAdmin({...f,action:'set',ownerId:'101',industry:'clinic'}),/несколько компаний/);
  assert.equal(f.db.prepare("SELECT industry FROM companies WHERE id='a'").get().industry,'other');
});
test('Admin list is bounded and can find one specific owner',t=>{
  const f=fixture(t);
  assert.equal(companyAdmin({...f,action:'list'}).length,2);
  assert.deepEqual(companyAdmin({...f,action:'list',ownerId:'202'}).map(x=>x.id),['b']);
  assert.match(adminCommand({...message(),text:'/companies 101'},new Set(['999']),f),/101 · Клиника · other/);
});
