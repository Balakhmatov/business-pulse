import { ensurePaymentLinks,paymentCatalog,savePaymentLink } from '../api/payment-links.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes,randomInt,randomUUID,createHash } from 'node:crypto';
import { ensureCompanyMembers,companyForUser,addCompanyMember } from '../api/company-members.mjs';
import { companyAdmin } from '../api/company-admin.mjs';
import { INDUSTRIES } from '../api/finance-summary.mjs';
import { validNotificationHour } from './notification-schedule.mjs';
import { createChatCleanup } from './chat-cleanup.mjs';
import { ensureBillingSchema,ensureCompanyBilling,subscriptionFor,pricesText,PLANS,rub,mskDate,paymentConfirmation,confirmReceivedPayment,reminderFor,trialReminderText } from '../api/billing.mjs';

const button=(text,data)=>({text,callback_data:'bpu:'+data});
const idOK=value=>/^[1-9]\d{0,15}$/.test(String(value||''));
const profileText=user=>[clean([user.last_name,user.first_name].filter(Boolean).join(' ')),user.username?'@'+clean(user.username):'Ник: не указан','Telegram ID: '+user.id].filter(Boolean).join('\n');
const hash=value=>createHash('sha256').update(value).digest('hex');
const clean=value=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,100);

export function createBotControls({api:transport,adminIds,appUrl,botUsername,dbPath=process.env.BP_DB_FILE||'/var/lib/business-pulse/pulse.db',now=Date.now,defaultHour=9,timeZone='Europe/Moscow',isSubscribed=()=>false,supportId=process.env.BP_SUPPORT_ID||'1296951270'}){
  supportId=String(supportId);
  if(!idOK(supportId))throw Error('Некорректный аккаунт поддержки.');
  if(!validNotificationHour(defaultHour))throw Error('Некорректное время уведомлений.');
  const db=new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  ensureCompanyMembers(db);
  ensureBillingSchema(db,now());
  ensurePaymentLinks(db);
  db.exec('CREATE TABLE IF NOT EXISTS notification_preferences (telegram_id TEXT PRIMARY KEY REFERENCES users(telegram_id),hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23));');
  db.exec('CREATE TABLE IF NOT EXISTS bot_profiles (telegram_id TEXT PRIMARY KEY,display_name TEXT NOT NULL,username TEXT NOT NULL);'+
    'CREATE TABLE IF NOT EXISTS bot_contact_requests (actor_id TEXT PRIMARY KEY,request_id INTEGER NOT NULL,owner_id TEXT,kind TEXT NOT NULL,expires_ms INTEGER NOT NULL);'+
    'CREATE TABLE IF NOT EXISTS bot_invites (token_hash TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,owner_id TEXT NOT NULL,issued_by TEXT NOT NULL,target_id TEXT,expires_ms INTEGER NOT NULL,used_by TEXT);');
  db.exec('CREATE TABLE IF NOT EXISTS bot_menu_panels (chat_id TEXT PRIMARY KEY,message_id INTEGER NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS bot_support_sessions (actor_id TEXT PRIMARY KEY,expires_ms INTEGER NOT NULL);'+
    'CREATE TABLE IF NOT EXISTS bot_support_routes (support_id TEXT NOT NULL,message_id INTEGER NOT NULL,actor_id TEXT NOT NULL,created_ms INTEGER NOT NULL,PRIMARY KEY(support_id,message_id));');
  const cleanup=createChatCleanup({db,api:transport,now});
  const api=async(method,payload)=>{
    const result=await transport(method,payload);
    if(method==='sendMessage'||method==='copyMessage')cleanup.remember(payload.chat_id,result?.message_id,result?.date);
    return result;
  };
  function profile(user){
    if(!idOK(user?.id))return;
    const id=String(user.id);
    const old=db.prepare('SELECT display_name,username FROM bot_profiles WHERE telegram_id=?').get(id);
    const name=clean([user.first_name,user.last_name].filter(Boolean).join(' '))||old?.display_name||'Пользователь';
    db.prepare('INSERT OR IGNORE INTO users(telegram_id) VALUES(?)').run(id);
    db.prepare('INSERT INTO bot_profiles VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET display_name=excluded.display_name,username=excluded.username').run(id,name,user.username===undefined?(old?.username||''):clean(user.username));
  }
  function name(id){
    const p=db.prepare('SELECT display_name,username FROM bot_profiles WHERE telegram_id=?').get(String(id));
    return p?(p.display_name+(p.username?' · @'+p.username:'')):'Аккаунт '+id;
  }
  function workspace(actor){
    let c=companyForUser(db,actor);
    if(!c){
      db.prepare('INSERT OR IGNORE INTO users(telegram_id) VALUES(?)').run(actor);
      db.prepare('INSERT INTO companies(id,owner_id,name,industry) VALUES(?,?,?,?)').run(randomUUID(),actor,'Моя компания','other');
      c=companyForUser(db,actor);
    }
    ensureCompanyBilling(db,c,now());
    return c;
  }
  function owned(owner){
    if(!idOK(owner))throw Error('Компания не найдена. Откройте список заново.');
    const rows=db.prepare('SELECT * FROM companies WHERE owner_id=? ORDER BY created_at,id').all(owner);
    if(rows.length!==1)throw Error('Не удалось однозначно выбрать компанию. Обратитесь к администратору.');
    return rows[0];
  }
  function access(actor,owner,adminOnly=false){
    const c=owned(owner);
    if(!adminIds.has(actor)&&(adminOnly||actor!==owner||companyForUser(db,actor)?.id!==c.id))
      throw Error('У вас нет доступа к этому действию.');
    return c;
  }
  function setPanel(actor,messageId){
    if(Number.isSafeInteger(messageId)&&messageId>0)
      db.prepare('INSERT INTO bot_menu_panels VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET message_id=excluded.message_id').run(String(actor),messageId);
  }
  async function send(actor,text,rows,options={}){
    const reply_markup={inline_keyboard:rows||[[button('В меню','home')]]};
    const panel=db.prepare('SELECT message_id FROM bot_menu_panels WHERE chat_id=?').get(String(actor));
    if(panel){
      try{
        const result=await api('editMessageText',{chat_id:actor,message_id:panel.message_id,text,...options,disable_web_page_preview:true,reply_markup});
        return result&&typeof result==='object'?result:{message_id:panel.message_id};
      }catch(error){
        if(/message is not modified/i.test(error.message))return {message_id:panel.message_id};
        if(!/message to edit not found|can't be edited|cannot be edited/i.test(error.message))throw error;
        db.prepare('DELETE FROM bot_menu_panels WHERE chat_id=?').run(String(actor));
      }
    }
    const result=await api('sendMessage',{chat_id:actor,text,...options,disable_web_page_preview:true,reply_markup});
    setPanel(actor,result?.message_id);
    return result;
  }
  const zoneLabel=timeZone==='Europe/Moscow'?'МСК':timeZone;
  const hourLabel=hour=>String(hour).padStart(2,'0')+':00';
  function notificationHour(actor){
    return db.prepare('SELECT hour FROM notification_preferences WHERE telegram_id=?').get(String(actor))?.hour??defaultHour;
  }
  function notifications(actor,prefix=''){
    return send(actor,prefix+'Уведомления\n\n'+(isSubscribed(actor)?'Включены':'Отключены')+'\nВремя отправки: '+hourLabel(notificationHour(actor))+' ('+zoneLabel+').\nЕжедневная сводка по вашей компании.',
      [[{text:'Включить уведомление',callback_data:'bp:subscribe'},{text:'Отключить уведомление',callback_data:'bp:unsubscribe'}],
        [button('Установить время','hours')],[button('В меню','home')]]);
  }
  function card(actor,c,prefix=''){
    const rows=[];
    if(adminIds.has(actor)){
      rows.push([button('Выбрать отрасль','i:'+c.owner_id)]);
      rows.push([button('Подписка и подтверждение оплаты','bill:'+c.owner_id)]);
    }
    if(adminIds.has(actor)||actor===c.owner_id)rows.push([button('Сотрудники','m:'+c.owner_id)]);
    rows.push([button('В меню','home')]);
    return send(actor,prefix+c.name+'\nРуководитель: '+name(c.owner_id)+'\nОтрасль: '+(INDUSTRIES[c.industry]?.name||'Универсальный'),rows);
  }
  async function home(actor,refresh=false,suffix=''){
    const c=workspace(actor);
    const rows=[[{text:'Открыть Бизнес Пульс',web_app:{url:appUrl}}],
      [{text:'Моя сводка',callback_data:'bp:report'},button('Уведомления','notify')]];
    if(c.access_role==='owner')rows.push([button('Сотрудники','m:'+c.owner_id)]);
    rows.push([button('Мой профиль и ID','id')]);
    if(adminIds.has(actor)){
      rows.push([button('Управление компаниями','list:0')]);
      rows.push([button('Проверить уведомления','testnotices')]);
      rows.push([button('Настроить оплату СБП','paylinks')]);
    }
    rows.push([button('Поддержка','support'),button('Очистить чат','clear')]);
    rows.push([button('Цены','prices')]);
    const subscription=subscriptionFor(db,c,now());
    const accessNote=subscription.state==='trial'?'\n\n48 часов бесплатно — до '+mskDate(subscription.trial_ends_ms)+'.\nПервый месяц за 1 990 ₽ при оплате в тестовый период (скидка 20%).':subscription.state==='paid'?'\n\nПодписка до '+mskDate(subscription.paid_until_ms)+'.':subscription.state==='expired'?'\n\nТестовый период или подписка завершились. Данные сохранены. Тарифы — в разделе «Цены».':'';
    const text='Бизнес Пульс\n\n'+c.name+'\n'+(c.access_role==='member'?'Вы подключены как сотрудник.':'Управление компанией и отчётами.')+accessNote+suffix;
    if(refresh&&cleanup.welcome(actor)){
      try{
        const result=await api('editMessageText',{chat_id:actor,message_id:cleanup.welcome(actor),text,reply_markup:{inline_keyboard:rows}});
        setPanel(actor,cleanup.welcome(actor));return result;
      }
      catch(error){
        if(/message is not modified/i.test(error.message)){setPanel(actor,cleanup.welcome(actor));return;}
        if(!/message to edit not found|can't be edited|cannot be edited/i.test(error.message))throw error;
        cleanup.forgetWelcome(actor);
      }
    }
    const sent=await send(actor,text,rows);
    cleanup.keepWelcome(actor,sent?.message_id);
    return sent;
  }

  function members(actor,owner,offset=0){
    if(!Number.isSafeInteger(offset)||offset<0)throw Error('Откройте список сотрудников заново.');
    const c=access(actor,owner);
    const list=db.prepare('SELECT telegram_id FROM company_members WHERE company_id=? ORDER BY created_at,telegram_id LIMIT 21 OFFSET ?').all(c.id,offset);
    const page=list.slice(0,20);
    const rows=[[button('Выбрать сотрудника в Telegram','pick:'+owner)],
      [button('Пригласить по ссылке','invite:'+owner)]];
    for(const member of page)rows.push([button('Отключить: '+name(member.telegram_id).slice(0,40),'remove:'+owner+':'+member.telegram_id)]);
    const nav=[];if(offset>0)nav.push(button('Предыдущие','m:'+owner+':'+Math.max(0,offset-20)));if(list.length>20)nav.push(button('Далее','m:'+owner+':'+(offset+20)));if(nav.length)rows.push(nav);
    rows.push([button('Назад','c:'+owner)]);
    return send(actor,c.name+'\nРуководитель: '+name(owner)+'\n\n'+(page.length?page.map(x=>'Сотрудник: '+name(x.telegram_id)).join('\n'):'Сотрудники пока не подключены.')+'\n\nПриглашённый сотрудник сможет смотреть показатели и загружать отчёты.',rows);
  }
  async function pick(actor,owner,kind){
    if(kind==='client'){if(!adminIds.has(actor))throw Error('Доступно только администратору.');}
    else access(actor,owner);
    const requestId=randomInt(1,2147483647);
    db.prepare('INSERT INTO bot_contact_requests VALUES(?,?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET request_id=excluded.request_id,owner_id=excluded.owner_id,kind=excluded.kind,expires_ms=excluded.expires_ms')
      .run(actor,requestId,owner||null,kind,now()+15*60000);
    await api('sendMessage',{chat_id:actor,text:kind==='client'?'Выберите руководителя компании в Telegram.':'Выберите сотрудника в Telegram. После выбора появится приглашение для него.',
      reply_markup:{keyboard:[[{text:kind==='client'?'Выбрать клиента':'Выбрать сотрудника',request_users:{request_id:requestId,user_is_bot:false,max_quantity:1,request_name:true,request_username:true}}],[{text:'Отмена'}]],resize_keyboard:true,one_time_keyboard:true}});
    return send(actor,'Если выбор человека недоступен в вашей версии Telegram, используйте ссылку.',kind==='client'?[[{text:'Открыть бота',url:'https://t.me/'+botUsername}],[button('В меню','home')]]:[[button('Приглашение по ссылке','invite:'+owner)],[button('Отмена','cancel')]]);
  }
  function newInvite(actor,owner,targetId=null){
    const c=access(actor,owner);
    if(targetId&&targetId===owner)throw Error('Руководитель уже имеет доступ к компании.');
    // Latest invitation replaces pending links for this company. No unbounded live links.
    db.prepare('DELETE FROM bot_invites WHERE expires_ms<?').run(now()-30*86400000);
    db.prepare('DELETE FROM bot_invites WHERE company_id=? AND used_by IS NULL').run(c.id);
    const token=randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO bot_invites VALUES(?,?,?,?,?,?,NULL)').run(hash(token),c.id,owner,actor,targetId,now()+86400000);
    return token;
  }
  function invitation(actor,owner,targetId=null){
    const token=newInvite(actor,owner,targetId),url='https://t.me/'+botUsername+'?start=join_'+token;
    const draft='Приглашаю вас в компанию в «Бизнес Пульсе». Откройте ссылку и нажмите «Подключиться».\n'+url;
    const share='https://t.me/share/url?url='+encodeURIComponent(url)+'&text='+encodeURIComponent('Приглашаю вас в компанию в «Бизнес Пульсе». Откройте ссылку и нажмите «Подключиться».');
    const username=targetId?db.prepare('SELECT username FROM bot_profiles WHERE telegram_id=?').get(targetId)?.username:null;
    const direct=username&&/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(username)?'https://t.me/'+username+'?text='+encodeURIComponent(draft):null;
    const rows=[[{text:'Отправить приглашение',url:direct||share}]];
    if(direct)rows.push([{text:'Отправить другим способом',url:share}]);
    rows.push([button('Отменить приглашение','revoke:'+owner)],[button('К сотрудникам','m:'+owner)]);
    return send(actor,(targetId?'Приглашение для '+name(targetId):'Приглашение сотрудника')+'\n\n'+
      (direct?'Нажмите «Отправить приглашение»: откроется чат выбранного сотрудника с готовым сообщением. Останется нажать отправку.':'Нажмите «Отправить приглашение» и выберите получателя.')+
      ' Ему останется открыть ссылку и подтвердить подключение.\n\nСсылка действует 24 часа и используется один раз. Новое приглашение заменяет предыдущее.',rows);
  }

  function inviteRecord(actor,token){
    if(!/^[A-Za-z0-9_-]{32}$/.test(token||''))throw Error('Приглашение недействительно. Попросите новую ссылку.');
    const row=db.prepare('SELECT * FROM bot_invites WHERE token_hash=?').get(hash(token));
    if(!row||row.expires_ms<=now())throw Error('Приглашение истекло или отменено. Попросите новую ссылку.');
    if(row.target_id&&row.target_id!==actor)throw Error('Это приглашение предназначено другому человеку.');
    if(row.used_by&&row.used_by!==actor)throw Error('Приглашение уже использовано.');
    const c=owned(row.owner_id);
    if(c.id!==row.company_id||(!adminIds.has(row.issued_by)&&!(row.issued_by===row.owner_id&&companyForUser(db,row.issued_by)?.id===c.id)))
      throw Error('Приглашение больше недействительно.');
    return {row,c};
  }
  async function previewInvite(actor,token){
    const {row,c}=inviteRecord(actor,token);
    if(row.used_by){
      if(companyForUser(db,actor)?.id!==c.id)throw Error('Это приглашение уже использовано. Попросите новое.');
      return home(actor);
    }
    return send(actor,'Вас приглашают в компанию «'+c.name+'».\nРуководитель: '+name(c.owner_id)+'\n\nПосле подключения вы сможете загружать отчёты и смотреть общие показатели.',[[button('Подключиться','join:'+token)],[button('Отмена','home')]]);
  }
  async function acceptInvite(actor,token){
    db.exec('BEGIN IMMEDIATE');
    try{
      const {row,c}=inviteRecord(actor,token);
      if(row.used_by){if(companyForUser(db,actor)?.id!==c.id)throw Error('Приглашение уже использовано.');}
      else{
        addCompanyMember(db,c,actor);
        db.prepare('UPDATE bot_invites SET used_by=? WHERE token_hash=? AND used_by IS NULL').run(actor,hash(token));
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return home(actor);
  }
  function support(actor){
    db.prepare('INSERT INTO bot_support_sessions VALUES(?,?) ON CONFLICT(actor_id) DO UPDATE SET expires_ms=excluded.expires_ms').run(actor,now()+30*60000);
    return send(actor,'Поддержка\n\nНапишите вопрос следующим сообщением. Можно приложить скриншот, документ или голосовое сообщение. Мы ответим здесь, в боте.\n\nНе отправляйте пароли, данные банковских карт и персональные сведения пациентов или покупателей.',[[button('Отмена','supportcancel')]]);
  }
  const copyable=m=>Boolean(m.text||m.photo||m.document||m.voice||m.audio||m.video||m.animation||m.sticker||m.video_note);
  async function supportMessage(actor,message,route){
    if(!copyable(message)||!Number.isSafeInteger(message.message_id))throw Error('Отправьте текст, фото, документ или голосовое сообщение.');
    if(route){
      await api('copyMessage',{chat_id:route.actor_id,from_chat_id:actor,message_id:message.message_id,
        reply_markup:{inline_keyboard:[[button('Ответить в поддержку','support')]]}});
      await api('sendMessage',{chat_id:actor,text:'Ответ отправлен клиенту.'});
      return;
    }
    const c=companyForUser(db,actor);
    const header=await api('sendMessage',{chat_id:supportId,text:'Обращение в поддержку «Бизнес Пульс»\n\n'+name(actor)+'\nTelegram ID: '+actor+(c?'\nКомпания: '+c.name:'')+'\n\nЧтобы ответить клиенту, используйте «Ответить» на этом сообщении или на сообщении ниже.'});
    const save=id=>{if(Number.isSafeInteger(id))db.prepare('INSERT OR REPLACE INTO bot_support_routes VALUES(?,?,?,?)').run(supportId,id,actor,now());};
    save(header?.message_id);
    await api('copyMessage',{chat_id:supportId,from_chat_id:actor,message_id:message.message_id}).then(result=>save(result?.message_id));
    db.prepare('DELETE FROM bot_support_sessions WHERE actor_id=?').run(actor);
    db.prepare('DELETE FROM bot_support_routes WHERE created_ms<?').run(now()-30*24*3600000);
    await send(actor,'Сообщение отправлено в поддержку. Ответ придёт сюда, в бота.',[[button('Написать ещё','support')],[button('В меню','home')]]);
  }
  function paymentLinks(actor){
    if(!adminIds.has(actor))throw Error('Доступно только администратору.');
    const rows=paymentCatalog(db).map(p=>[button(p.name+' · '+rub(p.price)+(p.payment_url?' · подключено':' · нет ссылки'),'paylink:'+p.id)]);
    rows.push([button('В меню','home')]);
    return send(actor,'Оплата по СБП\n\nСоздайте в ЮKassa платёжную ссылку на точную сумму каждого тарифа с описанием «Подписка Бизнес Пульс» и нужным сроком. Убедитесь, что на странице доступна СБП. Затем выберите тариф и пришлите ссылку.\n\nЭто внешние платёжные страницы. Подписка включается после вашей проверки поступления денег. Секретные ключи отправлять не нужно.',rows);
  }
  function paymentUrl(){
    return 'https://t.me/'+botUsername+'?startapp=payment';
  }
  function prices(actor){
    const c=workspace(actor),s=subscriptionFor(db,c,now());
    return send(actor,pricesText(s),[[{text:'Перейти к оплате',url:paymentUrl()}],[button('В меню','home')]],{parse_mode:'HTML'});
  }
  function billingCard(actor,owner,prefix=''){
    const c=access(actor,owner,true),s=subscriptionFor(db,c,now());
    const rows=Object.entries(PLANS).filter(([key])=>key!=='welcome'||s.promo_available)
      .map(([key,p])=>[button(p.name+' · '+rub(p.price),'grant:'+owner+':'+key)]);
    rows.push([button('Назад','c:'+owner)]);
    return send(actor,prefix+c.name+'\n\nТестовый период: до '+mskDate(s.trial_ends_ms)+'\n'+
      (s.paid_until_ms?'Оплачено до '+mskDate(s.paid_until_ms):'Оплата пока не подтверждена.')+
      '\n\nПодтверждайте тариф только после проверки фактически полученной оплаты.',rows);
  }
  function sendTrialNotice(actor,text){
    return api('sendMessage',{chat_id:actor,text,reply_markup:{inline_keyboard:[[{text:'Загрузить отчёт',web_app:{url:appUrl}}],[button('Цены','prices')]]}});
  }
  function testNotices(actor){
    if(!adminIds.has(actor))throw Error('Доступно только администратору.');
    return send(actor,'Проверка уведомлений\n\nВыберите сообщение — бот отправит его вам отдельным сообщением. Сроки подписок и рассылка клиентам не изменятся.',
      [[button('Через 24 часа: нет данных','testnotice:trial_unused')],[button('Через 46 часов: осталось 2 часа','testnotice:trial_ending')],[button('Через 48 часов: тест завершён','testnotice:trial_ended')],[button('В меню','home')]]);
  }
  let reminding=false;
  async function trialReminderTick(){
    if(reminding)return;reminding=true;
    try{
      const companies=db.prepare('SELECT c.* FROM companies c JOIN company_billing b ON b.company_id=c.id WHERE b.plan IS NULL AND NOT EXISTS(SELECT 1 FROM company_members m WHERE m.telegram_id=c.owner_id)').all();
      for(const c of companies){
        if(adminIds.has(String(c.owner_id)))continue;
        const notice=reminderFor(db,c,now());if(!notice)continue;
        try{
          await sendTrialNotice(c.owner_id,notice.text);
          db.prepare('INSERT OR IGNORE INTO billing_reminders VALUES(?,?,?)').run(c.id,notice.kind,now());
        }catch(error){console.error('Trial notification failed for company '+c.id+': '+error.message);}
      }
    }finally{reminding=false;}
  }
  async function handle(update){
    const callback=update.callback_query,message=callback?.message||update.message;
    const user=callback?.from||message?.from;
    if(!message||message.chat?.type!=='private'||String(user?.id)!==String(message.chat.id))return false;
    const actor=String(user.id),text=String(message.text||'').trim();
    cleanup.remember(actor,message.message_id,message.date);
    const isOurCallback=callback?.data?.startsWith('bpu:');
    if(callback&&!isOurCallback)return false;
    if(isOurCallback)setPanel(actor,message.message_id);
    const command=text.split(/\s+/)[0].split('@')[0].toLowerCase();
    const supportSession=!callback&&db.prepare('SELECT expires_ms FROM bot_support_sessions WHERE actor_id=?').get(actor);
    const supportRoute=!callback&&actor===supportId&&message.reply_to_message?.message_id?db.prepare('SELECT actor_id FROM bot_support_routes WHERE support_id=? AND message_id=?').get(actor,message.reply_to_message.message_id):null;
    const paymentSession=!callback&&db.prepare('SELECT * FROM billing_link_sessions WHERE actor_id=?').get(actor);
    if(!paymentSession&&!supportSession&&!supportRoute&&!isOurCallback&&!message.users_shared&&!['/start','/menu','/help','/myid'].includes(command)&&text!=='Отмена')return false;
    profile(user);
    if(isOurCallback)await api('answerCallbackQuery',{callback_query_id:callback.id});
    try{
      if(!callback&&paymentSession&&!command.startsWith('/')&&text!=='Отмена'){
        if(!adminIds.has(actor))throw Error('Доступно только администратору.');
        if(paymentSession.expires_ms<=now()){
          db.prepare('DELETE FROM billing_link_sessions WHERE actor_id=?').run(actor);
          throw Error('Время ввода ссылки истекло. Выберите тариф заново.');
        }
        savePaymentLink(db,paymentSession.plan,text,actor,now());
        db.prepare('DELETE FROM billing_link_sessions WHERE actor_id=?').run(actor);
        await paymentLinks(actor);return true;
      }
      if(callback||command.startsWith('/')||text==='Отмена')db.prepare('DELETE FROM billing_link_sessions WHERE actor_id=?').run(actor);
      if(!callback&&!command.startsWith('/')&&text!=='Отмена'&&(supportRoute||supportSession)){
        if(!supportRoute&&supportSession.expires_ms<=now()){
          db.prepare('DELETE FROM bot_support_sessions WHERE actor_id=?').run(actor);
          await send(actor,'Время отправки обращения истекло. Нажмите «Поддержка» и отправьте сообщение ещё раз.',[[button('Поддержка','support')],[button('В меню','home')]]);
        }else await supportMessage(actor,message,supportRoute);
        return true;
      }
      if(callback||command.startsWith('/')||text==='Отмена')db.prepare('DELETE FROM bot_support_sessions WHERE actor_id=?').run(actor);
      if(message.users_shared){
        const pending=db.prepare('SELECT * FROM bot_contact_requests WHERE actor_id=?').get(actor);
        const selected=message.users_shared.users;
        if(!pending||pending.request_id!==message.users_shared.request_id||pending.expires_ms<=now())throw Error('Выбор человека устарел. Нажмите кнопку ещё раз.');
        if(!Array.isArray(selected)||selected.length!==1||!idOK(selected[0]?.user_id))throw Error('Выберите одного человека.');
        if(pending.kind==='client'){if(!adminIds.has(actor))throw Error('Доступно только администратору.');}
        else access(actor,pending.owner_id);
        db.prepare('DELETE FROM bot_contact_requests WHERE actor_id=?').run(actor);
        const contact=selected[0],target=String(contact.user_id);
        profile({...contact,id:contact.user_id});
        await api('sendMessage',{chat_id:actor,text:'Человек выбран.',reply_markup:{remove_keyboard:true}});
        if(pending.kind==='client'){
          if(!adminIds.has(actor))throw Error('Доступно только администратору.');
          const c=companyForUser(db,target);
          if(!c)return send(actor,'Этот человек ещё не открыл компанию в боте. Отправьте ему ссылку на бота, затем выберите его снова.',[[{text:'Открыть бота',url:'https://t.me/'+botUsername}],[button('В меню','home')]]);
          return await card(actor,c);
        }
        await invitation(actor,pending.owner_id,target);return true;
      }
      if(!callback){
        if(text==='Отмена'){
          db.prepare('DELETE FROM bot_contact_requests WHERE actor_id=?').run(actor);
          await api('sendMessage',{chat_id:actor,text:'Выбор отменён.',reply_markup:{remove_keyboard:true}});
        }
        // Explicit commands must answer at the bottom of the conversation.
        // Button navigation continues to edit the current panel in place.
        if(command==='/start'||command==='/menu')db.prepare('DELETE FROM bot_menu_panels WHERE chat_id=?').run(actor);
        const payload=text.split(/\s+/)[1];
        if(command==='/start'&&payload?.startsWith('join_'))await previewInvite(actor,payload.slice(5));
        else if(command==='/start'&&payload==='prices')await prices(actor);
        else if(command==='/start'&&payload==='support')await support(actor);
        else if(command==='/myid')await send(actor,profileText(user));
        else await home(actor);
        return true;
      }
      const [action,a,b]=callback.data.slice(4).split(':');
      if(action==='home')await home(actor);
      else if(action==='paylinks')await paymentLinks(actor);
      else if(action==='paylink'){
        if(!adminIds.has(actor))throw Error('Доступно только администратору.');
        if(!Object.hasOwn(PLANS,a))throw Error('Тариф не найден.');
        db.prepare('INSERT INTO billing_link_sessions VALUES(?,?,?) ON CONFLICT(actor_id) DO UPDATE SET plan=excluded.plan,expires_ms=excluded.expires_ms').run(actor,a,now()+15*60000);
        const current=paymentCatalog(db).find(p=>p.id===a);
        await send(actor,PLANS[a].name+' — '+rub(PLANS[a].price)+'\n\nПришлите платёжную ссылку на эту сумму следующим сообщением.'+(current.payment_url?'\n\nТекущая ссылка: '+current.payment_url:''),[[button('Удалить ссылку','payunlink:'+a)],[button('Отмена','paylinks')]]);
      }
      else if(action==='payunlink'){
        if(!adminIds.has(actor))throw Error('Доступно только администратору.');
        db.prepare('DELETE FROM billing_payment_links WHERE plan=?').run(a);await paymentLinks(actor);
      }
      else if(action==='support')await support(actor);
      else if(action==='supportcancel')await home(actor);
      else if(action==='prices')await prices(actor);
      else if(action==='testnotices')await testNotices(actor);
      else if(action==='testnotice'){
        if(!adminIds.has(actor))throw Error('Доступно только администратору.');
        const ends=now()+(a==='trial_unused'?24:a==='trial_ending'?2:0)*3600000;
        await sendTrialNotice(actor,trialReminderText(a,ends));
        await testNotices(actor);
      }
      else if(action==='bill')await billingCard(actor,a);
      else if(action==='grant'){
        const c=access(actor,a,true);ensureCompanyBilling(db,c,now());
        const token=paymentConfirmation(db,c,actor,b,now()),p=PLANS[b];
        await send(actor,'Подтверждение оплаты\n\nКомпания: '+c.name+'\nТариф: '+p.name+'\nСумма: '+rub(p.price)+
          '\n\nПлатёж на эту сумму действительно получен? Подтверждение откроет доступ на выбранный срок.',
          [[button('Да, оплата получена','paid:'+a+':'+token)],[button('Отмена','bill:'+a)]]);
      }else if(action==='paid'){
        const c=access(actor,a,true);confirmReceivedPayment(db,c,actor,b,now());await billingCard(actor,a,'Оплата подтверждена.\n\n');
      }
      else if(action==='clear'){
        const token=cleanup.confirm(actor);
        await send(actor,'Очистить сообщения в этом чате?\n\nПриветствие и меню останутся. Данные и настройки компании сохранятся. Telegram позволяет боту удалять сообщения только за последние 48 часов.',
          [[button('Да, очистить','clearok:'+token)],[button('Отмена','clearcancel')]]);
      }else if(action==='clearok'){
        const result=await cleanup.clear(actor,a);
        await home(actor,true,result.retained?'\n\nНекоторые сообщения Telegram не разрешил удалить.':'');
      }else if(action==='clearcancel'){cleanup.cancel(actor);await home(actor);}
      else if(action==='cancel'){
        db.prepare('DELETE FROM bot_contact_requests WHERE actor_id=?').run(actor);
        await api('sendMessage',{chat_id:actor,text:'Выбор отменён.',reply_markup:{remove_keyboard:true}});await home(actor);
      }else if(action==='id')await send(actor,profileText(user));
      else if(action==='notify')await notifications(actor);
      else if(action==='hours'){
        const selected=notificationHour(actor),rows=[];
        for(let start=0;start<24;start+=4)rows.push(Array.from({length:4},(_,i)=>{
          const hour=start+i;return button((hour===selected?'• ':'')+hourLabel(hour),'hour:'+hour);
        }));
        rows.push([button('Назад','notify')]);
        await send(actor,'Выберите час отправки ('+zoneLabel+').\nСводка приходит один раз в день.',rows);
      }else if(action==='hour'){
        if(!/^(?:[0-9]|1[0-9]|2[0-3])$/.test(a||''))throw Error('Выберите час от 00:00 до 23:00.');
        db.prepare('INSERT INTO notification_preferences VALUES(?,?) ON CONFLICT(telegram_id) DO UPDATE SET hour=excluded.hour').run(actor,Number(a));
        await notifications(actor,'Время сохранено.\n\n');
      }
      else if(action==='list'){
        if(!adminIds.has(actor))throw Error('Доступно только администратору.');
        const offset=Number(a);if(!Number.isSafeInteger(offset)||offset<0)throw Error('Откройте список заново.');
        const list=db.prepare('SELECT c.* FROM companies c WHERE NOT EXISTS(SELECT 1 FROM company_members m WHERE m.telegram_id=c.owner_id) ORDER BY c.created_at DESC,c.id LIMIT 9 OFFSET ?').all(offset);
        const rows=list.slice(0,8).map(c=>[button((name(c.owner_id)+' · '+(INDUSTRIES[c.industry]?.name||'Универсальный')).slice(0,90),'c:'+c.owner_id)]);
        const nav=[];if(offset>0)nav.push(button('Назад','list:'+Math.max(0,offset-8)));if(list.length>8)nav.push(button('Далее','list:'+(offset+8)));if(nav.length)rows.push(nav);
        rows.push([button('Найти компанию через Telegram','client')],[button('В меню','home')]);
        await send(actor,'Компании клиентов\n\nВыберите компанию для настройки.',rows);
      }else if(action==='client')await pick(actor,null,'client');
      else if(action==='c'){const c=access(actor,a);await card(actor,c);}
      else if(action==='i'){
        const c=access(actor,a,true);
        await send(actor,'Выберите отрасль для '+name(c.owner_id)+'.',Object.entries(INDUSTRIES).map(([key,value])=>[button(value.name,'is:'+a+':'+key)]).concat([[button('Назад','c:'+a)]]));
      }else if(action==='is'){
        access(actor,a,true);
        const c=companyAdmin({dbPath,action:'set',ownerId:a,industry:b});await card(actor,c,'Отрасль сохранена.\n\n');
      }else if(action==='m')await members(actor,a,b===undefined?0:Number(b));
      else if(action==='pick')await pick(actor,a,'employee');
      else if(action==='invite')await invitation(actor,a);
      else if(action==='revoke'){
        const c=access(actor,a);db.prepare('UPDATE bot_invites SET expires_ms=0 WHERE company_id=? AND used_by IS NULL').run(c.id);await members(actor,a);
      }else if(action==='remove'){
        access(actor,a);if(!idOK(b))throw Error('Сотрудник не найден.');
        await send(actor,'Отключить сотрудника '+name(b)+'? Он потеряет доступ к показателям и загрузкам компании.',[[button('Отключить','rd:'+a+':'+b)],[button('Отмена','m:'+a)]]);
      }else if(action==='rd'){
        access(actor,a);companyAdmin({dbPath,action:'removemember',ownerId:a,memberId:b});await members(actor,a);
      }else if(action==='join')await acceptInvite(actor,a);
      else throw Error('Эта кнопка устарела. Откройте меню заново.');
    }catch(error){await send(actor,error.message||'Не удалось выполнить действие. Откройте меню заново.');}
    return true;
  }
  return {handle,notificationHour,notifications,trialReminderTick,rememberMessage:cleanup.remember,close:()=>db.close()};
}
