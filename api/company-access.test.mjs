import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { companyAdmin } from './company-admin.mjs';
import { dailyDigestFor } from '../bot/digest.mjs';
import { DatabaseSync } from 'node:sqlite';
import { startCompanyTrial,paymentConfirmation,confirmReceivedPayment } from './billing.mjs';

async function apiFixture(t,trial=true){
  const folder=mkdtempSync(path.join(tmpdir(),'bp-access-')),dbPath=path.join(folder,'test.db');
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const token='local-test-token-for-company-access-only';
  const child=spawn(process.execPath,[new URL('./server.mjs',import.meta.url).pathname],{
    env:{...process.env,BP_API_PORT:String(port),BP_BOT_TOKEN:token,BP_DB_FILE:dbPath,BP_OPENAI_API_KEY:'',YOOKASSA_SHOP_ID:'',YOOKASSA_SECRET_KEY:''},stdio:['ignore','pipe','pipe']
  });
  t.after(async()=>{if(child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}rmSync(folder,{recursive:true,force:true});});
  let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
  const base='http://127.0.0.1:'+port;
  let ready=false;
  for(let i=0;i<100;i++){
    try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}
    if(child.exitCode!==null)break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(ready,true,logs);
  const headersFor=id=>{
    const data=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:Number(id)})});
  const key=createHmac('sha256','WebAppData').update(token).digest();
  data.set('hash',createHmac('sha256',key).update([...data].map(([k,v])=>k+'='+v).sort().join('\n')).digest('hex'));
    return {'X-Telegram-Init-Data':data.toString(),'Content-Type':'application/json'};
  };
  const call=async(id,route,body)=>{
    const response=await fetch(base+'/api'+route,{headers:headersFor(id),...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
    const data=await response.json();
    if(trial&&route==='/me'&&data.company){const d=new DatabaseSync(dbPath);try{if(!d.prepare('SELECT trial_granted_by FROM company_billing WHERE company_id=?').get(data.company.id).trial_granted_by)startCompanyTrial(d,data.company,'1296951270');}finally{d.close();}}
    return {status:response.status,data};
  };
  return {base,dbPath,headersFor,call};
}

test('Only authenticated admin owner can clear own data; undo, AI and mappings are removed without changing access',async t=>{
  const {call,dbPath}=await apiFixture(t,false);
  const admin='1296951270';
  const own=(await call(admin,'/me')).data.company;
  const other=(await call('101','/me')).data.company;
  const setup=new DatabaseSync(dbPath);
  try{startCompanyTrial(setup,other,admin);}finally{setup.close();}
  const rows=[{date:'2026-10-20',id:'REAL-1',item:'Услуга',amount_kopecks:10000,status:'sale'}];
  assert.equal((await call(admin,'/import',{source:'business.csv',financial_basis:'cash_receipts',rows})).status,200);
  assert.equal((await call('101','/import',{source:'other.csv',financial_basis:'cash_receipts',rows})).status,200);
  assert.equal((await call(admin,'/clear-company-data',{})).status,400);
  assert.equal((await call('101','/clear-company-data',{confirm:'DELETE_ALL_COMPANY_DATA'})).status,403);
  companyAdmin({dbPath,action:'addmember',ownerId:admin,memberId:'303'});
  assert.equal((await call('303','/clear-company-data',{confirm:'DELETE_ALL_COMPANY_DATA'})).status,403);
  const db=new DatabaseSync(dbPath);
  try{
    const tables=['operations','imports','import_batches','import_batch_changes','ai_analyses'];
    for(const table of tables)assert.ok(db.prepare('SELECT COUNT(*) n FROM '+table+' WHERE company_id=?').get(own.id).n>0,table);
    const before=db.prepare('SELECT * FROM company_billing WHERE company_id=?').get(own.id);
    const cleared=await call(admin,'/clear-company-data',{confirm:'DELETE_ALL_COMPANY_DATA'});
    assert.equal(cleared.status,200);assert.equal(cleared.data.removed,1);
    for(const table of [...tables,'operation_correction_changes','import_mapping_templates','import_mapping_suggestions'])
      assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table+' WHERE company_id=?').get(own.id).n,0,table);
    assert.deepEqual(db.prepare('SELECT * FROM company_billing WHERE company_id=?').get(own.id),before);
    assert.equal((await call(admin,'/subscription')).data.subscription.state,'admin');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM operations WHERE company_id<>?').get(own.id).n,1);
    assert.equal((await call('303','/report')).status,200);
    assert.equal((await call(admin,'/import/history')).data.history.length,0);
    assert.equal((await call(admin,'/analysis')).data.status,'no_data');
    assert.equal((await call(admin,'/clear-company-data',{confirm:'DELETE_ALL_COMPANY_DATA'})).data.removed,0);
    assert.equal((await call(admin,'/import',{source:'new.csv',financial_basis:'cash_receipts',rows})).data.stats.added,1);
  }finally{db.close();}
});

test('Unpaid owner and employee are blocked on all business endpoints; admin trial and payment activate same company',async t=>{
  const f=await apiFixture(t,false),{call,dbPath}=f;
  const c=(await call('101','/me')).data.company;
  assert.equal((await call('101','/subscription')).data.subscription.state,'pending');
  companyAdmin({dbPath,action:'addmember',ownerId:'101',memberId:'303'});
  for(const actor of ['101','303']){
    for(const route of ['/report','/analysis','/import/history'])assert.equal((await call(actor,route)).status,402);
    for(const route of ['/import','/import/undo','/import/corrections/preview','/import/corrections/apply','/import/mapping/resolve','/import/mapping/save','/reset-test-data'])assert.equal((await call(actor,route,{})).status,402);
    assert.equal((await call(actor,'/payments/refresh',{})).status,200);
    assert.equal((await call(actor,'/trial',{})).status,402);
  }
  const db=new DatabaseSync(dbPath);t.after(()=>db.close());
  startCompanyTrial(db,c,'1296951270');
  assert.equal((await call('303','/report')).status,200);
  db.prepare('UPDATE company_billing SET trial_ends_ms=? WHERE company_id=?').run(Date.now()-1,c.id);
  assert.equal((await call('303','/report')).status,402);
  const token=paymentConfirmation(db,c,'1296951270','month');confirmReceivedPayment(db,c,'1296951270',token);
  assert.equal((await call('101','/report')).status,200);
  assert.equal((await call('303','/report')).status,200);
  db.prepare('UPDATE company_billing SET paid_until_ms=? WHERE company_id=?').run(Date.now()-1,c.id);
  assert.equal((await call('101','/report')).status,402);
  assert.equal((await call('303','/report')).status,402);
});

test('Only the real company owner can update business type without altering operations or payments',async t=>{
  const {call,dbPath}=await apiFixture(t);
  const owner=(await call('101','/me')).data.company;
  const db=new DatabaseSync(dbPath);
  t.after(()=>db.close());
  startCompanyTrial(db,owner,'1296951270');
  const day=(await call('101','/report')).data.as_of;
  const rows=[{date:day,id:'CHECK-1',item:'Пицца Пепперони',amount_kopecks:78000,status:'sale'}];
  assert.equal((await call('101','/import',{source:'cafe.csv',financial_basis:'cash_receipts',rows})).status,200);
  const beforeOps=db.prepare('SELECT * FROM operations WHERE company_id=?').all(owner.id);
  const billingBefore=db.prepare('SELECT * FROM company_billing WHERE company_id=?').get(owner.id);
  db.prepare('INSERT OR REPLACE INTO ai_analyses(company_id,version,status,payload,updated_ms) VALUES(?,?,?,?,?)')
    .run(owner.id,'fake-old','ready','{}',Date.now());
  assert.equal((await call('101','/company/industry',{industry:'unknown'})).status,400);
  assert.equal((await call('101','/company/industry',{industry:42})).status,400);
  companyAdmin({dbPath,action:'addmember',ownerId:'101',memberId:'303'});
  assert.equal((await call('303','/company/industry',{industry:'cafe'})).status,403);
  const result=await call('101','/company/industry',{industry:'cafe'});
  assert.equal(result.status,200);
  assert.equal(result.data.changed,true);
  assert.equal(result.data.company.industry,'cafe');
  assert.equal(result.data.report.company.industry,'cafe');
  assert.equal(result.data.report.volume.label,'Количество чеков');
  assert.equal(result.data.report.volume.value,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_analyses WHERE company_id=?').get(owner.id).n,0);
  assert.deepEqual(db.prepare('SELECT * FROM operations WHERE company_id=?').all(owner.id),beforeOps);
  assert.deepEqual(db.prepare('SELECT * FROM company_billing WHERE company_id=?').get(owner.id),billingBefore);
  const noChange=await call('101','/company/industry',{industry:'cafe'});
  assert.equal(noChange.status,200);assert.equal(noChange.data.changed,false);
  assert.equal((await call('303','/report')).data.company.industry,'cafe');
});
test('A company owner may correct type before activating a subscription',async t=>{
  const {call}=await apiFixture(t,false);
  const company=(await call('101','/me')).data.company;
  assert.equal(company.industry,'other');
  const changed=await call('101','/company/industry',{industry:'cafe'});
  assert.equal(changed.status,200);
  assert.equal(changed.data.company.industry,'cafe');
  assert.equal(changed.data.report,null);
  assert.equal(changed.data.subscription.access,false);
});

test('Owner and employee import into one company, share history/digest and lose access immediately on revocation',async t=>{
  const f=await apiFixture(t),{call,dbPath}=f;
  const owner=(await call('101','/me')).data.company;
  const employeePersonal=(await call('303','/me')).data.company;
  const stranger=(await call('404','/me')).data.company;
  companyAdmin({dbPath,action:'addmember',ownerId:'101',memberId:'303'});
  const employee=(await call('303','/me')).data.company;
  assert.equal(employee.id,owner.id);assert.equal(employee.access_role,'member');
  assert.notEqual(employeePersonal.id,owner.id);
  const date=(await call('101','/report')).data.as_of;
  const row=(id,amount,qty)=>({date,id,item:'УЗИ',status:'sale',amount_kopecks:amount,quantity_milli:qty});
  const payload=rows=>({source:'Отчёт смены.xlsx',financial_basis:'recognized_revenue',rows});
  assert.equal((await call('101','/import',payload([row('owner',10000,2000)]))).status,200);
  const fromEmployee=await call('303','/import',{...payload([row('employee',20000,3000)]),company_id:stranger.id});
  assert.equal(fromEmployee.status,200);assert.equal(fromEmployee.data.report.company.id,owner.id);
  assert.equal(fromEmployee.data.report.revenue30_kopecks,30000);
  companyAdmin({dbPath,action:'set',ownerId:'101',industry:'clinic'});
  const report=(await call('101','/report')).data;
  assert.equal(report.volume.value,5);
  assert.equal((await call('303','/report')).data.volume.value,5);
  assert.equal((await call('303','/import',payload([row('employee',20000,3000)]))).data.stats.added,0);
  const history=(await call('101','/import/history')).data.history;
  assert.equal(history.length,3);
  assert.deepEqual((await call('303','/import/history')).data.history,history);
  assert.deepEqual((await call('404','/import/history')).data.history,[]);
  assert.equal((await call('404','/report')).data.revenue30_kopecks,0);
  assert.equal(dailyDigestFor('101',{dbPath}),dailyDigestFor('303',{dbPath}));
  assert.doesNotMatch(dailyDigestFor('404',{dbPath}),/Оказано услуг за 30 дней/);
  assert.equal((await call('303','/reset-test-data',{confirm:'DELETE_TEST_DATA'})).status,403);
  const correction={...payload([row('employee',25000,4000)]),cancelled_ids:[]};
  const preview=(await call('303','/import/corrections/preview',correction)).data;
  assert.equal(preview.can_apply,true);
  assert.equal((await call('303','/import/corrections/apply',{...correction,...preview})).status,200);
  assert.equal((await call('101','/report')).data.revenue30_kopecks,35000);
  const correctedHistory=(await call('101','/import/history')).data.history;
  assert.equal((await call('101','/import/undo',{batch_id:correctedHistory[0].id})).status,200);
  assert.equal((await call('303','/report')).data.revenue30_kopecks,30000);
  const stalePreview=(await call('303','/import/corrections/preview',correction)).data;
  companyAdmin({dbPath,action:'removemember',ownerId:'101',memberId:'303'});
  const afterRemoval=(await call('303','/me')).data.company;
  assert.equal(afterRemoval.id,employeePersonal.id);
  assert.equal((await call('303','/report')).data.revenue30_kopecks,0);
  assert.deepEqual((await call('303','/import/history')).data.history,[]);
  assert.notEqual((await call('303','/import/corrections/apply',{...correction,...stalePreview})).status,200);
  assert.equal((await call('303','/import/undo',{batch_id:history[0].id})).status,409);
  assert.match(dailyDigestFor('303',{dbPath}),/Нет загруженного отчёта/);
  assert.equal((await call('101','/report')).data.revenue30_kopecks,30000);
});

test('Expired company is blocked on API for owner and staff, retains data, and verified payment restores both',async t=>{
  const f=await apiFixture(t),{call,dbPath}=f;
  const c=(await call('101','/me')).data.company;
  companyAdmin({dbPath,action:'addmember',ownerId:'101',memberId:'303'});
  const date=(await call('101','/report')).data.as_of;
  const input={source:'report.csv',financial_basis:'cash_receipts',rows:[{date,id:'paid',item:'Услуга',amount_kopecks:10000,status:'sale'}]};
  assert.equal((await call('303','/import',input)).status,200);
  const db=new DatabaseSync(dbPath);t.after(()=>db.close());
  db.prepare('UPDATE company_billing SET trial_ends_ms=? WHERE company_id=?').run(Date.now()-1,c.id);
  assert.equal((await call('101','/report')).status,402);
  assert.equal((await call('303','/report')).status,402);
  assert.equal((await call('303','/import',input)).status,402);
  assert.equal((await call('101','/subscription')).data.subscription.state,'expired');
  assert.match(dailyDigestFor('101',{dbPath}),/Доступ к компании закрыт/);
  const token=paymentConfirmation(db,c,'999','month');confirmReceivedPayment(db,c,'999',token);
  assert.equal((await call('101','/report')).data.revenue30_kopecks,10000);
  assert.equal((await call('303','/report')).data.revenue30_kopecks,10000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operations WHERE company_id=?').get(c.id).n,1);
});

test('Payment catalog is public for website checkout but cannot modify links or access company reports',async t=>{
  const f=await apiFixture(t);
  const response=await fetch(f.base+'/api/prices',{headers:{Origin:'https://balakhmatov.github.io'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'https://balakhmatov.github.io');
  const body=await response.json();assert.equal(body.plans.length,4);
  assert.equal(body.plans.find(p=>p.id==='welcome').price,1990);
  assert.ok(body.plans.every(p=>!Object.hasOwn(p,'payment_url')));
  assert.equal((await fetch(f.base+'/api/prices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://evil.example'})})).status,401);
  assert.equal((await fetch(f.base+'/api/report')).status,401);
});

 test('Payment creation requires signed login and terms, remains available after trial expiry',async t=>{
  const f=await apiFixture(t);
  assert.equal((await fetch(f.base+'/api/payments',{method:'POST'})).status,401);
  await f.call('101','/me');
  const db=new DatabaseSync(f.dbPath);db.prepare('UPDATE company_billing SET trial_ends_ms=?').run(Date.now()-1000);db.close();
  assert.equal((await f.call('101','/payments',{plan:'month'})).status,400);
  assert.equal((await f.call('101','/payments',{plan:'month',accepted_terms:true,company_id:'forged',price:1})).status,503);
  assert.equal((await f.call('101','/payments/refresh',{})).status,200);
 });

test('Website login grants payment access only after bot confirmation and cannot read reports',async t=>{
  const f=await apiFixture(t,false);
  const start=await fetch(f.base+'/api/web-login',{method:'POST'}),a=await start.json();
  assert.equal(start.status,200);
  const poll=()=>fetch(f.base+'/api/web-login/poll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(a)});
  assert.deepEqual(await (await poll()).json(),{pending:true});
  const {createWebLogin}=await import('./web-login.mjs');const db=new DatabaseSync(f.dbPath);t.after(()=>db.close());
  createWebLogin(db).approve(a.challenge,'101');
  const {token}=await (await poll()).json();assert.ok(token);
  const headers={'X-BP-Web-Session':token,'Content-Type':'application/json'};
  const refreshed=await fetch(f.base+'/api/payments/refresh',{method:'POST',headers});assert.equal(refreshed.status,200);
  assert.equal((await refreshed.json()).subscription.state,'pending');
  assert.equal((await fetch(f.base+'/api/report',{headers})).status,401);
  assert.equal((await fetch(f.base+'/api/payments',{method:'POST',headers,body:JSON.stringify({plan:'month'})})).status,400);
  assert.equal((await poll()).status,400);
});

