import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { companyAdmin,adminCommand } from './company-admin.mjs';
import { ensureCompanyMembers,companyForUser } from './company-members.mjs';

function fixture(t){
  const dir=mkdtempSync(path.join(tmpdir(),'bp-members-')),dbPath=path.join(dir,'test.db');
  const db=new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(telegram_id TEXT PRIMARY KEY);"+
    "INSERT INTO users VALUES('101'),('202'),('303');"+
    "CREATE TABLE companies(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(telegram_id),name TEXT,industry TEXT,created_at TEXT);"+
    "INSERT INTO companies VALUES('a','101','Клиника','clinic','2026-10-18'),('b','202','Кафе','cafe','2026-10-18'),('c','303','Пустая','other','2026-10-18');"+
    "CREATE TABLE operations(company_id TEXT,amount_kopecks INTEGER);INSERT INTO operations VALUES('a',10000),('b',20000);");
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const run=(action,ownerId='101',memberId='303')=>companyAdmin({dbPath,action,ownerId,memberId});
  return {db,dbPath,run};
}
test('Existing owners resolve before and after idempotent membership schema migration',t=>{
  const f=fixture(t);
  assert.equal(companyForUser(f.db,'101').id,'a');
  ensureCompanyMembers(f.db);ensureCompanyMembers(f.db);
  assert.equal(companyForUser(f.db,'101').access_role,'owner');
  assert.equal(companyForUser(f.db,'404'),null);
  assert.equal(f.db.prepare('SELECT SUM(amount_kopecks) AS total FROM operations').get().total,30000);
});
test('Link an employee including an ID not yet in users; revoke without changing existing personal companies',t=>{
  const f=fixture(t);
  f.run('addmember');f.run('addmember');
  assert.equal(companyForUser(f.db,'303').id,'a');
  assert.equal(companyForUser(f.db,'303').access_role,'member');
  assert.equal(f.run('members').members.length,1);
  f.run('addmember','101','505');
  assert.equal(companyForUser(f.db,'505').id,'a');
  assert.equal(f.run('removemember').removed,true);
  assert.equal(companyForUser(f.db,'303').id,'c');
  assert.equal(companyForUser(f.db,'303').access_role,'owner');
  assert.equal(f.run('removemember').removed,false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM companies').get().n,3);
});
test('Membership cannot cross companies or silently hide a populated owner workspace',t=>{
  const f=fixture(t);f.run('addmember');
  assert.throws(()=>f.run('addmember','202','303'),/другой компании/);
  assert.equal(f.run('removemember','202','303').removed,false);
  assert.equal(companyForUser(f.db,'303').id,'a');
  assert.throws(()=>f.run('addmember','101','202'),/собственная компания/);
  assert.throws(()=>f.run('addmember','101','101'),/владелец/);
  assert.throws(()=>f.run('removemember','101','101'),/владелец/);
  assert.equal(companyForUser(f.db,'202').id,'b');
});
test('Member administration is private and allowlisted; input validation never changes membership',t=>{
  const f=fixture(t),m={chat:{id:'999',type:'private'},from:{id:'999'},text:'/addmember 101 303'};
  assert.equal(adminCommand(m,new Set(),f),null);
  assert.equal(adminCommand({...m,chat:{id:'999',type:'group'}},new Set(['999']),f),null);
  assert.equal(adminCommand({...m,from:{id:'303'}},new Set(['999']),f),null);
  assert.match(adminCommand(m,new Set(['999']),f),/Сотрудник подключён/);
  assert.match(adminCommand({...m,text:'/members 101'},new Set(['999']),f),/Сотрудник: 303/);
  assert.throws(()=>f.run('addmember','101','bad'),/числовой Telegram ID/);
  assert.throws(()=>f.run('addmember','404','606'),/Компания не найдена/);
  assert.equal(f.run('members').members.length,1);
  assert.match(adminCommand({...m,text:'/removemember 101 303'},new Set(['999']),f),/отозван/);
});
