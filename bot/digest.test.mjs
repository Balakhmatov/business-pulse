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
  assert.match(result,/<b>Моя клиника<\/b> \(тестовые данные\)/);
  assert.match(result,/1\. Выручка за 30 дней: <b>60.?000 ₽<\/b>/u);
  assert.match(result,/2\. Чеков \/ визитов за 30 дней: <b>30<\/b>/);
  assert.match(result,/4\. Изменение к предыдущим 30 дням: <b>\+100,0%<\/b>/);
  assert.match(result,/📌 <b>Ключевой аналитический вывод<\/b>/);
  assert.match(result,/<b>1\. Проверьте динамику визитов<\/b>/);
  assert.match(result,/<b>Рекомендация:<\/b>\nСопоставить количество записей/);
  assert.match(result,/\n\n<i>Основание:<\/i>/);
  assert.doesNotMatch(result,/Чужой магазин|Чужой источник|secret/);
});

test('Stale import does not show missing yesterday as zero or claim trustworthy comparison',t=>{
  const f=fixture();t.after(f.cleanup);
  f.addImport('c101','Ручная выгрузка');
  f.addOperation('c101','2026-10-13',420000,'a');
  const result=f.read('101');
  assert.match(result,/3\. За 16 октября 2026 г\. <b>нет операций в выгрузке<\/b>/);
  assert.match(result,/последняя дата операции — 13 октября 2026 г/);
  assert.match(result,/Сравнение с предыдущим периодом ограничено:/);
  assert.doesNotMatch(result,/Выручка за 16 октября 2026 г\.: <b>0 ₽<\/b>/);
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
  assert.match(result,/Заключение пока формируется/);
});

test('Telegram HTML safely escapes untrusted company names and cached AI fields', t => {
  const f=fixture(); t.after(f.cleanup);
  f.addImport('c101');
  f.db.prepare('UPDATE companies SET name=? WHERE id=?').run('Clinic & <Main>','c101');
  f.addOperation('c101','2026-10-16',150000,'receipt-1');
  f.db.prepare('INSERT INTO ai_analyses VALUES(?,?,?,?)').run(
    'c101','ready',JSON.stringify({
      issues:[{title:'Проверить <склад> & продажи',explanation:'Раздел <A> требует проверки.',
        recommendation:'Сверить <отчёт> & остатки.',evidence:['Объём <10> & выше.']}],
      positives:[]
    }),Date.parse('2026-10-17T05:00:00Z')
  );
  const result=f.read('101');
  assert.match(result,/<b>Clinic &amp; &lt;Main&gt;<\/b>/);
  assert.match(result,/<b>1\. Проверить &lt;склад&gt; &amp; продажи<\/b>/);
  assert.match(result,/<b>Рекомендация:<\/b>\nСверить &lt;отчёт&gt; &amp; остатки\./);
  assert.doesNotMatch(result,/Clinic & <Main>/);
  assert.equal((result.match(/📊/g)||[]).length,1);
  assert.equal((result.match(/📌/g)||[]).length,1);
});
