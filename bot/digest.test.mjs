import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dailyDigestFor } from './digest.mjs';

const NOW = new Date('2026-10-17T06:00:00.000Z');
function shift(date,n) { const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10); }
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(),'bp-digest-test-'));
  const dbPath = path.join(folder,'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'PRAGMA foreign_keys=ON;' +
    'CREATE TABLE users (telegram_id TEXT PRIMARY KEY);' +
    'CREATE TABLE companies (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);' +
    'CREATE TABLE imports (company_id TEXT PRIMARY KEY, source TEXT, imported_at TEXT, row_count INTEGER);' +
    'CREATE TABLE operations (company_id TEXT, sold_on TEXT, source_id TEXT, amount_kopecks INTEGER, status TEXT);' +
    'CREATE TABLE ai_analyses (company_id TEXT PRIMARY KEY, status TEXT, payload TEXT, updated_ms INTEGER);'
  );
  db.prepare('INSERT INTO users VALUES (?)').run('101');
  db.prepare('INSERT INTO users VALUES (?)').run('202');
  db.prepare('INSERT INTO companies VALUES (?,?,?,?)').run('c101','101','Моя клиника','2026-10-10 00:00:00');
  db.prepare('INSERT INTO companies VALUES (?,?,?,?)').run('c202','202','Чужой магазин','2026-10-10 00:00:00');
  const cleanup=()=>{db.close();rmSync(folder,{recursive:true,force:true});};
  const addImport=(id,source='Синтетический тестовый отчёт',when='2026-10-17 04:00:00')=>db.prepare(
    'INSERT OR REPLACE INTO imports(company_id,source,imported_at,row_count) VALUES(?,?,?,?)'
  ).run(id,source,when,60);
  const addOperation=(id,date,amount,sourceId,status='sale')=>db.prepare(
    'INSERT INTO operations(company_id,sold_on,source_id,amount_kopecks,status) VALUES(?,?,?,?,?)'
  ).run(id,date,sourceId,amount,status);
  const read=(id)=>dailyDigestFor(id,{now:NOW,dbPath});
  return {db,cleanup,addImport,addOperation,read};
}

test('No report for users without imports; never invent revenue',t=>{
  const f=fixture();t.after(f.cleanup);
  assert.match(f.read('101'),/пока не загружен/);
  assert.doesNotMatch(f.read('101'),/Выручка за 30 дней/);
});

test('Own-company data isolation, full-period comparison, cached AI',t=>{
  const f=fixture();t.after(f.cleanup);
  f.addImport('c101');
  f.addImport('c202','Чужой источник');
  for(let i=59;i>=0;i--){
    const date=shift('2026-10-16',-i);
    f.addOperation('c101',date,i>=30?100000:200000,'visit-'+i);
    f.addOperation('c202',date,500000000,'secret-'+i);
  }
  const cached={
    summary:'Главное внимание к изменению выручки.',
    issues:[{
      title:'Проверьте динамику визитов',
      explanation:'По доступным данным произошли изменения.',
      recommendation:'Сопоставить количество записей.',
      evidence:['Изменение количества визитов подтверждено агрегированными показателями.']
    }],
    positives:[]
  };
  f.db.prepare('INSERT INTO ai_analyses VALUES(?,?,?,?)').run(
    'c101','ready',JSON.stringify(cached),Date.parse('2026-10-17T05:00:00Z')
  );
  const result=f.read('101');
  assert.match(result,/Моя клиника \(тестовые данные\)/);
  assert.match(result,/Выручка за 30 дней по загруженным операциям: 60.?000 ₽/u);
  assert.match(result,/Чеков \/ визитов за 30 дней: 30/);
  assert.match(result,/Изменение к предыдущим 30 дням: \+100,0%/);
  assert.match(result,/Главный вывод ИИ/);
  assert.match(result,/Проверьте динамику визитов/);
  assert.doesNotMatch(result,/Чужой магазин|Чужой источник|secret/);
});

test('Stale import does not show missing yesterday as zero or claim trustworthy comparison',t=>{
  const f=fixture();t.after(f.cleanup);
  f.addImport('c101','Ручная выгрузка');
  f.addOperation('c101','2026-10-13',420000,'a');
  const result=f.read('101');
  assert.match(result,/За 16 октября 2026 г\. операций в выгрузке нет/);
  assert.match(result,/последняя дата операции — 13 октября 2026 г/);
  assert.match(result,/Сравнение с предыдущим периодом ненадёжно/);
  assert.doesNotMatch(result,/Выручка за 16 октября 2026 г\.: 0 ₽/);
});

test('Cached conclusions from older imports never leak into new digest',t=>{
  const f=fixture();t.after(f.cleanup);
  f.addImport('c101','Новый отчёт','2026-10-17 07:00:00');
  f.addOperation('c101','2026-10-16',200000,'a');
  f.db.prepare('INSERT INTO ai_analyses VALUES(?,?,?,?)').run(
    'c101','ready',
    JSON.stringify({issues:[{title:'УСТАРЕВШИЙ ВЫВОД',explanation:'Неверно',recommendation:'Проверить',evidence:[]}]}),
    Date.parse('2026-10-17T04:00:00Z')
  );
  const result=f.read('101');
  assert.doesNotMatch(result,/УСТАРЕВШИЙ ВЫВОД/);
  assert.match(result,/ИИ-анализ пока не готов/);
});
