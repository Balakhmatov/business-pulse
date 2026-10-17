import { createHash } from 'node:crypto';

// Incremental, company-scoped import layer.
// Identity: date + receipt ID + item + sale/refund + occurrence within receipt/item.
// This assumes stable receipt IDs and stable line ordering if several same-name
// items exist within a receipt. A future explicit line ID will remove that caveat.
export function lineKey(date, id, item, status, occurrence) {
  return createHash('sha256').update(JSON.stringify([
    date, id.trim(), item.trim(), status, occurrence
  ])).digest('hex');
}
export function createAccumulator(db) {
  const operationColumns = db.prepare('PRAGMA table_info(operations)').all().map(c => c.name);
  const importColumns = db.prepare('PRAGMA table_info(imports)').all().map(c => c.name);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!operationColumns.includes('import_key')) db.exec('ALTER TABLE operations ADD COLUMN import_key TEXT');
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
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}

  const insert = db.prepare(
    'INSERT INTO operations(company_id,sold_on,source_id,item,amount_kopecks,status,import_key) ' +
    'VALUES(?,?,?,?,?,?,?) ON CONFLICT(company_id,import_key) DO UPDATE SET ' +
    'amount_kopecks=excluded.amount_kopecks,source_id=excluded.source_id,item=excluded.item ' +
    'WHERE operations.amount_kopecks<>excluded.amount_kopecks ' +
    'OR operations.source_id<>excluded.source_id OR operations.item<>excluded.item'
  );
  const getPrevious = db.prepare('SELECT amount_kopecks FROM operations WHERE company_id=? AND import_key=?');
  const count = db.prepare('SELECT count(*) AS n FROM operations WHERE company_id=?');
  const latest = db.prepare('SELECT company_id FROM imports WHERE company_id=?');
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
    const seq = new Map(), keyed = [];
    for (const row of rows) {
      const group = JSON.stringify([row.date,row.id.trim(),row.item.trim(),row.status]);
      const occurrence = seq.get(group) || 0;
      seq.set(group,occurrence + 1);
      keyed.push({ row, key: lineKey(row.date,row.id,row.item,row.status,occurrence) });
    }
    const stats = {received:rows.length,added:0,updated:0,unchanged:0,total:0};
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of keyed) {
        const {row,key} = entry;
        const prev = getPrevious.get(company.id,key);
        if (!prev) stats.added++;
        else if (prev.amount_kopecks === row.amount_kopecks) stats.unchanged++;
        else stats.updated++;
        if (!prev || prev.amount_kopecks !== row.amount_kopecks) {
          insert.run(company.id,row.date,row.id,row.item,row.amount_kopecks,row.status,key);
        }
      }
      stats.total = count.get(company.id).n;
      const changed = stats.added + stats.updated > 0;
      if (latest.get(company.id)) {
        updateMeta.run(input.source.trim(),rows.length,changed?1:0,company.id);
      } else {
        createImport.run(company.id,input.source.trim(),rows.length);
      }
      db.exec('COMMIT');
      return stats;
    } catch(error) { db.exec('ROLLBACK');throw error; }
  }
  return { ingest };
}
