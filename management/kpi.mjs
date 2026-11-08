import { randomUUID } from 'node:crypto';

export function initKpi(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mg_kpi_definitions(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mg_plan_options(plan_id TEXT PRIMARY KEY,company_id TEXT NOT NULL,payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mg_kpi_values(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,metric TEXT NOT NULL,source TEXT NOT NULL,external_id TEXT NOT NULL,date TEXT NOT NULL,location_id TEXT,employee_id TEXT,value REAL,numerator REAL,denominator REAL,updated_at TEXT NOT NULL,UNIQUE(company_id,source,external_id));
    CREATE INDEX IF NOT EXISTS mg_kpi_values_period ON mg_kpi_values(company_id,metric,date);
    CREATE TABLE IF NOT EXISTS mg_kpi_health(company_id TEXT NOT NULL,source TEXT NOT NULL,location_id TEXT NOT NULL,employee_id TEXT NOT NULL,through_date TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(company_id,source,location_id,employee_id));
    CREATE TABLE IF NOT EXISTS mg_kpi_seen(company_id TEXT NOT NULL,user_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(company_id,user_id,event_id));
  `);
}
const shift = (d,n) => new Date(Date.parse(d)+n*86400000).toISOString().slice(0,10);
const defaultOptions = { weekdays:[1,1,1,1,1,1,1], dates:{}, tolerance:0, stale_hours:24, notify:true, source:'', upper:null };
export function calendarDays(start,end,options={}) {
  const o={...defaultOptions,...options}, out=[];
  for(let date=start;date<=end;date=shift(date,1)) out.push({date,weight:o.dates[date] ?? o.weekdays[new Date(date+'T00:00:00Z').getUTCDay()]});
  return out;
}
export function evaluateKpi(p,actual,asof,additive,options={}) {
  const o={...defaultOptions,...options}, calendar=calendarDays(p.start_on,p.end_on,o);
  const total=calendar.reduce((n,d)=>n+d.weight,0), elapsed=calendar.filter(d=>d.date<=asof).reduce((n,d)=>n+d.weight,0), remaining=total-elapsed;
  const targetToDate=additive ? p.target*elapsed/total : p.target;
  const upperToDate=p.direction==='range'?(additive?o.upper*elapsed/total:o.upper):null;
  const scale=Math.max(Math.abs(targetToDate),1e-9), deviation=actual===null?null:actual-targetToDate;
  const adverse=actual===null?null:p.direction==='down'?Math.max(0,actual-targetToDate):p.direction==='range'?Math.max(0,targetToDate-actual,actual-upperToDate):Math.max(0,targetToDate-actual);
  const before=asof<p.start_on||elapsed===0, finished=asof>=p.end_on;
  const status=before?'pending':actual===null?'unknown':adverse<=scale*o.tolerance/100?'good':'attention';
  return {actual,upper_to_date:upperToDate,target_to_date:targetToDate,deviation,completion:additive&&p.direction==='up'&&p.target>0&&actual!==null?actual/p.target*100:null,
    forecast:additive&&elapsed>0&&actual!==null?actual/elapsed*total:null,
    required_rate:additive&&p.direction==='up'&&remaining>0&&actual!==null?Math.max(0,p.target-actual)/remaining:null,
    remaining:actual===null?null:Math.max(0,p.target-actual), elapsed_weight:elapsed,total_weight:total,remaining_weight:remaining,
    adverse_percent:adverse===null||targetToDate===0?null:adverse/scale*100,status,finished,options:o,
    timeline:calendar.map(d=>({date:d.date,weight:d.weight})),
  };
}
export function createKpi({db,fail,text,number,day,today,can,within,ref,transaction,audit}) {
  const records=(a)=>db.prepare('SELECT * FROM mg_kpi_definitions WHERE company_id=? ORDER BY rowid').all(a.company_id).map(r=>({id:r.id,...JSON.parse(r.payload_json)}));
  const definitions=(a)=>Object.fromEntries(records(a).map(r=>[r.id,r]));
  const options=(a,id)=>JSON.parse(db.prepare('SELECT payload_json FROM mg_plan_options WHERE company_id=? AND plan_id=?').get(a.company_id,id)?.payload_json||'{}');
  const requirePlan=a=>{if(!can(a,'plans')) fail('Недостаточно прав.',403);};
  function scope(a,input) {
    const location=ref('locations',a.company_id,input.location_id),employee=ref('employees',a.company_id,input.employee_id);
    if(location) within(a,location);
    if((a.scope.length||['manager','employee'].includes(a.role))&&!location) fail('Выберите свою точку.',403);
    if(employee&&location) {
      const e=db.prepare('SELECT locations_json FROM mg_employees WHERE company_id=? AND id=?').get(a.company_id,employee);
      if(!JSON.parse(e.locations_json).includes(location)) fail('Сотрудник не относится к точке.');
    }
    return {location_id:location,employee_id:employee};
  }
  function definition(a,input) {
    if(!can(a,'structure')) fail('Настройка показателей доступна владельцу и директору.',403);
    const id=input.id||'custom_'+randomUUID();
    const ds=definitions(a),old=Object.hasOwn(ds,id)?ds[id]:null;
    if(!old&&records(a).length>=100) fail('В компании уже 100 собственных показателей.');
    if(input.id&&!old) fail('Показатель не найден.',404);
    if(!['sum','latest','ratio'].includes(input.aggregation)) fail('Выберите способ расчёта.');
    if(!['money','number','percent'].includes(input.unit)) fail('Выберите единицу.');
    if(!['up','down','range'].includes(input.direction)) fail('Выберите правило оценки.');
    if(old&&['unit','aggregation','direction'].some(k=>old[k]!==input[k])) fail('Способ расчёта, единица и правило существующего KPI неизменны. Создайте новый показатель.');
    const payload={label:text(input.label,100),unit:input.unit,aggregation:input.aggregation,direction:input.direction,
      source:text(input.source,80,false), numerator_label:text(input.numerator_label||'Числитель',80),denominator_label:text(input.denominator_label||'Знаменатель',80)};
    db.prepare('INSERT INTO mg_kpi_definitions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').run(id,a.company_id,JSON.stringify(payload));
    audit(a,'save:kpi',id);return {id};
  }
  function validateOptions(a,input,p) {
    const old=p.id?options(a,p.id):{}, raw=input.options||{};
    if(typeof raw!=='object'||Array.isArray(raw)) fail('Некорректный календарь.');
    const o={...defaultOptions,...old,...raw};
    if(!Array.isArray(o.weekdays)||o.weekdays.length!==7) fail('Нужны веса семи дней недели.');
    o.weekdays=o.weekdays.map(x=>number(x));
    if(!o.dates||Array.isArray(o.dates)||typeof o.dates!=='object'||Object.keys(o.dates).length>1097) fail('Неверный календарь исключений.');
    for(const [d,w] of Object.entries(o.dates)){day(d);if(d<p.start_on||d>p.end_on) fail('Дата календаря вне периода плана.');number(w);}
    number(o.tolerance);if(o.tolerance>100) fail('Допуск от 0 до 100%.');
    number(o.stale_hours);if(o.stale_hours<1||o.stale_hours>8760) fail('Интервал обновления от 1 до 8760 часов.');
    o.notify=o.notify!==false;o.source=text(o.source,80,false);
    if(p.direction==='range') {number(o.upper,{min:-1e12});if(o.upper<p.target) fail('Верхняя граница меньше нижней.');}else o.upper=null;
    if(!calendarDays(p.start_on,p.end_on,o).some(d=>d.weight>0)) fail('В календаре нет рабочих дней.');
    return o;
  }
  function saveOptions(a,id,o){db.prepare('INSERT INTO mg_plan_options VALUES(?,?,?) ON CONFLICT(plan_id) DO UPDATE SET payload_json=excluded.payload_json').run(id,a.company_id,JSON.stringify(o));}
  function values(a,input) {
    if(a.role!=='integration') requirePlan(a);
    const source=text(input.source,80),batch=input.rows;
    if(!Array.isArray(batch)||!batch.length||batch.length>5000) fail('Отправьте от 1 до 5000 строк.');
    const defs=definitions(a),seen=new Set();
    const prepared=batch.map(r=>{
      const external=text(r.external_id,160);if(seen.has(external)) fail('Повторный ID в пакете.');seen.add(external);
      const def=Object.hasOwn(defs,r.metric)?defs[r.metric]:null;if(!def) fail('Собственный KPI не найден.');
      if(def.source&&def.source!==source) fail('Источник не соответствует настройке KPI.');
      const date=day(r.date);if(date>today()) fail('Факт не может относиться к будущему.');
      const s=scope(a,r);
      const prior=db.prepare('SELECT * FROM mg_kpi_values WHERE company_id=? AND source=? AND external_id=?').get(a.company_id,source,external);
      if(prior){scope(a,prior);if(prior.metric!==r.metric) fail('ID уже используется другим KPI.');}
      const ratio=def.aggregation==='ratio';
      return {id:prior?.id||randomUUID(),external,metric:r.metric,date,...s,
        value:ratio?null:number(r.value,{min:-1e12}), numerator:ratio?number(r.numerator,{min:-1e12}):null,denominator:ratio?number(r.denominator):null};
    });
    return transaction(db,()=>{
      for(const r of prepared) db.prepare(`INSERT INTO mg_kpi_values VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,source,external_id) DO UPDATE SET date=excluded.date,location_id=excluded.location_id,employee_id=excluded.employee_id,value=excluded.value,numerator=excluded.numerator,denominator=excluded.denominator,updated_at=excluded.updated_at`).run(r.id,a.company_id,r.metric,source,r.external,r.date,r.location_id,r.employee_id,r.value,r.numerator,r.denominator,new Date().toISOString());
      if(a.key_id) db.prepare('UPDATE mg_keys SET last_success=? WHERE id=?').run(new Date().toISOString(),a.key_id);
      audit(a,'import:kpi',source);return {saved:prepared.length};
    });
  }
  function customRows(a,p,cut) {
    return db.prepare('SELECT * FROM mg_kpi_values WHERE company_id=? AND metric=? AND date>=? AND date<=? ORDER BY date,updated_at,id').all(a.company_id,p.metric,p.start_on,cut).filter(r=>(!p.location_id||r.location_id===p.location_id)&&(!p.employee_id||r.employee_id===p.employee_id)&&(!p.options?.source||p.options.source===r.source));
  }
  function aggregateCustom(def,rows) {
    if(!rows.length) return null;
    if(def.aggregation==='latest') {
      // A snapshot is only meaningful for one series. Do not silently sum snapshots of different scopes/sources.
      const series=new Set(rows.map(r=>[r.source,r.location_id||'',r.employee_id||''].join('|')));
      return series.size===1?rows.at(-1).value:null;
    }
    if(def.aggregation==='ratio') {
      const den=rows.reduce((n,r)=>n+r.denominator,0);return den>0?rows.reduce((n,r)=>n+r.numerator,0)/den*(def.unit==='percent'?100:1):null;
    }
    return rows.reduce((n,r)=>n+r.value,0);
  }
  function heartbeat(a,input) {
    if(a.role!=='integration'&&!can(a,'integrations')) fail('Недостаточно прав.',403);
    const source=text(input.source,80),s=scope(a,input),through=day(input.through_date);
    if(through>today())fail('Дата подтверждения не может быть в будущем.');
    db.prepare('INSERT INTO mg_kpi_health VALUES(?,?,?,?,?,?) ON CONFLICT(company_id,source,location_id,employee_id) DO UPDATE SET through_date=excluded.through_date,updated_at=excluded.updated_at').run(a.company_id,source,s.location_id||'',s.employee_id||'',through,new Date().toISOString());
    audit(a,'heartbeat',source);return {ok:true};
  }
  function health(a,p,source) {
    return db.prepare('SELECT * FROM mg_kpi_health WHERE company_id=? AND location_id=? AND employee_id=? ORDER BY updated_at DESC').all(a.company_id,p.location_id||'',p.employee_id||'').find(r=>!source||r.source===source);
  }
  const historyVisible=(a,p)=>(!a.scope.length&&!['manager','employee'].includes(a.role)||a.scope.includes(p.location_id))&&(a.role!=='employee'||p.employee_id===a.employee_id);
  function history(a,id,plans) {
    if(!plans.some(p=>p.id===id)) fail('План недоступен.',403);
    return db.prepare('SELECT changed_at,payload_json FROM mg_plan_history WHERE company_id=? AND plan_id=? ORDER BY rowid DESC LIMIT 50').all(a.company_id,id).map(r=>({changed_at:r.changed_at,...JSON.parse(r.payload_json)})).filter(r=>historyVisible(a,r.after)).map(r=>({...r,before:r.before&&historyVisible(a,r.before)?r.before:null,before_hidden:Boolean(r.before&&!historyVisible(a,r.before))}));
  }
  function notifications(a,plans) {
    const now=Date.now(),events=[];
    for(const p of plans) {
      if(!p.options.notify||p.status==='pending'||p.end_on<today()) continue;
      if(p.status==='attention'&&p.coverage_confirmed&&p.last_update&&now-Date.parse(p.last_update)<=p.options.stale_hours*3600000) events.push({id:`${p.id}:${p.version}:deviation:${today()}`,plan_id:p.id,kind:'deviation',metric:p.metric,title:'Отклонение от плана',detail:p.adverse_percent===null?'Отклонение от нулевой цели':`Отклонение ${Math.round(p.adverse_percent)}% от цели к дате`});
      else if(p.status==='good'&&p.direction==='up'&&p.completion>=100) events.push({id:`${p.id}:${p.version}:reached`,plan_id:p.id,kind:'reached',metric:p.metric,title:'План выполнен',detail:'Цель на период достигнута'});
      if(!p.coverage_confirmed||!p.last_update||now-Date.parse(p.last_update)>p.options.stale_hours*3600000) events.push({id:`${p.id}:${p.version}:stale:${today()}`,plan_id:p.id,kind:'stale',metric:p.metric,title:'Проверьте обновление данных',detail:!p.coverage_confirmed?`Нет подтверждённых данных по ${p.as_of}. Последняя дата факта: ${p.data_through||'нет'}`:p.last_update?`Последнее обновление: ${p.last_update}`:'Данные для этого плана ещё не поступали'});
    }
    const seen=new Set(db.prepare('SELECT event_id FROM mg_kpi_seen WHERE company_id=? AND user_id=?').all(a.company_id,a.user_id).map(r=>r.event_id));
    return events.map(e=>({...e,seen:seen.has(e.id)}));
  }
  function acknowledge(a,id,events){if(!events.some(e=>e.id===id)) fail('Уведомление недоступно.',404);db.prepare('INSERT OR IGNORE INTO mg_kpi_seen VALUES(?,?,?)').run(a.company_id,a.user_id,id);return {ok:true};}
  function visibleValues(a) {
    return db.prepare('SELECT * FROM mg_kpi_values WHERE company_id=? ORDER BY date DESC,updated_at DESC LIMIT 5000').all(a.company_id).filter(r=>(!a.scope.length&&!['manager','employee'].includes(a.role)||a.scope.includes(r.location_id))&&(a.role!=='employee'||r.employee_id===a.employee_id)).slice(0,100);
  }
  return {heartbeat,health,visibleValues,definitions,records,definition,options,validateOptions,saveOptions,values,scope,customRows,aggregateCustom,history,notifications,acknowledge};
}
