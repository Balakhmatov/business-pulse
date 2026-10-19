import { DatabaseSync } from 'node:sqlite';
import { INDUSTRIES } from './finance-summary.mjs';
import { ensureCompanyMembers,addCompanyMember } from './company-members.mjs';

// Used only by the server operator and allowlisted private Telegram commands.
export function companyAdmin({dbPath=process.env.BP_DB_FILE||'/var/lib/business-pulse/pulse.db',action,ownerId,industry,memberId,offset=0}) {
  if(!['list','set','members','addmember','removemember'].includes(action))throw Error('Неизвестная команда.');
  if(ownerId!==undefined&&!/^[1-9]\d{0,15}$/.test(String(ownerId)))throw Error('Нужен числовой Telegram ID владельца.');
  if(['members','addmember','removemember'].includes(action)&&!ownerId)throw Error('Укажите Telegram ID владельца компании.');
  if(['addmember','removemember'].includes(action)&&!/^[1-9]\d{0,15}$/.test(String(memberId||'')))throw Error('Нужен числовой Telegram ID сотрудника.');
  if(action==='set'&&(!ownerId||!Object.hasOwn(INDUSTRIES,industry)))
    throw Error('Укажите Telegram ID и отрасль: clinic, store, auto, cafe, other.');
  if(!Number.isSafeInteger(offset)||offset<0)throw Error('Неверная страница.');
  const db=new DatabaseSync(dbPath,{readOnly:['list','members'].includes(action)});
  try{
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    if(action==='list')return ownerId
      ?db.prepare('SELECT id,owner_id,name,industry FROM companies WHERE owner_id=? ORDER BY created_at,id LIMIT 20').all(String(ownerId))
      :db.prepare('SELECT id,owner_id,name,industry FROM companies ORDER BY created_at DESC,id LIMIT 20 OFFSET ?').all(offset);
    if(['addmember','removemember'].includes(action))ensureCompanyMembers(db);
    if(action!=='members')db.exec('BEGIN IMMEDIATE');
    try{
      const matches=db.prepare('SELECT id,owner_id,name,industry FROM companies WHERE owner_id=? ORDER BY created_at,id').all(String(ownerId));
      if(matches.length!==1)throw Error(matches.length?'У владельца несколько компаний: требуется назначение по ID компании оператором сервера.':'Компания не найдена. Пользователь должен сначала открыть «Моя компания».');
      const c=matches[0];
      if(action==='members'){
        const hasTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_members'").get();
        return {company:c,members:hasTable?db.prepare('SELECT telegram_id,created_at FROM company_members WHERE company_id=? ORDER BY created_at,telegram_id').all(c.id):[]};
      }
      if(['addmember','removemember'].includes(action)){
        memberId=String(memberId);
        if(memberId===String(c.owner_id))throw Error('Это владелец компании. Его доступ нельзя изменить как доступ сотрудника.');
        if(action==='removemember'){
          const result=db.prepare('DELETE FROM company_members WHERE telegram_id=? AND company_id=?').run(memberId,c.id);
          if(result.changes>0&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_invites'").get())
            db.prepare('UPDATE bot_invites SET expires_ms=0 WHERE company_id=? AND used_by IS NULL').run(c.id);
          db.exec('COMMIT');
          return {company:c,memberId,removed:result.changes>0};
        }
        addCompanyMember(db,c,memberId);
        db.exec('COMMIT');
        return {company:c,memberId};
      }
      if(c.industry!==industry){
        db.prepare('UPDATE companies SET industry=? WHERE id=?').run(industry,c.id);
        // Remove cached conclusions; an in-flight old analysis cannot overwrite a deleted version.
        if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_analyses'").get())
          db.prepare('DELETE FROM ai_analyses WHERE company_id=?').run(c.id);
      }
      db.exec('COMMIT');
      return {...c,industry};
    }catch(error){if(action!=='members')db.exec('ROLLBACK');throw error;}
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
      '\n\nНазначить отрасль: /industry Telegram_ID clinic\nДругие отрасли: store, auto, cafe, other.\nПодключить сотрудника: /addmember ID_руководителя ID_сотрудника\nУчастники: /members ID_руководителя\nПоказаны до 20 компаний; найти владельца: /companies Telegram_ID.'
      :'Компании не найдены.';
  }
  if(command==='/industry'){
    if(args.length!==2)throw Error('Формат: /industry Telegram_ID clinic\nОтрасли: clinic, store, auto, cafe, other.');
    const c=companyAdmin({...options,action:'set',ownerId:args[0],industry:args[1]});
    return 'Отрасль назначена: '+c.name+' · '+INDUSTRIES[c.industry].name+'\nВладелец: '+c.owner_id+'\nПоказатели обновятся при следующем открытии панели.';
  }
  if(command==='/members'){
    if(args.length!==1)throw Error('Формат: /members ID_руководителя');
    const result=companyAdmin({...options,action:'members',ownerId:args[0]});
    return 'Компания: '+result.company.name+'\nРуководитель: '+result.company.owner_id+'\n'+
      (result.members.length?result.members.map(x=>'Сотрудник: '+x.telegram_id).join('\n'):'Сотрудники пока не подключены.')+
      '\n\nПодключить: /addmember ID_руководителя ID_сотрудника\nОтключить: /removemember ID_руководителя ID_сотрудника';
  }
  if(command==='/addmember'||command==='/removemember'){
    if(args.length!==2)throw Error('Формат: '+command+' ID_руководителя ID_сотрудника');
    const result=companyAdmin({...options,action:command.slice(1),ownerId:args[0],memberId:args[1]});
    return (command==='/addmember'?'Сотрудник подключён к общей компании.':result.removed?'Доступ сотрудника отозван.':'У сотрудника нет доступа к этой компании.')+
      '\nКомпания: '+result.company.name+'\nРуководитель: '+result.company.owner_id+'\nСотрудник: '+result.memberId+
      (command==='/addmember'?'\nТеперь он может открыть «Моя компания» и загрузить отчёт. Данные и сводка общие для руководителя и сотрудника.':'');
  }
  return null;
}
