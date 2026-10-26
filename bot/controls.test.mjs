import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBotControls } from './controls.mjs';
import { companyForUser } from '../api/company-members.mjs';
import { companyAdmin } from '../api/company-admin.mjs';
import { isDigestDue } from './notification-schedule.mjs';
import { createChatCleanup } from './chat-cleanup.mjs';

function fixture(t,appUrl='https://example.org/',trial=true){
  const folder=mkdtempSync(path.join(tmpdir(),'bp-buttons-')),dbPath=path.join(folder,'test.db');
  const db=new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(telegram_id TEXT PRIMARY KEY);"+
    "CREATE TABLE companies(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(telegram_id),name TEXT,industry TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);"+
    "CREATE TABLE operations(company_id TEXT,amount_kopecks INTEGER);"+
    "INSERT INTO users VALUES('101'),('202');INSERT INTO companies(id,owner_id,name,industry) VALUES('a','101','Клиника','clinic'),('b','202','Кафе','cafe');");
  let clock=Date.parse('2026-10-19T08:00:00Z');
  const messages=[],admins=new Set(['999']);
  let failCopy=false;
  const api=async(method,payload)=>{
    messages.push({method,...payload});
    if(method==='copyMessage'&&failCopy)throw Error('Не удалось отправить сообщение. Попробуйте ещё раз.');
    for(const row of payload.reply_markup?.inline_keyboard||[])for(const button of row)
      if(button.callback_data)assert.ok(Buffer.byteLength(button.callback_data)<=64,'Telegram callback size limit');
    return {message_id:payload.message_id??messages.length};
  };
  const make=()=>createBotControls({dbPath,api,adminIds:admins,supportId:'999',appUrl,botUsername:'business_pulse_app_bot',now:()=>clock});
  let controls=make();
  if(trial)db.prepare('UPDATE company_billing SET trial_granted_by=?,trial_started_ms=?,trial_ends_ms=?').run('999',clock,clock+48*3600000);
  t.after(()=>{controls.close();db.close();rmSync(folder,{recursive:true,force:true});});
  const user=id=>({id:Number(id),first_name:id==='101'?'Иван':id==='303'?'Анна':'Пользователь',username:'user'+id});
  const msg=(id,text)=>controls.handle({message:{from:user(id),chat:{id:Number(id),type:'private'},text}});
  const click=(id,data,extra={})=>controls.handle({callback_query:{id:'callback',from:user(id),data:'bpu:'+data,message:{chat:{id:Number(id),type:'private'},message_id:db.prepare('SELECT message_id FROM bot_menu_panels WHERE chat_id=?').get(String(id))?.message_id,...extra}}});
  const shared=(id,requestId,target)=>controls.handle({message:{from:user(id),chat:{id:Number(id),type:'private'},users_shared:{request_id:requestId,users:[{user_id:Number(target),first_name:'Сотрудник',username:'staff'+target}]}}});
  const last=()=>messages.filter(x=>x.method==='sendMessage'||x.method==='editMessageText').at(-1);
  const request=()=>messages.filter(x=>x.reply_markup?.keyboard).at(-1).reply_markup.keyboard[0][0].request_users.request_id;
  const invite=()=>{
    const share=last().reply_markup.inline_keyboard.flat().find(x=>x.text==='Отправить приглашение');
    const parsed=new URL(share.url);
    return parsed.searchParams.get('url')?new URL(parsed.searchParams.get('url')).searchParams.get('start').slice(5):parsed.searchParams.get('text').match(/join_([A-Za-z0-9_-]{32})/)[1];
  };
  return {db,dbPath,messages,admins,msg,click,shared,last,request,invite,failCopy:value=>failCopy=value,inbound:(id,extra)=>controls.handle({message:{from:user(id),chat:{id:Number(id),type:'private'},message_id:9000+messages.length,...extra}}),tick:()=>controls.trialReminderTick(),advance:ms=>clock+=ms,
    restart:()=>{controls.close();controls=make();}};
}

test('Bot statistics are admin-only and synthetic legacy callback dispatch is not tracked twice',async t=>{
  const f=fixture(t);
  await f.msg('101','/start');
  assert.ok(!f.last().reply_markup.inline_keyboard.flat().some(b=>b.text==='Статистика бота'));
  await f.msg('101','/stats');assert.match(f.last().text,/только администратору/);
  await f.click('202','stats:0');assert.match(f.last().text,/только администратору/);
  await f.msg('999','/start');
  assert.ok(f.last().reply_markup.inline_keyboard.flat().some(b=>b.text==='Статистика бота'));
  await f.click('999','stats:0');assert.match(f.last().text,/Всего посетителей: 2/);
  assert.match(f.last().text,/МСК/);assert.match(f.last().text,/101/);
  const actions=f.db.prepare('SELECT SUM(actions) AS n FROM bot_visit_days').get().n;
  // index.mjs forwards bp:report as a synthetic message with track:false.
  const controls=createBotControls({dbPath:f.dbPath,api:async()=>({message_id:999}),adminIds:f.admins,supportId:'999',appUrl:'https://example.org/',botUsername:'business_pulse_app_bot'});
  t.after(()=>controls.close());
  await controls.handle({message:{from:{id:101},chat:{id:101,type:'private'},text:'/report'}},{track:false});
  assert.equal(f.db.prepare('SELECT SUM(actions) AS n FROM bot_visit_days').get().n,actions);
  f.restart();await f.msg('999','/stats');assert.match(f.last().text,/Всего посетителей: 2/);
});

test('Open website button is visible in main menu regardless of subscription status',async t=>{
  const f=fixture(t,'https://example.org/miniapp',false);
  await f.msg('101','/start');
  const disabled=f.last().reply_markup.inline_keyboard.flat().find(x=>x.text==='Открыть сайт');
  assert.equal(disabled?.url,'https://balakhmatov.github.io/business-pulse/index.html?login=1');
  assert.equal(disabled.web_app,undefined,'Website link should open regular browser rather than Telegram Mini App');
  await f.click('999','trial:101').catch(()=>{});
  f.db.prepare('UPDATE company_billing SET trial_granted_by=?,trial_started_ms=?,trial_ends_ms=? WHERE company_id=?')
    .run('999',Date.parse('2026-10-19T08:00:00Z'),Date.parse('2026-10-21T08:00:00Z'),'a');
  await f.msg('101','/start');
  const menu=f.last().reply_markup.inline_keyboard.flat();
  assert.equal(menu.find(x=>x.text==='Открыть сайт')?.url,'https://balakhmatov.github.io/business-pulse/index.html?login=1');
  assert.equal(menu.find(x=>x.text==='Открыть Бизнес Пульс')?.web_app?.url,'https://example.org/miniapp');
});

test('Trial activation is admin only, lasts 48 hours, survives restart and cannot be reset',async t=>{
  const f=fixture(t,'https://example.org/',false);
  await f.msg('101','/start');assert.match(f.last().text,/не активирован/);
  assert.ok(!f.last().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='bp:report'));
  await f.click('101','trial:101');assert.match(f.last().text,/нет доступа/);
  await f.click('101','m:101');assert.match(f.last().text,/Доступ к компании закрыт/);
  assert.equal(f.db.prepare("SELECT trial_granted_by FROM company_billing WHERE company_id='a'").get().trial_granted_by,null);
  await f.click('999','bill:101');assert.ok(f.last().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='bpu:trial:101'));
  await f.click('999','trial:101');assert.match(f.last().text,/48 часов включены/);
  const first=f.db.prepare("SELECT * FROM company_billing WHERE company_id='a'").get();
  assert.equal(first.trial_ends_ms-first.trial_started_ms,48*3600000);
  f.restart();await f.msg('101','/start');assert.match(f.last().text,/Пробный доступ включён/);
  f.advance(49*3600000);await f.click('999','trial:101');assert.match(f.last().text,/уже выдавался/);
  assert.equal(f.db.prepare("SELECT trial_ends_ms FROM company_billing WHERE company_id='a'").get().trial_ends_ms,first.trial_ends_ms);
  await f.msg('101','/start');assert.match(f.last().text,/Доступ завершён/);
});

test('Start creates a company and button menu; profile ID and admin directory need no commands',async t=>{
  const f=fixture(t);
  await f.msg('303','/start');
  assert.ok(companyForUser(f.db,'303'));
  assert.ok(f.last().reply_markup.inline_keyboard.flat().some(x=>x.text==='Перейти к оплате'));
  assert.ok(!f.last().reply_markup.inline_keyboard.flat().some(x=>x.text==='Сотрудники'));
  assert.ok(!f.last().reply_markup.inline_keyboard.flat().some(x=>x.text==='Управление компаниями'));
  await f.click('303','id');assert.match(f.last().text,/303/);
  await f.msg('101','/start');await f.msg('999','/start');await f.click('999','list:0');
  assert.match(JSON.stringify(f.last()),/Иван/);
  await f.click('999','i:101');
  assert.equal(f.last().reply_markup.inline_keyboard.filter(row=>row[0].callback_data?.startsWith('bpu:is:')).length,5);
  await f.click('999','is:101:cafe');
  assert.equal(companyForUser(f.db,'101').industry,'cafe');
  await f.click('101','is:101:store');assert.match(f.last().text,/нет доступа/);
  assert.equal(companyForUser(f.db,'101').industry,'cafe');
});

test('Native Telegram person selection creates a targeted invitation surviving restart; recipient confirms without IDs',async t=>{
  const f=fixture(t);
  await f.msg('101','/start');await f.click('101','pick:101');
  const request=f.request();
  await f.shared('101',request,'303');
  const token=f.invite();
  assert.equal(companyForUser(f.db,'303'),null,'Selection alone does not grant financial access');
  f.restart();
  await f.msg('404','/start join_'+token);assert.match(f.last().text,/другому человеку/);
  await f.msg('303','/start join_'+token);assert.match(f.last().text,/Вас приглашают/);
  assert.equal(companyForUser(f.db,'303'),null);
  await f.click('303','join:'+token);
  assert.equal(companyForUser(f.db,'303').id,'a');
  assert.equal(companyForUser(f.db,'303').access_role,'member');
  await f.click('303','join:'+token);assert.equal(companyForUser(f.db,'303').id,'a');
  await f.click('303','m:101');assert.match(f.last().text,/нет доступа/);
  await f.click('101','m:101');assert.match(f.last().text,/Анна/);
  await f.click('101','remove:101:303');assert.match(f.last().text,/Отключить сотрудника/);
  await f.click('101','rd:101:303');assert.notEqual(companyForUser(f.db,'303')?.id,'a');
  await f.click('303','join:'+token);assert.match(f.last().text,/уже использовано/);
});

test('General invitation is single-use, expires and is invalidated by creating a new link or removing a member',async t=>{
  const f=fixture(t);
  await f.click('101','invite:101');const old=f.invite();
  await f.click('101','invite:101');const token=f.invite();
  await f.msg('303','/start join_'+old);assert.match(f.last().text,/недействительно|истекло/);
  await f.msg('303','/start join_'+token);await f.click('303','join:'+token);
  await f.msg('404','/start join_'+token);assert.match(f.last().text,/уже использовано/);
  await f.click('101','invite:101');const pending=f.invite();
  companyAdmin({dbPath:f.dbPath,action:'removemember',ownerId:'101',memberId:'303'});
  await f.msg('404','/start join_'+pending);assert.match(f.last().text,/истекло|отменено/);
  await f.click('101','invite:101');const expired=f.invite();f.advance(86400001);
  await f.msg('404','/start join_'+expired);assert.match(f.last().text,/истекло/);
});

test('No forged callback, foreign company or stale native selection can grant access',async t=>{
  const f=fixture(t);
  await f.click('202','invite:101');assert.match(f.last().text,/нет доступа/);
  await f.click('202','rd:101:303');assert.match(f.last().text,/нет доступа/);
  await f.click('202','list:0');assert.match(f.last().text,/администратору/);
  await f.click('101','pick:101');const request=f.request();
  await f.shared('202',request,'303');assert.match(f.last().text,/устарел/);
  f.advance(15*60000+1);await f.shared('101',request,'303');assert.match(f.last().text,/устарел/);
  const count=f.messages.length;
  await f.click('101','is:101:cafe',{chat:{id:101,type:'group'}});
  assert.equal(f.messages.length,count);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM company_members').get().n,0);
});

test('Admin can select a registered client natively and employee cannot alter another company',async t=>{
  const f=fixture(t);await f.msg('101','/start');
  await f.click('999','client');await f.shared('999',f.request(),'101');
  assert.match(f.last().text,/Руководитель: Сотрудник/);
  assert.ok(f.last().reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='bpu:i:101'));
  await f.click('999','pick:101');const r=f.request();f.admins.delete('999');
  await f.shared('999',r,'303');assert.match(f.last().text,/нет доступа/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM bot_invites').get().n,0);
});

test('Failed acceptance preserves an invitation and existing finances; cancellation closes native selection',async t=>{
  const f=fixture(t);
  f.db.prepare("INSERT INTO operations VALUES('b',10000)").run();
  await f.click('101','invite:101');const token=f.invite();
  await f.msg('202','/start join_'+token);await f.click('202','join:'+token);
  assert.match(f.last().text,/собственная компания/);
  assert.equal(companyForUser(f.db,'202').id,'b');
  assert.equal(f.db.prepare('SELECT used_by FROM bot_invites').get().used_by,null);
  await f.msg('303','/start join_'+token);await f.click('303','join:'+token);
  assert.equal(companyForUser(f.db,'303').id,'a');
  assert.equal(f.db.prepare('SELECT amount_kopecks FROM operations').get().amount_kopecks,10000);
  await f.click('101','pick:101');const request=f.request();
  await f.msg('101','Отмена');
  assert.ok(f.messages.some(x=>x.reply_markup?.remove_keyboard));
  await f.shared('101',request,'505');assert.match(f.last().text,/устарел/);
});

test('Notification menu offers 24 hours and persists personal time across restart without enabling notifications',async t=>{
  const f=fixture(t);
  await f.click('101','notify');assert.match(f.last().text,/09:00.*МСК/);assert.match(f.last().text,/Отключены/);
  await f.click('101','hours');
  const hours=f.last().reply_markup.inline_keyboard.flat().filter(x=>x.callback_data.startsWith('bpu:hour:'));
  assert.equal(hours.length,24);assert.match(hours[0].text,/00:00/);assert.match(hours.at(-1).text,/23:00/);
  await f.click('101','hour:23');assert.match(f.last().text,/23:00/);assert.match(f.last().text,/Отключены/);
  f.restart();await f.click('101','notify');assert.match(f.last().text,/23:00/);
  await f.click('202','notify');assert.match(f.last().text,/09:00/);
  await f.click('101','hour:0');assert.match(f.last().text,/00:00/);
  await f.click('101','hour:24');assert.match(f.last().text,/Выберите час/);
  await f.click('101','notify');assert.match(f.last().text,/00:00/);
});

test('Personal digest hour handles midnight and never duplicates a sent day after time changes or disable/enable',()=>{
  const record={lastSent:'',enabled:true},clock={date:'2026-10-19',hour:0};
  assert.equal(isDigestDue(record,clock,0),true);
  assert.equal(isDigestDue(record,clock,9),false);
  record.lastSent=clock.date;
  assert.equal(isDigestDue(record,clock,0),false);
  assert.equal(isDigestDue(record,{...clock,hour:23},23),false);
  record.enabled=false;assert.equal(isDigestDue(record,{date:'2026-10-20',hour:23},23),false);
  record.enabled=true;assert.equal(isDigestDue(record,{...clock,hour:23},23),false);
  assert.equal(isDigestDue(record,{date:'2026-10-20',hour:23},23),true);
});

test('Clear-chat button requires confirmation, preserves welcome/other chats/finances, and survives restart',async t=>{
  const f=fixture(t);
  f.db.prepare("INSERT INTO operations VALUES('a',12345)").run();
  await f.msg('101','/start');
  // Mock sendMessage returns the call number as its message ID.
  const kept=f.db.prepare("SELECT message_id FROM bot_chat_messages WHERE chat_id='101' AND keep=1").get().message_id;
  await f.click('101','id');await f.click('101','hour:23');await f.msg('202','/start');
  // An older menu produced by the previous version becomes known when clicked.
  await f.click('101','id',{message_id:900,date:Date.parse('2026-10-19T07:00:00Z')/1000});
  await f.click('101','clear');
  assert.match(f.last().text,/Очистить сообщения/);
  assert.equal(f.messages.filter(x=>x.method==='deleteMessages').length,0);
  const action=f.last().reply_markup.inline_keyboard[0][0].callback_data.slice(4);
  f.restart();await f.click('101',action);
  const deletions=f.messages.filter(x=>x.method==='deleteMessages');
  assert.ok(deletions.length>0);
  assert.ok(deletions.every(x=>x.chat_id==='101'&&!x.message_ids.includes(kept)));
  assert.equal(f.messages.at(-1).method,'editMessageText');
  assert.equal(f.messages.at(-1).message_id,kept);
  assert.equal(f.db.prepare('SELECT amount_kopecks FROM operations').get().amount_kopecks,12345);
  assert.equal(f.db.prepare("SELECT hour FROM notification_preferences WHERE telegram_id='101'").get().hour,23);
  assert.ok(f.db.prepare("SELECT 1 FROM bot_chat_messages WHERE chat_id='202'").get());
  await f.click('101',action);assert.match(f.last().text,/Подтверждение устарело/);
  assert.equal(f.messages.filter(x=>x.method==='deleteMessages').length,deletions.length);
});

test('Chat cleanup batches only recent known messages, skips non-deletable items and isolates confirmation tokens',async t=>{
  const f=fixture(t),calls=[];
  const now=Date.parse('2026-10-19T08:00:00Z');
  const cleaner=createChatCleanup({db:f.db,now:()=>now,api:async(method,payload)=>{
    calls.push({method,...payload});
    if(method==='deleteMessages'&&payload.message_ids.includes(50))throw Error("message can't be deleted");
    if(method==='deleteMessage'&&payload.message_id===50)throw Error("message can't be deleted");
    return true;
  }});
  cleaner.remember('101',1,now/1000);cleaner.keepWelcome('101',1);
  cleaner.remember('101',2,now/1000-48*3600);
  for(let id=3;id<=207;id++)cleaner.remember('101',id,now/1000);
  cleaner.remember('202',300,now/1000);
  const token=cleaner.confirm('101');
  await assert.rejects(cleaner.clear('202',token),/Подтверждение устарело/);
  const result=await cleaner.clear('101',token);
  assert.equal(result.retained,1);
  assert.ok(calls.filter(x=>x.method==='deleteMessages').every(x=>x.message_ids.length<=100&&!x.message_ids.includes(1)&&!x.message_ids.includes(2)&&x.chat_id==='101'));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM bot_chat_messages WHERE chat_id='101'").get().n,2);
  assert.ok(f.db.prepare("SELECT 1 FROM bot_chat_messages WHERE chat_id='202'").get());
});

test('Canceling or expiring a cleanup confirmation never deletes chat messages',async t=>{
  const f=fixture(t);
  await f.msg('101','/start');await f.click('101','clear');
  const action=f.last().reply_markup.inline_keyboard[0][0].callback_data.slice(4);
  await f.click('101','clearcancel');await f.click('101',action);
  assert.match(f.last().text,/Подтверждение устарело/);
  await f.click('101','clear');const expired=f.last().reply_markup.inline_keyboard[0][0].callback_data.slice(4);
  f.advance(5*60000+1);await f.click('101',expired);
  assert.match(f.last().text,/Подтверждение устарело/);
  assert.equal(f.messages.filter(x=>x.method==='deleteMessages').length,0);
});

test('Profile, notifications, hours and navigation edit one panel across repeated taps and restart',async t=>{
  const f=fixture(t);await f.msg('101','/start');
  const id=f.db.prepare("SELECT message_id FROM bot_menu_panels WHERE chat_id='101'").get().message_id;
  for(const action of ['id','notify','hours','hour:14','notify','home','m:101','home','id','home'])await f.click('101',action);
  f.restart();await f.click('101','notify');
  assert.equal(f.messages.filter(x=>x.method==='sendMessage'&&x.chat_id==='101').length,1);
  assert.ok(f.messages.filter(x=>x.method==='editMessageText').every(x=>x.message_id===id));
  assert.match(f.last().text,/14:00/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM bot_chat_messages WHERE chat_id='101'").get().n,1);
});

test('Prices are visible to clients; only admin can confirm a real payment, and double click cannot extend twice',async t=>{
  const f=fixture(t);await f.msg('101','/start prices');
  assert.match(f.last().text,/1 990 ₽/);assert.match(f.last().text,/33%/);assert.match(f.last().text,/40%/);
  await f.click('101','grant:101:year');assert.match(f.last().text,/нет доступа/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM billing_grants').get().n,0);
  await f.click('999','grant:101:welcome');
  const action=f.last().reply_markup.inline_keyboard[0][0].callback_data.slice(4);
  assert.match(f.last().text,/действительно получен/);
  await f.click('999',action);
  const until=f.db.prepare("SELECT paid_until_ms FROM company_billing WHERE company_id='a'").get().paid_until_ms;
  await f.click('999',action);
  assert.equal(f.db.prepare("SELECT paid_until_ms FROM company_billing WHERE company_id='a'").get().paid_until_ms,until);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM billing_grants').get().n,1);
});

test('Trial reminder delivery is owner-only, persistent and suppresses unused notice when data is uploaded',async t=>{
  const f=fixture(t);
  f.db.prepare("INSERT INTO operations VALUES('b',10000)").run();
  await f.msg('101','/start');
  f.advance(24*3600000);await f.tick();
  const inactivity=f.messages.filter(x=>x.method==='sendMessage'&&x.text?.includes('Первый день тестового периода'));
  assert.equal(inactivity.length,1);assert.equal(inactivity[0].chat_id,'101');
  f.restart();await f.tick();
  assert.equal(f.messages.filter(x=>x.method==='sendMessage'&&x.text?.includes('Первый день тестового периода')).length,1);
  f.advance(22*3600000);await f.tick();
  assert.equal(f.messages.filter(x=>x.method==='sendMessage'&&x.text?.includes('Тестовый период скоро закончится')).length,2);
  f.advance(2*3600000);await f.tick();
  assert.equal(f.messages.filter(x=>x.method==='sendMessage'&&x.text?.includes('Тестовый период завершился')).length,2);
});


test('Admin can receive all real reminder templates without changing billing or notifying clients',async t=>{
  const f=fixture(t);await f.msg('999','/start');
  assert.ok(f.last().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='bpu:testnotices'));
  const before=f.db.prepare('SELECT * FROM company_billing ORDER BY company_id').all();
  await f.click('999','testnotices');
  for(const [kind,title] of [['trial_unused','Первый день'],['trial_ending','скоро закончится'],['trial_ended','завершился']]){
    const start=f.messages.length;
    await f.click('999','testnotice:'+kind);
    const notices=f.messages.slice(start).filter(m=>m.method==='sendMessage');
    assert.equal(notices.length,1);assert.equal(notices[0].chat_id,'999');
    assert.ok(notices[0].text.includes(title));
    assert.equal(notices[0].reply_markup.inline_keyboard[1][0].callback_data,'bpu:prices');
  }
  assert.deepEqual(f.db.prepare('SELECT * FROM company_billing ORDER BY company_id').all(),before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_reminders').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_grants').get().n,0);
  for(const action of ['testnotices','testnotice:trial_unused','testnotice:trial_ending','testnotice:trial_ended']){
    const start=f.messages.length;await f.click('101',action);
    assert.match(f.last().text,/администратору/);
    assert.equal(f.messages.slice(start).filter(m=>m.method==='sendMessage'&&m.reply_markup?.inline_keyboard?.[1]?.[0]?.callback_data==='bpu:prices').length,0);
  }
});


test('Support sends text and attachments only after button opt-in; owner can reply after restart with isolated routing',async t=>{
  const f=fixture(t);await f.msg('101','/start');
  assert.ok(f.last().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='bpu:support'));
  assert.equal(await f.inbound('101',{text:'Обычное сообщение'}),false);
  await f.click('101','support');f.restart();
  await f.inbound('101',{text:'Помогите с отчётом'});
  const copies=f.messages.filter(m=>m.method==='copyMessage');assert.equal(copies.length,1);
  assert.equal(copies[0].chat_id,'999');assert.equal(copies[0].from_chat_id,'101');
  assert.match(f.last().text,/Сообщение отправлено/);
  const route=f.db.prepare("SELECT message_id FROM bot_support_routes WHERE actor_id='101' ORDER BY message_id DESC").get();
  f.restart();await f.inbound('999',{text:'Вот решение',reply_to_message:{message_id:route.message_id}});
  const reply=f.messages.filter(m=>m.method==='copyMessage').at(-1);
  assert.equal(reply.chat_id,'101');assert.equal(reply.from_chat_id,'999');
  assert.equal(await f.inbound('202',{text:'Поддельный ответ',reply_to_message:{message_id:route.message_id}}),false);
  await f.click('202','support');await f.inbound('202',{photo:[{file_id:'test'}],caption:'Ошибка'});
  assert.equal(f.messages.filter(m=>m.method==='copyMessage').at(-1).from_chat_id,'202');
  const count=f.messages.filter(m=>m.method==='copyMessage').length;
  await f.click('101','support');await f.click('101','supportcancel');
  assert.equal(await f.inbound('101',{text:'Не отправлять'}),false);
  await f.click('101','support');f.advance(31*60000);await f.inbound('101',{text:'Слишком поздно'});
  assert.match(f.last().text,/истекло/);
  assert.equal(f.messages.filter(m=>m.method==='copyMessage').length,count);
});

test('Support keeps an undelivered request pending and never claims successful delivery after Telegram failure',async t=>{
  const f=fixture(t);await f.click('101','support');f.failCopy(true);
  await f.inbound('101',{text:'Вопрос'});assert.match(f.last().text,/Не удалось отправить/);
  assert.ok(f.db.prepare("SELECT 1 FROM bot_support_sessions WHERE actor_id='101'").get());
  f.failCopy(false);await f.inbound('101',{text:'Вопрос повторно'});
  assert.match(f.last().text,/Сообщение отправлено/);
  assert.equal(f.db.prepare("SELECT 1 FROM bot_support_sessions WHERE actor_id='101'").get(),undefined);
});

test('Only admin can configure payment links; editing survives restart and rejects untrusted URLs',async t=>{
  const f=fixture(t);await f.msg('999','/start');
  assert.ok(f.last().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='bpu:paylinks'));
  await f.click('101','paylinks');assert.match(f.last().text,/администратору/);
  await f.click('101','paylink:year');assert.match(f.last().text,/администратору/);
  await f.click('999','paylink:year');f.restart();
  await f.inbound('999',{text:'https://evil.example/pay'});assert.match(f.last().text,/HTTPS-ссылка/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_payment_links').get().n,0);
  await f.inbound('999',{text:'https://yoomoney.ru/checkout/payments/year'});
  assert.equal(f.db.prepare("SELECT url FROM billing_payment_links WHERE plan='year'").get().url,'https://yoomoney.ru/checkout/payments/year');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_grants').get().n,0);
  await f.click('101','payunlink:year');assert.match(f.last().text,/администратору/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_payment_links').get().n,1);
  await f.click('999','payunlink:year');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_payment_links').get().n,0);
  await f.click('999','paylink:month');await f.click('999','home');
  assert.equal(await f.inbound('999',{text:'https://yoomoney.ru/pay'}),false);
  await f.msg('101','/start support');assert.match(f.last().text,/следующим сообщением/);
});

test('Explicit start and menu reply at the bottom while inline navigation keeps editing one panel',async t=>{
  const f=fixture(t);await f.msg('101','/start');
  const first=f.last().message_id;
  await f.click('101','id');assert.equal(f.last().method,'editMessageText');
  const before=f.messages.length;await f.msg('101','/start');
  assert.equal(f.last().method,'sendMessage');
  assert.equal(f.messages.slice(before).filter(m=>m.method==='sendMessage').length,1);
  assert.match(f.last().text,/Бизнес Пульс/);
  await f.click('101','notify');assert.equal(f.last().method,'editMessageText');
  f.restart();await f.msg('101','/menu');assert.equal(f.last().method,'sendMessage');
});


test('Payment button launches authenticated Mini App directly into tariffs from both prices entry points',async t=>{
  const f=fixture(t);
  for(const entry of ['command','callback']){
    if(entry==='command')await f.msg('101','/start prices');
    else await f.click('101','prices');
    const pay=f.last().reply_markup.inline_keyboard[0][0];
    assert.equal(pay.text,'Перейти к оплате');
    assert.equal(pay.web_app.url,'https://example.org/?view=payment');
    assert.equal(pay.url,undefined);
  }
});

test('Payment URL preserves configured application path, query and hash',async t=>{
  const f=fixture(t,'https://example.org/business-pulse/?lang=ru&view=home#account');
  await f.msg('101','/start prices');
  const pay=f.last().reply_markup.inline_keyboard[0][0];
  const u=new URL(pay.web_app.url);
  assert.equal(u.pathname,'/business-pulse/');assert.equal(u.searchParams.get('lang'),'ru');
  assert.deepEqual(u.searchParams.getAll('view'),['payment']);assert.equal(u.hash,'#account');
});

test('Website payment login requires a separate explicit confirmation in the bot',async t=>{
  const f=fixture(t);const {createWebLogin}=await import('../api/web-login.mjs');
  const login=createWebLogin(f.db,()=>Date.parse('2026-10-19T08:00:00Z')),a=login.create();
  await f.msg('101','/start web_'+a.challenge);
  assert.match(f.last().text,/Подтвердите вход/);
  assert.deepEqual(login.poll(a.challenge,a.secret),{pending:true});
  await f.click('101','web:'+a.challenge);
  assert.match(f.last().text,/Вход подтверждён/);
  assert.equal(login.actor(login.poll(a.challenge,a.secret).token),'101');
});

