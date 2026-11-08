import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openStore,createService,today} from './core.mjs';
import {evaluateKpi} from './kpi.mjs';
import {createApp} from './server.mjs';
import {configuredDemo} from './demo.mjs';
import {once} from 'node:events';
function fixture(t) {
  const db=openStore(),s=createService(db);t.after(()=>db.close());
  const a={...s.owner({company:'KPI',name:'Owner',email:'owner@kpi.test',password:'test-password-12345'}),role:'owner',scope:[]};
  const l=s.save(a,'locations',{name:'North'}).id,l2=s.save(a,'locations',{name:'South'}).id;
  const e=s.save(a,'employees',{name:'Anna',location_ids:[l]}).id;
  const start=today().slice(0,7)+'-01',end=today();
  const define=(extra={})=>s.defineKpi(a,{label:'Capacity',aggregation:'ratio',unit:'percent',direction:'up',source:'mis',...extra}).id;
  return {db,s,a,l,l2,e,start,end,define};
}
test('weighted plan calendar, day overrides, required pace and maximum/range goals',()=>{
  const p={start_on:'2026-11-02',end_on:'2026-11-08',target:100,direction:'up'};
  const result=evaluateKpi(p,30,'2026-11-04',true,{weekdays:[0,1,1,1,1,1,0],dates:{'2026-11-03':0,'2026-11-06':2}});
  assert.equal(result.total_weight,5);assert.equal(result.elapsed_weight,2);
  assert.equal(result.target_to_date,40);assert.equal(result.required_rate,70/3);assert.equal(result.forecast,75);
  assert.equal(evaluateKpi({...p,target:2,direction:'down'},1,'2026-11-04',false).status,'good');
  assert.equal(evaluateKpi({...p,target:2,direction:'down'},3,'2026-11-04',false).completion,null);
  assert.equal(evaluateKpi({...p,target:70,direction:'range'},82,'2026-11-04',false,{upper:85}).status,'good');
  assert.equal(evaluateKpi({...p,target:70,direction:'range'},90,'2026-11-04',false,{upper:85}).status,'attention');
  assert.equal(evaluateKpi(p,38,'2026-11-04',true,{weekdays:[0,1,1,1,1,1,0],dates:{'2026-11-03':0,'2026-11-06':2},tolerance:5}).status,'good');
});
test('custom ratios use weighted totals, correct imports are idempotent, zero denominator unknown',t=>{
  const {s,a,l,start,end,define}=fixture(t),metric=define();
  s.plan(a,{metric,target:80,start_on:start,end_on:end,location_id:l});
  const r={external_id:'one',metric,date:end,location_id:l,numerator:1,denominator:2};
  s.importKpi(a,{source:'mis',rows:[r,{...r,external_id:'two',numerator:9,denominator:10}]});
  assert.ok(Math.abs(s.snapshot(a).plans[0].actual-1000/12)<1e-10);
  s.importKpi(a,{source:'mis',rows:[r]});assert.equal(s.snapshot(a).kpi_values.length,2);
  s.importKpi(a,{source:'mis',rows:[{...r,numerator:0,denominator:0},{...r,external_id:'two',numerator:0,denominator:0}]});
  const p=s.snapshot(a).plans[0];assert.equal(p.actual,null);assert.equal(p.status,'unknown');
  assert.throws(()=>s.importKpi(a,{source:'wrong',rows:[r]}),/Источник/);
  assert.throws(()=>s.defineKpi(a,{id:metric,label:'X',unit:'number',aggregation:'sum',direction:'up'}),/неизменны/);
  assert.throws(()=>s.plan(a,{metric:'toString',target:1,start_on:start,end_on:end}),/Неизвестный/);
});
test('KPI writes, reads, notifications and history honor tenant and location permissions',t=>{
  const {s,a,l,l2,e,start,end,define}=fixture(t),metric=define({source:''});
  const id=s.plan(a,{metric,target:90,start_on:start,end_on:end,location_id:l}).id;
  s.plan(a,{metric,target:90,start_on:start,end_on:end,location_id:l2});
  const row={external_id:'one',metric,date:end,location_id:l,numerator:1,denominator:2};
  s.importKpi(a,{source:'manual',rows:[row,{...row,external_id:'two',location_id:l2}]});
  const manager={...a,role:'manager',scope:[l]};
  assert.equal(s.snapshot(manager).plans.length,1);assert.equal(s.snapshot(manager).kpi_values.length,1);
  assert.throws(()=>s.importKpi(manager,{source:'manual',rows:[{...row,external_id:'two',location_id:l}]}),/доступа/);
  assert.throws(()=>s.importKpi(manager,{source:'manual',rows:[{...row,location_id:l2}]}),/доступа/);
  assert.throws(()=>s.defineKpi(manager,{label:'x'}),/владельцу/);
  const employee={...a,role:'employee',scope:[l],employee_id:e};assert.equal(s.snapshot(employee).plans.length,0);assert.equal(s.snapshot(employee).kpi_values.length,0);
  assert.throws(()=>s.importKpi(employee,{source:'manual',rows:[row]}),/прав/);
  const other={...s.owner({company:'Other',name:'Other',email:'other@kpi.test',password:'test-password-12345'}),role:'owner',scope:[]};
  assert.throws(()=>s.importKpi(other,{source:'manual',rows:[row]}),/не найден/);
  assert.throws(()=>s.planHistory(other,id),/недоступен/);
  const notes=s.snapshot(manager).notifications;assert.ok(notes.some(n=>n.kind==='deviation'));assert.equal(notes.length,1);
  s.acknowledge(manager,notes[0].id);assert.equal(s.snapshot(manager).notifications[0].seen,true);
  assert.equal(s.snapshot(a).notifications.find(n=>n.id===notes[0].id).seen,true); // same user, different role
  assert.equal(s.snapshot(manager,{to:'2020-01-01',from:'2020-01-01'}).notifications.length,0);
});
test('calendar revisions and atomic bulk copying retain goals and reject invalid employee point assignments',t=>{
  const {db,s,a,l,l2,e,start,end}=fixture(t);
  const id=s.plan(a,{metric:'sales',target:100,start_on:start,end_on:end,location_id:l,employee_id:e,options:{tolerance:5}}).id;
  s.plan(a,{id,metric:'sales',target:200,start_on:start,end_on:end,location_id:l,employee_id:e,options:{tolerance:10}});
  const history=s.planHistory(a,id);assert.equal(history.length,2);assert.equal(history[0].before.options.tolerance,5);assert.equal(history[0].after.options.tolerance,10);
  const count=()=>db.prepare('SELECT count(*) n FROM mg_plans').get().n;
  assert.throws(()=>s.copyPlans(a,{ids:[id],start_on:start,end_on:end,location_ids:[l,l2]}),/Сотрудник/);assert.equal(count(),1);
  s.copyPlans(a,{ids:[id],start_on:start,end_on:end});assert.equal(count(),2);
  assert.throws(()=>s.plan(a,{metric:'sales',target:10,start_on:start,end_on:end,options:{weekdays:[0,0,0,0,0,0,0]}}),/рабочих/);
  assert.throws(()=>s.plan(a,{metric:'sales',target:10,start_on:start,end_on:end,options:{dates:{'2020-01-01':1}}}),/вне периода/);
});
test('snapshot metrics refuse ambiguous series and values batches roll back together',t=>{
  const {s,a,l,l2,start,end,define}=fixture(t),metric=define({aggregation:'latest',unit:'number',source:''});
  s.plan(a,{metric,target:10,start_on:start,end_on:end});
  const row={metric,external_id:'x',date:end,location_id:l,value:12};
  s.importKpi(a,{source:'manual',rows:[row]});assert.equal(s.snapshot(a).plans[0].actual,12);
  assert.throws(()=>s.importKpi(a,{source:'manual',rows:[{...row,external_id:'y'},{...row,external_id:'bad',value:NaN}]}));assert.equal(s.snapshot(a).kpi_values.length,1);
  s.importKpi(a,{source:'manual',rows:[{...row,external_id:'z',location_id:l2}]});assert.equal(s.snapshot(a).plans[0].actual,null);
});
test('stale data produces a separate source warning instead of a misleading business decline',t=>{
  const {db,s,a,l,start,end,define}=fixture(t),metric=define();
  s.plan(a,{metric,target:90,start_on:start,end_on:end,location_id:l});
  s.importKpi(a,{source:'mis',rows:[{metric,external_id:'x',date:end,location_id:l,numerator:1,denominator:2}]});
  db.prepare("UPDATE mg_kpi_values SET updated_at='2020-01-01T00:00:00.000Z'").run();
  const notes=s.snapshot(a).notifications;assert.deepEqual(notes.map(n=>n.kind),['stale']);
});
test('configured demo copies custom KPI configuration and generates isolated synthetic facts',t=>{
  const {s,a,l,start,end,define}=fixture(t),metric=define();
  s.plan(a,{metric,target:80,start_on:start,end_on:end,location_id:l});
  s.save(a,'products',{name:'Product',category:'Cat',unit:'шт.'});
  const live=s.snapshot(a),demo=configuredDemo(live,{from:start,to:end});t.after(()=>demo.db.close());
  assert.equal(demo.service.snapshot(demo.actor).plans[0].actual,75);
  assert.equal(s.snapshot(a).plans[0].actual,null);
});
test('HTTP KPI API accepts bearer imports, rejects revoked keys and enforces cookie origin',async t=>{
  const {s,a,l,start,end,define,db}=fixture(t),metric=define();
  const app=createApp({db,origin:'http://kpi.local',demo:false});app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>{app.closeAllConnections();app.close();});
  const base='http://127.0.0.1:'+app.address().port,key=s.key(a,'MIS');
  const request=(route,payload,headers={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(payload)});
  const data={source:'mis',rows:[{metric,external_id:'x',date:end,location_id:l,numerator:3,denominator:4}]};
  assert.equal((await request('/api/v1/kpi-values',data,{Authorization:'Bearer '+key.token})).status,200);
  s.revoke(a,key.id);assert.equal((await request('/api/v1/kpi-values',data,{Authorization:'Bearer '+key.token})).status,401);
  const login=await request('/api/login',{email:'owner@kpi.test',password:'test-password-12345'},{Origin:'http://kpi.local'}),cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/kpi-values',data,{Cookie:cookie,Origin:'http://evil.local'})).status,403);
  assert.equal((await request('/api/kpi-values',data,{Cookie:cookie,Origin:'http://kpi.local'})).status,200);
});
test('explicit heartbeat distinguishes zero sales from absent data and stays scoped',t=>{
  const {s,a,l,l2,start,end}=fixture(t);
  s.plan(a,{metric:'sales',target:100,start_on:start,end_on:end,location_id:l,options:{source:'pos'}});
  assert.equal(s.snapshot(a).plans[0].actual,null);
  s.heartbeat(a,{source:'pos',through_date:end,location_id:l2});
  assert.equal(s.snapshot(a).plans[0].actual,null);
  s.heartbeat(a,{source:'pos',through_date:end,location_id:l});
  const p=s.snapshot(a).plans[0];assert.equal(p.actual,0);assert.equal(p.coverage_confirmed,true);
  assert.deepEqual(s.snapshot(a).notifications.map(n=>n.kind),['deviation']);
  assert.throws(()=>s.heartbeat({...a,role:'manager',scope:[l]},{source:'pos',through_date:end,location_id:l}),/прав/);
});
test('range bounds on additive KPIs both follow the same working calendar',()=>{
  const p={start_on:'2026-11-01',end_on:'2026-11-10',target:100,direction:'range'};
  const r=evaluateKpi(p,80,'2026-11-05',true,{upper:120});
  assert.equal(r.target_to_date,50);assert.equal(r.upper_to_date,60);assert.equal(r.status,'attention');
});
test('chart requests cannot expose a hidden plan and old plan history is scoped',t=>{
  const {s,a,l,l2,start,end}=fixture(t);
  const id=s.plan(a,{metric:'sales',target:999,start_on:start,end_on:end,location_id:l2}).id;
  s.plan(a,{id,metric:'sales',target:100,start_on:start,end_on:end,location_id:l});
  const other=s.plan(a,{metric:'sales',target:500,start_on:start,end_on:end,location_id:l2}).id;
  const manager={...a,role:'manager',scope:[l]};
  const history=s.planHistory(manager,id);assert.equal(history.length,1);assert.equal(history[0].before,null);assert.equal(history[0].before_hidden,true);
  const visible=s.snapshot(manager,{plan_chart_id:other}).plans;assert.equal(visible.length,1);assert.ok(visible[0].timeline.length>0);
});
