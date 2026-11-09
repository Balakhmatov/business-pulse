import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {openStore,createService} from './core.mjs';
import {createApp} from './server.mjs';

test('Nginx insertion is confined to stage HTTPS, preserves other apps and is idempotent',()=>{
  const result=spawnSync('python3',['-B','-c',`
import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('stage_route','management/deploy/nginx-stage-route.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
production='server {\\n server_name cityai.site;\\n listen 443 ssl;\\n location / { proxy_pass http://production; }\\n}\\n'
stage='server {\\n server_name stage.cityai.site;\\n listen [::]:443 ssl http2;\\n location / { proxy_pass http://stage_node; }\\n # a closing brace in a comment }\\n}\\n'
http='server {\\n server_name stage.cityai.site;\\n listen 80;\\n return 301 https://$host$request_uri;\\n}\\n'
snippet=Path('management/deploy/stage-nginx.conf').read_text()
old=production+stage+http
new=m.add_stage_route(old,snippet)
assert new.startswith(production) and new.endswith(http)
assert 'proxy_pass http://stage_node;' in new
assert new.count('127.0.0.1:3129')==1 and '127.0.0.1:3128' not in new
assert m.add_stage_route(new,snippet)==new
for bad in [production+http,old+stage,old.replace('proxy_pass http://stage_node;','proxy_pass http://stage_node; } location /businesspulse/ { return 404;')]:
 try:m.add_stage_route(bad,snippet)
 except ValueError:pass
 else:raise AssertionError('Unsafe or ambiguous configuration accepted')
print('Stage route isolation passed')
  `],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

test('stage service owns its database and dev timer; installer never releases production',()=>{
  const read=name=>fs.readFileSync(new URL('./deploy/'+name,import.meta.url),'utf8');
  const unit=read('business-pulse-management-stage.service');
  assert.match(unit,/User=business-pulse-stage\n/);assert.match(unit,/BPM_PORT=3129/);
  assert.match(unit,/BPM_DB_FILE=\/var\/lib\/business-pulse-management-stage\/management.db/);
  assert.match(unit,/Environment=BPM_ENV=stage/);
  assert.equal(unit.includes('ReadWritePaths=/var/lib/business-pulse-management\n'),false);
  const installer=read('install-stage.sh');
  assert.equal(installer.includes('release-production.sh'),false);
  assert.equal(installer.includes('cp /var/lib/business-pulse-management/management.db'),false);
  assert.match(read('stage-autodeploy.sh'),/BRANCH=dev/);
  assert.match(read('release-production.sh'),/BRANCH=production/);
  assert.match(read('business-pulse-management-stage-deploy.timer'),/Unit=business-pulse-management-stage-deploy.service/);
});

test('stage has its own login and data, visible stage label and production rejects its origin',async t=>{
  const prodDb=openStore(),stageDb=openStore(),prod=createService(prodDb),stage=createService(stageDb);
  const owner=(s,name)=>({...s.owner({company:name,name,email:'owner@isolation.test',password:'test-password-12345'}),role:'owner',scope:[]});
  const p=owner(prod,'Production'),s=owner(stage,'Stage');
  const prodApp=createApp({db:prodDb,origin:'https://cityai.site',basePath:'/businesspulse',secure:false,demo:false});
  const stageApp=createApp({db:stageDb,origin:'https://stage.cityai.site',basePath:'/businesspulse',environment:'stage',secure:false,demo:false});
  for(const app of [prodApp,stageApp]){app.listen(0,'127.0.0.1');await once(app,'listening');}
  t.after(()=>{for(const app of [prodApp,stageApp]){app.closeAllConnections();app.close();}prodDb.close();stageDb.close();});
  const base=app=>'http://127.0.0.1:'+app.address().port+'/businesspulse';
  const html=await fetch(base(stageApp)+'/');
  assert.equal(html.headers.get('x-business-pulse-environment'),'stage');assert.match(html.headers.get('x-robots-tag'),/noindex/);
  const stageHtml=await html.text();
  assert.match(stageHtml,/data-environment="stage"/);
  assert.match(stageHtml,/<div class="stage-banner"/);
  assert.equal(stageHtml.includes('<aside class="stage-banner"'),false);
  const normal=await fetch(base(prodApp)+'/');assert.equal(normal.headers.get('x-business-pulse-environment'),null);assert.equal((await normal.text()).includes('data-environment="stage"'),false);
  const login=await fetch(base(prodApp)+'/api/login',{method:'POST',headers:{Origin:'https://cityai.site','Content-Type':'application/json'},body:JSON.stringify({email:'owner@isolation.test',password:'test-password-12345'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base(stageApp)+'/api/workspace',{headers:{Cookie:cookie}})).status,401);
  const blocked=await fetch(base(prodApp)+'/api/save',{method:'POST',headers:{Cookie:cookie,Origin:'https://stage.cityai.site','Content-Type':'application/json'},body:JSON.stringify({type:'locations',record:{name:'Stage write'}})});
  assert.equal(blocked.status,403);
  stage.save(s,'locations',{name:'Stage only'});assert.equal(stage.snapshot(s).locations.length,1);assert.equal(prod.snapshot(p).locations.length,0);
});

test('stage owner helper skips existing stage owners without asking for or changing credentials',t=>{
  const root=fs.mkdtempSync('/tmp/bp-stage-owner-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dbFile=root+'/stage.db',db=openStore(dbFile);createService(db).owner({company:'Stage',name:'Stage',email:'stage@owner.test',password:'test-password-12345'});db.close();
  fs.writeFileSync(root+'/id','#!/bin/sh\necho 0\n',{mode:0o755});
  fs.writeFileSync(root+'/runuser','#!/bin/sh\nshift 3\nexec "$@"\n',{mode:0o755});
  const source=fs.readFileSync(new URL('./deploy/create-stage-owner.sh',import.meta.url),'utf8').replaceAll('/var/lib/business-pulse-management-stage/management.db',dbFile).replaceAll('/usr/local/bin/node-business-pulse',process.execPath).replaceAll('/opt/business-pulse-management-stage',root);
  fs.writeFileSync(root+'/owner.sh',source);
  const r=spawnSync('bash',[root+'/owner.sh'],{encoding:'utf8',timeout:10000,env:{...process.env,PATH:root+':'+process.env.PATH}});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/already has an owner/);
});

test('stage installer changes to the public checkout before runuser child-process checks and tests',()=>{
  const script=fs.readFileSync(new URL('./deploy/install-stage.sh',import.meta.url),'utf8');
  const cd=script.indexOf('cd "$REPO"'),fork=script.indexOf('Stage Node child-process check failed'),tests=script.indexOf('"$NODE" --test');
  assert.ok(cd>=0&&cd<fork&&fork<tests);
});
