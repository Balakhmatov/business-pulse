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

function fixture(t){
  const folder=mkdtempSync(path.join(tmpdir(),'bp-buttons-')),dbPath=path.join(folder,'test.db');
  const db=new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(telegram_id TEXT PRIMARY KEY);"+
    "CREATE TABLE companies(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(telegram_id),name TEXT,industry TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);"+
    "CREATE TABLE operations(company_id TEXT,amount_kopecks INTEGER);"+
    "INSERT INTO users VALUES('101'),('202');INSERT INTO companies(id,owner_id,name,industry) VALUES('a','101','Клиника','clinic'),('b','202','Кафе','cafe');");
  let clock=Date.parse('2026-10-19T08:00:00Z');
  const messages=[],admins=new Set(['999']);
  const api=async(method,payload)=>{
    messages.push({method,...payload});
    for(const row of payload.reply_markup?.inline_keyboard||[])for(const button of row)
      if(button.callback_data)assert.ok(Buffer.byteLength(button.callback_data)<=64,'Telegram callback size limit');
    return {message_id:messages.length};
  };
  const make=()=>createBotControls({dbPath,api,adminIds:admins,appUrl:'https://example.org/',botUsername:'business_pulse_app_bot',now:()=>clock});
  let controls=make();
  t.after(()=>{controls.close();db.close();rmSync(folder,{recursive:true,force:true});});
  const user=id=>({id:Number(id),first_name:id==='101'?'Иван':id==='303'?'Анна':'Пользователь',username:'user'+id});
  const msg=(id,text)=>controls.handle({message:{from:user(id),chat:{id:Number(id),type:'private'},text}});
  const click=(id,data,extra={})=>controls.handle({callback_query:{id:'callback',from:user(id),data:'bpu:'+data,message:{chat:{id:Number(id),type:'private'},...extra}}});
  const shared=(id,requestId,target)=>controls.handle({message:{from:user(id),chat:{id:Number(id),type:'private'},users_shared:{request_id:requestId,users:[{user_id:Number(target),first_name:'Сотрудник',username:'staff'+target}]}}});
  const last=()=>messages.filter(x=>x.method==='sendMessage').at(-1);
  const request=()=>messages.filter(x=>x.reply_markup?.keyboard).at(-1).reply_markup.keyboard[0][0].request_users.request_id;
  const invite=()=>{
    const share=last().reply_markup.inline_keyboard.flat().find(x=>x.text==='Отправить приглашение');
    const parsed=new URL(share.url);
    return parsed.searchParams.get('url')?new URL(parsed.searchParams.get('url')).searchParams.get('start').slice(5):parsed.searchParams.get('text').match(/join_([A-Za-z0-9_-]{32})/)[1];
  };
  return {db,dbPath,messages,admins,msg,click,shared,last,request,invite,advance:ms=>clock+=ms,
    restart:()=>{controls.close();controls=make();}};
}

test('Start creates a company and button menu; profile ID and admin directory need no commands',async t=>{
  const f=fixture(t);
  await f.msg('303','/start');
  assert.ok(companyForUser(f.db,'303'));
  assert.ok(f.last().reply_markup.inline_keyboard.flat().some(x=>x.text==='Сотрудники'));
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
