import { createHash } from 'node:crypto';

// Incremental, company-scoped import layer.
// Identity: date + receipt ID + item + sale/refund + occurrence within receipt/item.
// This assumes stable receipt IDs and stable line ordering if several same-name
// items exist within a receipt. A future explicit line ID will remove that caveat.
export const FINANCIAL_BASES=['unverified','cash_receipts','recognized_revenue','paid_fulfilled'];
export function financialBasis(value){
  if(value===undefined||value===null)return 'unverified'; // legacy/test imports
  if(!FINANCIAL_BASES.includes(value))throw Object.assign(Error('Неверный тип финансовых данных.'),{status:400});
  return value;
}
export function lineKey(date, id, item, status, occurrence, basis='unverified') {
  // Legacy keys stay bit-for-bit stable for historical imports, correction undo
  // and old installations. Verified ledgers get separate identity namespaces.
  const parts=[date,id.trim(),item.trim(),status,occurrence];
  if(basis!=='unverified')parts.push(basis);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function syntheticOperationID(companyId,date,customerKey){
  return 'AUTO-DAY-V1-'+createHash('sha256').update(JSON.stringify([companyId,date,customerKey||null])).digest('hex');
}
export function createAccumulator(db,{customerKeyFor=null}={}) {
  const operationColumns = db.prepare('PRAGMA table_info(operations)').all().map(c => c.name);
  const importColumns = db.prepare('PRAGMA table_info(imports)').all().map(c => c.name);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!operationColumns.includes('import_key')) db.exec('ALTER TABLE operations ADD COLUMN import_key TEXT');
    // Historical data cannot be classified as collected cash or earned revenue
    // solely from the old amount column; preserve it as unverified.
    if (!operationColumns.includes('financial_basis'))
      db.exec("ALTER TABLE operations ADD COLUMN financial_basis TEXT NOT NULL DEFAULT 'unverified'");
    if (!operationColumns.includes('customer_key'))
      db.exec('ALTER TABLE operations ADD COLUMN customer_key TEXT');
    if (!operationColumns.includes('quantity_milli'))
      db.exec('ALTER TABLE operations ADD COLUMN quantity_milli INTEGER');
    if (!importColumns.includes('last_change_at')) {
      db.exec('ALTER TABLE imports ADD COLUMN last_change_at TEXT');
      db.exec('UPDATE imports SET last_change_at=imported_at WHERE last_change_at IS NULL');
    }
    // Migrate historic operations in place. Never discard or zero old uploads.
    const historic = db.prepare(
      'SELECT id,company_id,sold_on,source_id,item,status FROM operations ' +
      'WHERE import_key IS NULL ORDER BY company_id,sold_on,source_id,item,status,id'
    ).all();
    const put = db.prepare('UPDATE operations SET import_key=? WHERE id=?');
    let last = null, index = 0;
    for (const row of historic) {
      const group = JSON.stringify([row.company_id,row.sold_on,row.source_id.trim(),row.item.trim(),row.status]);
      index = group === last ? index + 1 : 0;
      last = group;
      put.run(lineKey(row.sold_on,row.source_id,row.item,row.status,index),row.id);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_operations_identity ON operations(company_id,import_key)');
    db.exec('CREATE INDEX IF NOT EXISTS ix_operations_company_source_id ON operations(company_id,source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS ix_operations_company_basis_date ON operations(company_id,financial_basis,sold_on)');
    // Reversible, company-scoped audit trail. No patient/customer data or raw
    // spreadsheets are stored here, only changed amounts and import metadata.
    db.exec(
      'CREATE TABLE IF NOT EXISTS import_batches ('+
      'id INTEGER PRIMARY KEY AUTOINCREMENT,'+
      'company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,'+
      'source TEXT NOT NULL,imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,'+
      'received INTEGER NOT NULL,added INTEGER NOT NULL,updated INTEGER NOT NULL,'+
      'unchanged INTEGER NOT NULL,total INTEGER NOT NULL,'+
      'prev_source TEXT,prev_row_count INTEGER,prev_imported_at TEXT,prev_last_change_at TEXT,'+
      'undone_at TEXT);'+
      'CREATE INDEX IF NOT EXISTS ix_import_batches_company ON import_batches(company_id,id DESC);'+
      'CREATE TABLE IF NOT EXISTS import_batch_changes ('+
      'batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,'+
      'company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,'+
      'import_key TEXT NOT NULL,old_amount_kopecks INTEGER,new_amount_kopecks INTEGER NOT NULL,'+
      'PRIMARY KEY(batch_id,import_key));'
    );
    // Existing installations already have import_batches; keep the migration
    // backward-compatible with previously deployed batch audit tables.
    const batchColumns=db.prepare('PRAGMA table_info(import_batches)').all().map(c=>c.name);
    if(!batchColumns.includes('deleted'))db.exec('ALTER TABLE import_batches ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
    if(!batchColumns.includes('kind'))db.exec("ALTER TABLE import_batches ADD COLUMN kind TEXT NOT NULL DEFAULT 'append'");
    if(!batchColumns.includes('financial_basis'))
      db.exec("ALTER TABLE import_batches ADD COLUMN financial_basis TEXT NOT NULL DEFAULT 'unverified'");
    const changeColumns=db.prepare('PRAGMA table_info(import_batch_changes)').all().map(x=>x.name);
    if(!changeColumns.includes('old_quantity_milli'))
      db.exec('ALTER TABLE import_batch_changes ADD COLUMN old_quantity_milli INTEGER');
    if(!changeColumns.includes('new_quantity_milli'))
      db.exec('ALTER TABLE import_batch_changes ADD COLUMN new_quantity_milli INTEGER');
    if(!changeColumns.includes('old_customer_key'))
      db.exec('ALTER TABLE import_batch_changes ADD COLUMN old_customer_key TEXT');
    if(!changeColumns.includes('new_customer_key'))
      db.exec('ALTER TABLE import_batch_changes ADD COLUMN new_customer_key TEXT');
    db.exec(
      'CREATE TABLE IF NOT EXISTS operation_correction_changes ('+
      'batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,'+
      'company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,'+
      'source_id TEXT NOT NULL,before_row TEXT,after_row TEXT,'+
      'PRIMARY KEY(batch_id,source_id));'
    );
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}

  const insert = db.prepare(
    'INSERT INTO operations(company_id,sold_on,source_id,item,amount_kopecks,status,import_key,financial_basis,quantity_milli,customer_key) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,import_key) DO UPDATE SET ' +
    'amount_kopecks=excluded.amount_kopecks,source_id=excluded.source_id,item=excluded.item,quantity_milli=excluded.quantity_milli,customer_key=excluded.customer_key ' +
    'WHERE operations.amount_kopecks<>excluded.amount_kopecks ' +
    'OR operations.source_id<>excluded.source_id OR operations.item<>excluded.item ' +
    'OR operations.quantity_milli IS NOT excluded.quantity_milli OR operations.customer_key IS NOT excluded.customer_key'
  );
  const getPrevious = db.prepare('SELECT amount_kopecks,quantity_milli,customer_key FROM operations WHERE company_id=? AND import_key=?');
  // A paid/fulfilled export must never overlap independently imported cash
  // or earned revenue for the same receipt line. Otherwise one financial
  // book would count the same purchase twice.
  const existingSeparate=db.prepare(
    "SELECT 1 FROM operations WHERE company_id=? AND sold_on=? AND source_id=? "+
    "AND status=? AND financial_basis IN ('cash_receipts','recognized_revenue') LIMIT 1"
  );
  const existingCombined=db.prepare(
    "SELECT 1 FROM operations WHERE company_id=? AND sold_on=? AND source_id=? "+
    "AND status=? AND financial_basis='paid_fulfilled' LIMIT 1"
  );
  const count = db.prepare('SELECT count(*) AS n FROM operations WHERE company_id=?');
  const countBasis = db.prepare('SELECT count(*) AS n FROM operations WHERE company_id=? AND financial_basis=?');
  const latest = db.prepare('SELECT source,row_count,imported_at,last_change_at FROM imports WHERE company_id=?');
  const batchInsert = db.prepare(
    'INSERT INTO import_batches(company_id,source,received,added,updated,unchanged,total,'+
    'prev_source,prev_row_count,prev_imported_at,prev_last_change_at,financial_basis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const changeInsert = db.prepare(
    'INSERT INTO import_batch_changes(batch_id,company_id,import_key,old_amount_kopecks,new_amount_kopecks,old_quantity_milli,new_quantity_milli,old_customer_key,new_customer_key) VALUES(?,?,?,?,?,?,?,?,?)'
  );
  const pruneChanges = db.prepare(
    'DELETE FROM import_batch_changes WHERE company_id=? AND batch_id NOT IN ('+
    'SELECT id FROM import_batches WHERE company_id=? AND undone_at IS NULL ORDER BY id DESC LIMIT 5)'
  );
  const pruneCorrectionChanges = db.prepare(
    'DELETE FROM operation_correction_changes WHERE company_id=? AND batch_id NOT IN ('+
    'SELECT id FROM import_batches WHERE company_id=? AND undone_at IS NULL ORDER BY id DESC LIMIT 5)'
  );
  const pruneBatches = db.prepare(
    'DELETE FROM import_batches WHERE company_id=? AND id NOT IN ('+
    'SELECT id FROM import_batches WHERE company_id=? ORDER BY id DESC LIMIT 100)'
  );
  const newest = db.prepare('SELECT * FROM import_batches WHERE company_id=? AND undone_at IS NULL ORDER BY id DESC LIMIT 1');
  const undoChanges = db.prepare('SELECT import_key,old_amount_kopecks,new_amount_kopecks,old_quantity_milli,new_quantity_milli,old_customer_key,new_customer_key FROM import_batch_changes WHERE batch_id=? AND company_id=?');
  const removeInserted = db.prepare('DELETE FROM operations WHERE company_id=? AND import_key=? AND amount_kopecks=? AND quantity_milli IS ? AND customer_key IS ?');
  const revertUpdated = db.prepare('UPDATE operations SET amount_kopecks=?,quantity_milli=?,customer_key=? WHERE company_id=? AND import_key=? AND amount_kopecks=? AND quantity_milli IS ? AND customer_key IS ?');
  const markUndone = db.prepare("UPDATE import_batches SET undone_at=CURRENT_TIMESTAMP WHERE id=? AND company_id=? AND undone_at IS NULL");
  const restoreMeta = db.prepare('UPDATE imports SET source=?,row_count=?,imported_at=?,last_change_at=? WHERE company_id=?');
  const deleteMeta = db.prepare('DELETE FROM imports WHERE company_id=?');
  const getCorrectionChanges=db.prepare(
    'SELECT source_id,before_row,after_row FROM operation_correction_changes WHERE company_id=? AND batch_id=?'
  );
  const findRowId=db.prepare(
    'SELECT id,company_id,sold_on,source_id,item,amount_kopecks,status,import_key,financial_basis,quantity_milli,customer_key FROM operations WHERE company_id=? AND id=?'
  );
  const deleteExactRow=db.prepare('DELETE FROM operations WHERE company_id=? AND id=?');
  const insertExactRow=db.prepare(
    'INSERT INTO operations(id,company_id,sold_on,source_id,item,amount_kopecks,status,import_key,financial_basis,quantity_milli,customer_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  );
  const createImport = db.prepare(
    'INSERT INTO imports(company_id,source,row_count,last_change_at) VALUES(?,?,?,CURRENT_TIMESTAMP)'
  );
  const updateMeta = db.prepare(
    'UPDATE imports SET imported_at=CURRENT_TIMESTAMP,source=?,row_count=?,' +
    'last_change_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE last_change_at END WHERE company_id=?'
  );

  function ingest(company, input, rows) {
    // Validate all rows BEFORE starting a write transaction (caller does this).
    // No explicit line-id in the current CSV contract: occurrence is stable only
    // if multiple lines of one item retain their original order.
    const basis=financialBasis(input.financial_basis);
    const seq = new Map();
    const stats = {received:rows.length,added:0,updated:0,unchanged:0,total:0};
    const changedRows=[];
    db.exec('BEGIN IMMEDIATE');
    try {
      const oldMeta=latest.get(company.id);
      const prepared=rows.map(rawRow=>{
        const incomingCustomerKey=customerKeyFor?customerKeyFor(company,rawRow):rawRow.customer_key;
        const row=rawRow.synthetic_id?{...rawRow,id:syntheticOperationID(company.id,rawRow.date,incomingCustomerKey)}:rawRow;
        return {row,incomingCustomerKey};
      });
      const ordered=[...prepared.filter(x=>!x.row.synthetic_id),...prepared.filter(x=>x.row.synthetic_id)
        .sort((a,b)=>a.row.amount_kopecks-b.row.amount_kopecks||(a.row.quantity_milli??0)-(b.row.quantity_milli??0))];
      for (const {row,incomingCustomerKey} of ordered) {
        const group=JSON.stringify([row.date,row.id.trim(),row.item.trim(),row.status]);
        const occurrence=row.occurrence===undefined?(seq.get(group)||0):row.occurrence;
        seq.set(group,Math.max(seq.get(group)||0,occurrence+1));
        const key=lineKey(row.date,row.id,row.item,row.status,occurrence,basis);
        if(basis==='paid_fulfilled'||basis==='cash_receipts'||basis==='recognized_revenue'){
          // Receipt identity, not item name: a cash export can contain
          // only the receipt total while a sold-items export has line items.
          const key=[company.id,row.date,row.id.trim(),row.status];
          const conflicting=basis==='paid_fulfilled'
            ?existingSeparate.get(...key):existingCombined.get(...key);
          if(conflicting){
            const e=Error('Эти чеки уже загружены с другим финансовым типом. Не загружайте один и тот же отчёт как оплату и как одновременно оплаченную продажу. Обратитесь в поддержку для изменения типа существующих операций.');
            e.status=409;throw e;
          }
        }
        const prev = getPrevious.get(company.id,key);
        const customerKey=incomingCustomerKey??prev?.customer_key??null;
        if (!prev) stats.added++;
        else if (prev.amount_kopecks === row.amount_kopecks && prev.quantity_milli === (row.quantity_milli??null) && prev.customer_key === customerKey) stats.unchanged++;
        else stats.updated++;
        if (!prev || prev.amount_kopecks !== row.amount_kopecks || prev.quantity_milli !== (row.quantity_milli??null) || prev.customer_key !== customerKey) {
          insert.run(company.id,row.date,row.id,row.item,row.amount_kopecks,row.status,key,basis,row.quantity_milli??null,customerKey);
          changedRows.push({key,oldAmount:prev?.amount_kopecks??null,newAmount:row.amount_kopecks,
            oldQuantity:prev?.quantity_milli??null,newQuantity:row.quantity_milli??null,oldCustomer:prev?.customer_key??null,newCustomer:customerKey});
        }
      }
      stats.total = count.get(company.id).n;
      const changed = stats.added + stats.updated > 0;
      if (oldMeta) {
        updateMeta.run(input.source.trim(),rows.length,changed?1:0,company.id);
      } else {
        createImport.run(company.id,input.source.trim(),rows.length);
      }
      const record=batchInsert.run(company.id,input.source.trim(),rows.length,
        stats.added,stats.updated,stats.unchanged,stats.total,
        oldMeta?.source??null,oldMeta?.row_count??null,
        oldMeta?.imported_at??null,oldMeta?.last_change_at??null,basis);
      const batchId=Number(record.lastInsertRowid);
      for(const row of changedRows){
        changeInsert.run(batchId,company.id,row.key,row.oldAmount,row.newAmount,row.oldQuantity,row.newQuantity,row.oldCustomer,row.newCustomer);
      }
      pruneChanges.run(company.id,company.id);
      pruneCorrectionChanges.run(company.id,company.id);
      pruneBatches.run(company.id,company.id);
      db.exec('COMMIT');
      stats.batch_id=batchId;
      stats.financial_basis=basis;
      stats.book_total=countBasis.get(company.id,basis).n;
      return stats;
    } catch(error) { db.exec('ROLLBACK');throw error; }
  }
  function history(company){
    const batches=db.prepare(
      'SELECT id,source,imported_at,received,added,updated,deleted,kind,financial_basis,unchanged,total,undone_at '+
      'FROM import_batches WHERE company_id=? ORDER BY id DESC LIMIT 20'
    ).all(company.id);
    const latestActive=batches.find(x=>!x.undone_at);
    return batches.map(x=>({
      id:x.id,source:x.source,imported_at:x.imported_at,
      received:x.received,added:x.added,updated:x.updated,deleted:x.deleted,
      kind:x.kind,financial_basis:x.financial_basis,unchanged:x.unchanged,total:x.total,undone:!!x.undone_at,
      can_undo:!x.undone_at&&x.id===latestActive?.id
    }));
  }

  function undoLatest(company,expectedId){
    if(!Number.isSafeInteger(expectedId)||expectedId<1){
      const e=Error('Неверный номер загрузки.');e.status=400;throw e;
    }
    db.exec('BEGIN IMMEDIATE');
    try{
      const latestBatch=newest.get(company.id);
      if(!latestBatch||latestBatch.id!==expectedId){
        const e=Error('Отменить можно только последнюю действующую загрузку этой компании.');
        e.status=409;throw e;
      }
      if(latestBatch.kind==='correction'){
        const changes=getCorrectionChanges.all(company.id,expectedId);
        if(changes.length!==latestBatch.added+latestBatch.updated+latestBatch.deleted){
          const e=Error('Журнал изменений для отмены не найден.');
          e.status=409;throw e;
        }
        // Check all 'after' states before touching a single operation.
        const parsed=changes.map(change=>{
          const before=change.before_row?JSON.parse(change.before_row):null;
          const after=change.after_row?JSON.parse(change.after_row):null;
          // Previous correction snapshots predate the financial_basis column.
          // They always belong to the unverified book, not to verified cash.
          if(before&&!Object.hasOwn(before,'financial_basis'))before.financial_basis='unverified';
          if(after&&!Object.hasOwn(after,'financial_basis'))after.financial_basis='unverified';
          if(before&&!Object.hasOwn(before,'quantity_milli'))before.quantity_milli=null;
          if(after&&!Object.hasOwn(after,'quantity_milli'))after.quantity_milli=null;
          const current=after?findRowId.get(company.id,after.id):null;
          // Schema migrations can append new fields in a different JSON key
          // order. Compare actual column values, not serialization order.
          const snapshotFields=['id','company_id','sold_on','source_id','item',
            'amount_kopecks','status','import_key','financial_basis','quantity_milli','customer_key'];
          if(after&&(!current||snapshotFields.some(key=>
            (current[key]??null)!==(after[key]??null)))){
            const e=Error('Операции изменились после загрузки. Отмена остановлена.');
            e.status=409;throw e;
          }
          if(!after&&before){
            const stillThere=findRowId.get(company.id,before.id);
            if(stillThere){
              const e=Error('Отменённая операция уже восстановлена или её место занято.');
              e.status=409;throw e;
            }
          }
          return {before,after};
        });
        for(const {after} of parsed)if(after){
          if(deleteExactRow.run(company.id,after.id).changes!==1)throw Error('Не удалось удалить исправленную операцию.');
        }
        for(const {before} of parsed)if(before){
          insertExactRow.run(before.id,before.company_id,before.sold_on,before.source_id,
            before.item,before.amount_kopecks,before.status,before.import_key,before.financial_basis||'unverified',before.quantity_milli??null,before.customer_key??null);
        }
      }else{
        const changes=undoChanges.all(expectedId,company.id);
        if(changes.length!==latestBatch.added+latestBatch.updated){
          const e=Error('Данные для безопасной отмены этой загрузки недоступны.');
          e.status=409;throw e;
        }
        for(const row of changes){
          const result=row.old_amount_kopecks===null
            ?removeInserted.run(company.id,row.import_key,row.new_amount_kopecks,row.new_quantity_milli,row.new_customer_key)
            :revertUpdated.run(row.old_amount_kopecks,row.old_quantity_milli,row.old_customer_key,company.id,row.import_key,row.new_amount_kopecks,row.new_quantity_milli,row.new_customer_key);
          if(result.changes!==1){
            const e=Error('Операции изменились после загрузки. Отмена остановлена.');
            e.status=409;throw e;
          }
        }
      }
      if(latestBatch.prev_source===null){
        deleteMeta.run(company.id);
      }else{
        restoreMeta.run(latestBatch.prev_source,latestBatch.prev_row_count,
          latestBatch.prev_imported_at,latestBatch.prev_last_change_at,company.id);
      }
      if(markUndone.run(expectedId,company.id).changes!==1)throw Error('Не удалось отметить отмену загрузки.');
      const total=count.get(company.id).n;
      db.exec('COMMIT');
      return {undone:true,batch_id:expectedId,removed:latestBatch.added,
        restored:latestBatch.updated+latestBatch.deleted,total};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  return { ingest,history,undoLatest };
}
