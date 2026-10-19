import { DatabaseSync } from 'node:sqlite';
import { INDUSTRIES } from './finance-summary.mjs';

// Used only by the server operator and allowlisted private Telegram commands.
export function companyAdmin({dbPath=process.env.BP_DB_FILE||'/var/lib/business-pulse/pulse.db',action,ownerId,industry,offset=0}) {
  if(!['list','set'].includes(action))throw Error('Неизвестная команда.');
  if(ownerId!==undefined&&!/^[1-9]\d{0,15}$/.test(String(ownerId)))throw Error('Нужен числовой Telegram ID владельца.');
  if(action==='set'&&(!ownerId||!Object.hasOwn(INDUSTRIES,industry)))
    throw Error('Укажите Telegram ID и отрасль: clinic, store, auto, cafe, other.');
  if(!Number.isSafeInteger(offset)||offset<0)throw Error('Неверная страница.');
  const db=new DatabaseSync(dbPath,{readOnly:action==='list'});
  try{
    db.exec('PRAGMA busy_timeout=5000');
    if(action==='list')return ownerId
      ?db.prepare('SELECT id,owner_id,name,industry FROM companies WHERE owner_id=? ORDER BY created_at,id LIMIT 20').all(String(ownerId))
      :db.prepare('SELECT id,owner_id,name,industry FROM companies ORDER BY created_at DESC,id LIMIT 20 OFFSET ?').all(offset);
    db.exec('BEGIN IMMEDIATE');
    try{
      const matches=db.prepare('SELECT id,owner_id,name,industry FROM companies WHERE owner_id=? ORDER BY created_at,id').all(String(ownerId));
      if(matches.length!==1)throw Error(matches.length?'У владельца несколько компаний: требуется назначение по ID компании оператором сервера.':'Компания не найдена. Пользователь должен сначала открыть «Моя компания».');
      const c=matches[0];
      if(c.industry!==industry){
        db.prepare('UPDATE companies SET industry=? WHERE id=?').run(industry,c.id);
        // Remove cached conclusions; an in-flight old analysis cannot overwrite a deleted version.
        if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_analyses'").get())
          db.prepare('DELETE FROM ai_analyses WHERE company_id=?').run(c.id);
      }
      db.exec('COMMIT');
      return {...c,industry};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.close();}
}

export function adminCommand(message,adminIds,options={}){
  if(message?.chat?.type!=='private'||String(message.from?.id)!==String(message.chat.id)||
     !adminIds.has(String(message.from?.id)))return null;
  const [raw,...args]=String(message.text||'').trim().split(/\s+/);
  const command=raw.split('@')[0].toLowerCase();
  if(command==='/companies'){
    if(args.length>1)throw Error('Формат: /companies [Telegram ID]');
    const rows=companyAdmin({...options,action:'list',ownerId:args[0]});
    return rows.length?rows.map(c=>c.owner_id+' · '+c.name+' · '+c.industry).join('\n')+
      '\n\nНазначить отрасль: /industry Telegram_ID clinic\nДругие отрасли: store, auto, cafe, other.\nПоказаны до 20 компаний; найти владельца: /companies Telegram_ID.'
      :'Компании не найдены.';
  }
  if(command==='/industry'){
    if(args.length!==2)throw Error('Формат: /industry Telegram_ID clinic\nОтрасли: clinic, store, auto, cafe, other.');
    const c=companyAdmin({...options,action:'set',ownerId:args[0],industry:args[1]});
    return 'Отрасль назначена: '+c.name+' · '+INDUSTRIES[c.industry].name+'\nВладелец: '+c.owner_id+'\nПоказатели обновятся при следующем открытии панели.';
  }
  return null;
}
