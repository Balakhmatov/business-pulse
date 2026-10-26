// A company owner may erase its imported operational data without deleting
// the company itself, account, payment history, employees or subscription.
// Ownership is resolved before calling this function (and checked again here).
export function clearCompanyData(db,company,actor,confirmation){
  if(company.access_role!=='owner'){
    const error=new Error('Очистить данные может только владелец компании.');
    error.status=403;throw error;
  }
  if(confirmation!=='DELETE_ALL_COMPANY_DATA'){
    const error=new Error('Подтвердите удаление всех данных компании.');
    error.status=400;throw error;
  }
  db.exec('BEGIN IMMEDIATE');
  try{
    const removed=db.prepare('DELETE FROM operations WHERE company_id=?').run(company.id).changes;
    // Remove undo snapshots too, so cleared transactions cannot be restored.
    for(const table of ['import_batch_changes','operation_correction_changes','import_batches','imports','ai_analyses','import_mapping_templates','import_mapping_suggestions']){
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        db.prepare('DELETE FROM '+table+' WHERE company_id=?').run(company.id);
    }
    db.exec('COMMIT');return {removed};
  }catch(error){db.exec('ROLLBACK');throw error;}
}

// Clear only a personal company's recognizable synthetic fixtures, never arbitrary business data.
// The API authenticates the Telegram user and chooses the company before calling this function.
const TEST_SOURCE = /синтетич|тестов|demo|sample|пример/i;
const TEST_ID = /^(?:DEMO-(?:\d{1,2}-\d+|\d{4}-\d{2}-\d{2}-\d+)|REF-(?:\d{1,2}|\d{4}-\d{2}-\d{2}))$/;

export function resetTestData(db, companyId) {
  const getSource=db.prepare('SELECT source FROM imports WHERE company_id=?');
  const rows=db.prepare('SELECT source_id FROM operations WHERE company_id=?');
  const delOperations=db.prepare('DELETE FROM operations WHERE company_id=?');
  const delImports=db.prepare('DELETE FROM imports WHERE company_id=?');
  const delAI=db.prepare('DELETE FROM ai_analyses WHERE company_id=?');
  const batchesExist=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_batches'").get();
  const delBatches=batchesExist?db.prepare('DELETE FROM import_batches WHERE company_id=?'):null;
  const source=getSource.get(companyId)?.source || '';
  const entries=rows.all(companyId);
  if (!TEST_SOURCE.test(source) || !entries.length || !entries.every(x=>TEST_ID.test(x.source_id))) {
    const error=new Error('Очистка доступна только для полностью тестового набора данных. Другие операции не изменены.');
    error.status=409;
    throw error;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const removed=delOperations.run(companyId).changes;
    delImports.run(companyId);
    delAI.run(companyId);
    if(delBatches)delBatches.run(companyId); // Do not allow undo to resurrect cleared test transactions.
    db.exec('COMMIT');
    return {removed};
  } catch(e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

