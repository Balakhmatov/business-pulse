import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAccumulator} from './accumulate.mjs';
import {createCorrectionService} from './corrections.mjs';

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(
    'PRAGMA foreign_keys=ON;'+
    'CREATE TABLE users(telegram_id TEXT PRIMARY KEY);'+
    'CREATE TABLE companies(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(telegram_id),name TEXT NOT NULL,industry TEXT NOT NULL);'+
    'CREATE TABLE operations(id INTEGER PRIMARY KEY AUTOINCREMENT,company_id TEXT NOT NULL REFERENCES companies(id),sold_on TEXT NOT NULL,source_id TEXT NOT NULL,item TEXT NOT NULL,amount_kopecks INTEGER NOT NULL,status TEXT NOT NULL);'+
    'CREATE TABLE imports(company_id TEXT PRIMARY KEY REFERENCES companies(id),imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,source TEXT NOT NULL,row_count INTEGER NOT NULL);'
  );
  db.exec("INSERT INTO users VALUES('u1'),('u2');");
  db.exec("INSERT INTO companies VALUES('a','u1','First','other'),('b','u2','Second','other');");
  const accumulator=createAccumulator(db);
  let time=Date.parse('2026-10-18T10:00:00Z');
  const service=createCorrectionService({db,secret:'test-secret-for-signed-correction-requests',now:()=>time});
  const row=(id,date,amount,item='Услуга',status='sale')=>
    ({id,date,item,status,amount_kopecks:amount});
  const seed=(id,rows)=>accumulator.ingest({id},{source:'seed.csv'},rows);
  const values=(id='a')=>db.prepare(
    'SELECT source_id,sold_on,item,amount_kopecks,status FROM operations WHERE company_id=? ORDER BY source_id'
  ).all(id);
  const input=(rows=[],cancelled_ids=[])=>
    ({source:'corrections.xlsx',rows,cancelled_ids});
  const preview=(id,payload)=>service.preview({id},payload);
  const apply=(id,payload,token)=>service.apply({id},{
    ...payload,confirm_token:token.confirm_token,expires_at_ms:token.expires_at_ms
  });
  return {db,accumulator,service,row,seed,values,input,preview,apply,
    timeAdd:(delta)=>{time+=delta},close:()=>db.close()};
}

test('Date transfer and corrected amount replace an operation rather than duplicate it; undo restores everything',t=>{
  const f=fixture();t.after(f.close);
  f.seed('a',[f.row('R1','2026-10-12',10000),f.row('R2','2026-10-12',20000)]);
  const initial=f.values();
  const payload=f.input([f.row('R1','2026-10-14',15500)]);
  const checked=f.preview('a',payload);
  assert.deepEqual([checked.summary.added,checked.summary.updated,checked.summary.deleted,checked.summary.moved],[0,1,0,1]);
  const applied=f.apply('a',payload,checked);
  assert.equal(applied.changed,true);
  assert.equal(applied.stats.updated,1);
  assert.deepEqual(f.values().map(x=>x.amount_kopecks),[15500,20000]);
  assert.equal(f.values()[0].sold_on,'2026-10-14');
  assert.equal(f.accumulator.history({id:'a'})[0].kind,'correction');
  const undone=f.accumulator.undoLatest({id:'a'},applied.batch_id);
  assert.equal(undone.restored,1);
  assert.deepEqual(f.values(),initial);
});

test('Partial correction never deletes missing rows from a historical upload',t=>{
  const f=fixture();t.after(f.close);
  f.seed('a',[f.row('A','2026-10-12',10000),f.row('B','2026-10-12',20000)]);
  const payload=f.input([f.row('A','2026-10-12',11000)]);
  const checked=f.preview('a',payload);
  const applied=f.apply('a',payload,checked);
  assert.equal(applied.stats.deleted,0);
  assert.equal(f.values().length,2);
  assert.equal(f.values()[1].amount_kopecks,20000);
});

test('Explicit cancellation deletes one uniquely identified operation and can be fully reversed',t=>{
  const f=fixture();t.after(f.close);
  f.seed('a',[f.row('cancel-me','2026-10-12',50000),f.row('keep','2026-10-12',30000)]);
  const payload=f.input([],['cancel-me']);
  const checked=f.preview('a',payload);
  assert.equal(checked.summary.deleted,1);
  const applied=f.apply('a',payload,checked);
  assert.equal(f.values().length,1);
  assert.equal(f.values()[0].source_id,'keep');
  assert.equal(f.accumulator.history({id:'a'})[0].deleted,1);
  f.accumulator.undoLatest({id:'a'},applied.batch_id);
  assert.equal(f.values().length,2);
  assert.equal(f.values()[0].amount_kopecks,50000);
});

test('Correction can add a genuinely new row while retaining old operations; undo removes only the new row',t=>{
  const f=fixture();t.after(f.close);
  f.seed('a',[f.row('old','2026-10-12',10000)]);
  const payload=f.input([f.row('new','2026-10-13',20000)]);
  const applied=f.apply('a',payload,f.preview('a',payload));
  assert.equal(applied.stats.added,1);
  assert.equal(f.values().length,2);
  f.accumulator.undoLatest({id:'a'},applied.batch_id);
  assert.equal(f.values().length,1);
  assert.equal(f.values()[0].source_id,'old');
});

test('Correction is idempotent: a second preview produces no change or new journal',t=>{
  const f=fixture();t.after(f.close);
  f.seed('a',[f.row('r','2026-10-12',10000)]);
  const p=f.input([f.row('r','2026-10-12',11000)]);
  f.apply('a',p,f.preview('a',p));
  const before=f.accumulator.history({id:'a'}).length;
  const check=f.preview('a',p);
  assert.equal(check.can_apply,false);
  assert.equal(check.summary.unchanged,1);
  const done=f.apply('a',p,check);
  assert.equal(done.changed,false);
  assert.equal(f.accumulator.history({id:'a'}).length,before);
});

test('Correction signatures are owner scoped; stale plans and expired tokens cannot apply',t=>{
  const f=fixture();t.after(f.close);
  f.seed('a',[f.row('r','2026-10-12',10000)]);
  f.seed('b',[f.row('r','2026-10-12',30000)]);
  const p=f.input([f.row('r','2026-10-13',12000)]);
  const check=f.preview('a',p);
  assert.throws(()=>f.apply('b',p,check),/изменились|проверки/);
  assert.equal(f.values('b')[0].amount_kopecks,30000);
  // Another legitimate import makes an otherwise identical preview obsolete.
  f.seed('a',[f.row('unrelated','2026-10-12',50000)]);
  assert.throws(()=>f.apply('a',p,check),/изменились|проверки/);
  const fresh=f.preview('a',p);
  f.timeAdd(11*60*1000);
  assert.throws(()=>f.apply('a',p,fresh),/истёк/);
  assert.equal(f.values('a')[0].sold_on,'2026-10-12');
});

test('Duplicate source IDs, cancellation of unknown IDs and contradictory instructions block safely',t=>{
  const f=fixture();t.after(f.close);
  f.seed('a',[f.row('multi','2026-10-12',10000,'Приём'),f.row('multi','2026-10-12',20000,'Анализы')]);
  assert.throws(()=>f.preview('a',f.input([f.row('multi','2026-10-13',13000)])),/нескольким/);
  assert.throws(()=>f.preview('a',f.input([],['absent'])),/нет ранее загруженной/i);
  assert.throws(()=>f.preview('a',f.input([f.row('X','2026-10-13',5000),f.row('X','2026-10-13',6000)])),/уникальный/i);
  assert.throws(()=>f.preview('a',f.input([f.row('Y','2026-10-13',5000)],['Y'])),/одновременно/);
});

test('Two staged corrections roll back as one transaction on a database constraint failure',t=>{
  const f=fixture();t.after(f.close);
  f.seed('a',[f.row('A','2026-10-12',10000),f.row('B','2026-10-12',20000)]);
  const p=f.input([f.row('A','2026-10-12',11000),f.row('B','2026-10-12',21000)]);
  const check=f.preview('a',p);
  const before=f.values();
  f.db.exec("CREATE TRIGGER block_corr BEFORE UPDATE OF amount_kopecks ON operations WHEN NEW.source_id='B' BEGIN SELECT RAISE(ABORT, 'forced database failure'); END;");
  assert.throws(()=>f.apply('a',p,check),/forced database failure/);
  assert.deepEqual(f.values(),before);
  assert.equal(f.accumulator.history({id:'a'}).length,1);
});

test('Undo correction is restricted to the latest batch and preserves every other company',t=>{
  const f=fixture();t.after(f.close);
  f.seed('a',[f.row('A','2026-10-12',10000)]);
  f.seed('b',[f.row('B','2026-10-12',20000)]);
  const p=f.input([f.row('A','2026-10-13',11000)]);
  const updated=f.apply('a',p,f.preview('a',p));
  const other=f.values('b');
  assert.throws(()=>f.accumulator.undoLatest({id:'b'},updated.batch_id),/последнюю/);
  f.seed('a',[f.row('C','2026-10-13',30000)]);
  assert.throws(()=>f.accumulator.undoLatest({id:'a'},updated.batch_id),/последнюю/);
  assert.deepEqual(f.values('b'),other);
});

test('Corrections and cancellations with a shared ID never touch the other financial book',t=>{
  const f=fixture();t.after(f.close);
  f.accumulator.ingest({id:'a'},{
    source:'money.xlsx',financial_basis:'cash_receipts'
  },[f.row('same','2026-10-12',10000)]);
  f.accumulator.ingest({id:'a'},{
    source:'earned.xlsx',financial_basis:'recognized_revenue'
  },[f.row('same','2026-10-12',9000)]);
  const payload={...f.input([f.row('same','2026-10-13',15000)]),
    financial_basis:'cash_receipts'};
  const applied=f.apply('a',payload,f.preview('a',payload));
  const rows=f.db.prepare(
    'SELECT financial_basis,sold_on,amount_kopecks FROM operations WHERE company_id=? ORDER BY financial_basis'
  ).all('a').map(row=>({...row}));
  assert.deepEqual(rows,[
    {financial_basis:'cash_receipts',sold_on:'2026-10-13',amount_kopecks:15000},
    {financial_basis:'recognized_revenue',sold_on:'2026-10-12',amount_kopecks:9000}
  ]);
  f.accumulator.undoLatest({id:'a'},applied.batch_id);
  assert.equal(f.db.prepare(
    'SELECT amount_kopecks FROM operations WHERE financial_basis=?'
  ).get('cash_receipts').amount_kopecks,10000);
  assert.equal(f.db.prepare(
    'SELECT amount_kopecks FROM operations WHERE financial_basis=?'
  ).get('recognized_revenue').amount_kopecks,9000);
});

test('Old correction snapshots without finance basis remain reversible after migration',t=>{
  const f=fixture();t.after(f.close);
  f.seed('a',[f.row('old','2026-10-12',10000)]);
  const request=f.input([f.row('old','2026-10-13',12000)]);
  const applied=f.apply('a',request,f.preview('a',request));
  const rows=f.db.prepare(
    'SELECT batch_id,source_id,before_row,after_row FROM operation_correction_changes WHERE batch_id=?'
  ).all(applied.batch_id);
  for(const snapshot of rows){
    const before=JSON.parse(snapshot.before_row),after=JSON.parse(snapshot.after_row);
    delete before.financial_basis;delete after.financial_basis;
    f.db.prepare(
      'UPDATE operation_correction_changes SET before_row=?,after_row=? WHERE batch_id=? AND source_id=?'
    ).run(JSON.stringify(before),JSON.stringify(after),snapshot.batch_id,snapshot.source_id);
  }
  f.accumulator.undoLatest({id:'a'},applied.batch_id);
  assert.equal(f.values()[0].sold_on,'2026-10-12');
  assert.equal(f.values()[0].amount_kopecks,10000);
  assert.equal(f.db.prepare('SELECT financial_basis FROM operations').get().financial_basis,'unverified');
});

test('Signed correction changes quantity alone and undo restores it with no impact on revenue',t=>{
  const f=fixture();t.after(f.close);
  const before={...f.row('job-1','2026-10-12',180000),quantity_milli:2000};
  f.seed('a',[before]);
  const proposed={...before,quantity_milli:5000};
  const data=f.input([proposed]);
  const checked=f.preview('a',data);
  assert.equal(checked.summary.updated,1);
  const applied=f.apply('a',data,checked);
  assert.equal(applied.changed,true);
  const updated=f.db.prepare('SELECT amount_kopecks,quantity_milli FROM operations').get();
  assert.equal(updated.amount_kopecks,180000);
  assert.equal(updated.quantity_milli,5000);
  f.accumulator.undoLatest({id:'a'},applied.batch_id);
  const restored=f.db.prepare('SELECT amount_kopecks,quantity_milli FROM operations').get();
  assert.equal(restored.amount_kopecks,180000);
  assert.equal(restored.quantity_milli,2000);
});
