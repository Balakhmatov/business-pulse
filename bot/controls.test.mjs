import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBotControls } from './controls.mjs';
import { companyForUser } from '../api/company-members.mjs';
import { companyAdmin } from '../api/company-admin.mjs';

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
