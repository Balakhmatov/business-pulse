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

test('Signed owner cannot change industry through API; operator assignment appears in next report',async t=>{
  const folder=mkdtempSync(path.join(tmpdir(),'bp-access-')),dbPath=path.join(folder,'test.db');
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const token='local-test-token-for-company-access-only';
  const child=spawn(process.execPath,[new URL('./server.mjs',import.meta.url).pathname],{
    env:{...process.env,BP_API_PORT:String(port),BP_BOT_TOKEN:token,BP_DB_FILE:dbPath,BP_OPENAI_API_KEY:''},stdio:['ignore','pipe','pipe']
  });
  t.after(async()=>{const ended=once(child,'exit');child.kill();await ended;rmSync(folder,{recursive:true,force:true});});
  let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
  const base='http://127.0.0.1:'+port;
  let ready=false;
  for(let i=0;i<100;i++){
    try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}
    if(child.exitCode!==null)break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(ready,true,logs);
  const data=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:101})});
  const key=createHmac('sha256','WebAppData').update(token).digest();
  data.set('hash',createHmac('sha256',key).update([...data].map(([k,v])=>k+'='+v).sort().join('\n')).digest('hex'));
  const headers={'X-Telegram-Init-Data':data.toString(),'Content-Type':'application/json'};
  const me=await fetch(base+'/api/me',{headers});assert.equal(me.status,200);
  assert.equal((await me.json()).company.industry,'other');
  const denied=await fetch(base+'/api/company/industry',{method:'POST',headers,body:JSON.stringify({industry:'clinic'})});
  assert.equal(denied.status,404);
  companyAdmin({dbPath,action:'set',ownerId:'101',industry:'clinic'});
  const report=await (await fetch(base+'/api/report',{headers})).json();
  assert.equal(report.company.industry,'clinic');assert.equal(report.volume.label,'Оказано услуг');
});
