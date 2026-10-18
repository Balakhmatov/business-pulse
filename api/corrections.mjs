import { createHash,createHmac,timingSafeEqual } from 'node:crypto';
import { lineKey,financialBasis } from './accumulate.mjs';

// Conservative, explicit corrections by a single stable operation ID.
// Missing lines in a partial export are NEVER treated as cancellations.
// A receipt with multiple products sharing the same ID is intentionally rejected.
const MAX_ROWS=1000;
const TOKEN_LIFETIME_MS=10*60*1000;
const error=(message,status=400)=>Object.assign(new Error(message),{status});
function dayOK(value,nowMs){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=Date.parse(value+'T00:00:00Z');
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==value)return false;
  const today=new Date(nowMs);
  return parsed<=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()) &&
    parsed>=nowMs-731*86400000;
}
function canonical(input,nowMs){
  if(!input||typeof input!=='object'||Array.isArray(input))throw error('Некорректный запрос на сверку.');
  if(typeof input.source!=='string'||!input.source.trim()||input.source.length>120)throw error('Название источника не указано.');
  if(!Array.isArray(input.rows)||!Array.isArray(input.cancelled_ids))throw error('Отсутствуют операции для сверки.');
  if(input.rows.length+input.cancelled_ids.length<1||
     input.rows.length+input.cancelled_ids.length>MAX_ROWS)
    throw error('В одном пакете исправлений допускается от 1 до '+MAX_ROWS+' операций.');
  const ids=new Set();
  const rows=input.rows.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row)||
       !dayOK(row.date,nowMs)||typeof row.id!=='string'||
       !row.id.trim()||row.id.length>100||typeof row.item!=='string'||
       !row.item.trim()||row.item.length>140||!Number.isSafeInteger(row.amount_kopecks)||
       !row.amount_kopecks||Math.abs(row.amount_kopecks)>1e12||
       !(row.quantity_milli===undefined||row.quantity_milli===null||
         (Number.isSafeInteger(row.quantity_milli)&&row.quantity_milli>0&&row.quantity_milli<=1000000000))||
       !['sale','refund'].includes(row.status)||
       (row.status==='sale'&&row.amount_kopecks<0)||
       (row.status==='refund'&&row.amount_kopecks>0))
      throw error('Некорректная строка в запросе на сверку.');
    const id=row.id.trim();
    if(ids.has(id))throw error('Для сверки нужен уникальный ID каждой операции. Повторяется: '+id.slice(0,32));
    ids.add(id);
    return {date:row.date,id,item:row.item.trim(),amount_kopecks:row.amount_kopecks,status:row.status,
      quantity_milli:row.quantity_milli??null};
  });
  const cancelled=input.cancelled_ids.map(v=>{
    const id=typeof v==='string'?v.trim():'';
    if(!id||id.length>100)throw error('Пустой или слишком длинный ID отменённой операции.');
    if(ids.has(id))throw error('Операция '+id.slice(0,32)+' одновременно присутствует и отменена. Проверьте выгрузку.');
    ids.add(id);
    return id;
  });
  return {source:input.source.trim(),financial_basis:financialBasis(input.financial_basis),
    rows:rows.sort((a,b)=>a.id.localeCompare(b.id)),cancelled_ids:cancelled.sort()};
}
const rowEqual=(a,b)=>a.sold_on===b.sold_on&&a.item===b.item&&
  a.status===b.status&&a.amount_kopecks===b.amount_kopecks&&
  (a.quantity_milli??null)===(b.quantity_milli??null);
export function createCorrectionService({db,secret,now=()=>Date.now()}){
  if(typeof secret!=='string'||secret.length<20)throw Error('Signed correction confirmation requires an API secret.');
  const existing=db.prepare(
    'SELECT id,company_id,sold_on,source_id,item,amount_kopecks,status,import_key,financial_basis,quantity_milli '+
    'FROM operations WHERE company_id=? AND financial_basis=? AND source_id=? ORDER BY id LIMIT 2'
  );
  const maxBatch=db.prepare('SELECT MAX(id) AS id FROM import_batches WHERE company_id=?');
  const insert=db.prepare(
    'INSERT INTO operations(company_id,sold_on,source_id,item,amount_kopecks,status,import_key,financial_basis,quantity_milli) VALUES(?,?,?,?,?,?,?,?,?)'
  );
  const update=db.prepare(
    'UPDATE operations SET sold_on=?,item=?,amount_kopecks=?,status=?,import_key=?,quantity_milli=? WHERE company_id=? AND id=?'
  );
  const remove=db.prepare('DELETE FROM operations WHERE company_id=? AND id=?');
  const selectById=db.prepare(
    'SELECT id,company_id,sold_on,source_id,item,amount_kopecks,status,import_key,financial_basis,quantity_milli FROM operations WHERE company_id=? AND id=?'
  );
  const currentTotal=db.prepare('SELECT COUNT(*) AS n FROM operations WHERE company_id=? AND financial_basis=?');
  const importMeta=db.prepare('SELECT source,row_count,imported_at,last_change_at FROM imports WHERE company_id=?');
  const saveBatch=db.prepare(
    'INSERT INTO import_batches(company_id,source,received,added,updated,unchanged,total,'+
    'prev_source,prev_row_count,prev_imported_at,prev_last_change_at,deleted,kind,financial_basis) '+
    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'correction',?)"
  );
  const saveChange=db.prepare(
    'INSERT INTO operation_correction_changes(batch_id,company_id,source_id,before_row,after_row) VALUES(?,?,?,?,?)'
  );
  const updateMeta=db.prepare(
    'UPDATE imports SET imported_at=CURRENT_TIMESTAMP,source=?,row_count=?,last_change_at=CURRENT_TIMESTAMP WHERE company_id=?'
  );
  const addMeta=db.prepare(
    'INSERT INTO imports(company_id,source,row_count,last_change_at) VALUES(?,?,?,CURRENT_TIMESTAMP)'
  );
  const prune=db.prepare(
    'DELETE FROM operation_correction_changes WHERE company_id=? AND batch_id NOT IN ('+
    'SELECT id FROM import_batches WHERE company_id=? AND undone_at IS NULL ORDER BY id DESC LIMIT 5)'
  );
  function plan(company,data){
    const changes=[],samples=[],totals={added:0,updated:0,deleted:0,unchanged:0,moved:0};
    for(const row of data.rows){
      const hits=existing.all(company.id,data.financial_basis,row.id);
      if(hits.length>1)throw error('ID '+row.id.slice(0,32)+' соответствует нескольким строкам. Нужен отдельный ID каждой позиции.',409);
      const before=hits[0]||null;
      const after={sold_on:row.date,source_id:row.id,item:row.item,amount_kopecks:row.amount_kopecks,
        status:row.status,import_key:lineKey(row.date,row.id,row.item,row.status,0,data.financial_basis),
        financial_basis:data.financial_basis,quantity_milli:row.quantity_milli};
      if(!before)totals.added++;
      else if(rowEqual(before,after))totals.unchanged++;
      else{
        totals.updated++;
        if(before.sold_on!==after.sold_on)totals.moved++;
      }
      if(!before||!rowEqual(before,after)){
        changes.push({id:row.id,before,after});
        if(samples.length<8)samples.push({
          id:row.id,change:!before?'Добавить':before.sold_on!==after.sold_on?'Перенос даты':'Исправить',
          old_date:before?.sold_on||null,new_date:after.sold_on,
          old_amount_kopecks:before?.amount_kopecks??null,new_amount_kopecks:after.amount_kopecks
        });
      }
    }
    for(const id of data.cancelled_ids){
      const hits=existing.all(company.id,data.financial_basis,id);
      if(hits.length!==1)throw error(hits.length?'Одна отмена соответствует нескольким строкам: '+id.slice(0,32):
        'Нет ранее загруженной операции с ID '+id.slice(0,32)+'. Отменять нечего.',409);
      totals.deleted++;
      changes.push({id,before:hits[0],after:null});
      if(samples.length<8)samples.push({id,change:'Отменить',old_date:hits[0].sold_on,new_date:null,
        old_amount_kopecks:hits[0].amount_kopecks,new_amount_kopecks:null});
    }
    const revision=Number(maxBatch.get(company.id).id||0);
    const digest=createHash('sha256').update(JSON.stringify({company:company.id,data,changes,revision})).digest('hex');
    return {totals,changes,samples,digest};
  }
  const signature=(company,digest,expires)=>
    createHmac('sha256',secret).update(JSON.stringify([company.id,digest,expires])).digest('hex');
  function preview(company,input){
    const data=canonical(input,now());
    const result=plan(company,data);
    const expires_at_ms=now()+TOKEN_LIFETIME_MS;
    return {summary:result.totals,examples:result.samples,expires_at_ms,
      confirm_token:signature(company,result.digest,expires_at_ms),
      can_apply:result.changes.length>0};
  }
  function apply(company,input){
    if(!Number.isSafeInteger(input?.expires_at_ms)||input.expires_at_ms<=now()||
       input.expires_at_ms>now()+TOKEN_LIFETIME_MS||
       typeof input?.confirm_token!=='string'||!/^[a-f0-9]{64}$/.test(input.confirm_token))
      throw error('Срок предварительной проверки истёк. Проверьте изменения повторно.',409);
    const data=canonical(input,now());
    db.exec('BEGIN IMMEDIATE');
    try{
      const result=plan(company,data);
      const valid=signature(company,result.digest,input.expires_at_ms);
      if(!timingSafeEqual(Buffer.from(valid,'hex'),Buffer.from(input.confirm_token,'hex')))
        throw error('Данные изменились после предварительной проверки. Повторите сверку.',409);
      if(!result.changes.length){
        db.exec('COMMIT');
        return {changed:false,stats:{...result.totals,total:currentTotal.get(company.id,data.financial_basis).n}};
      }
      const prev=importMeta.get(company.id);
      const changes=[];
      for(const action of result.changes){
        let after=null;
        if(!action.after){
          if(remove.run(company.id,action.before.id).changes!==1)throw error('Отмена операции не удалась.',409);
        }else if(action.before){
          const a=action.after;
          if(update.run(a.sold_on,a.item,a.amount_kopecks,a.status,a.import_key,a.quantity_milli,
            company.id,action.before.id).changes!==1)throw error('Исправление операции не выполнено.',409);
          after=selectById.get(company.id,action.before.id);
        }else{
          const a=action.after;
          const created=insert.run(company.id,a.sold_on,a.source_id,a.item,a.amount_kopecks,a.status,a.import_key,data.financial_basis,a.quantity_milli);
          after=selectById.get(company.id,Number(created.lastInsertRowid));
        }
        changes.push({id:action.id,before:action.before,after});
      }
      const total=currentTotal.get(company.id,data.financial_basis).n;
      if(prev)updateMeta.run(data.source,data.rows.length,company.id);
      else addMeta.run(company.id,data.source,data.rows.length);
      const b=saveBatch.run(company.id,data.source,data.rows.length+data.cancelled_ids.length,
        result.totals.added,result.totals.updated,result.totals.unchanged,total,
        prev?.source??null,prev?.row_count??null,
        prev?.imported_at??null,prev?.last_change_at??null,result.totals.deleted,data.financial_basis);
      const batch_id=Number(b.lastInsertRowid);
      for(const change of changes){
        saveChange.run(batch_id,company.id,change.id,
          change.before?JSON.stringify(change.before):null,
          change.after?JSON.stringify(change.after):null);
      }
      prune.run(company.id,company.id);
      db.exec('COMMIT');
      return {changed:true,batch_id,stats:{...result.totals,total}};
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  return {preview,apply};
}
