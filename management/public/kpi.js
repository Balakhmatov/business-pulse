export function createKpiUI(h) {
  const {esc,input,select,textarea,table,panel,action,format,num,api,readFile}=h;
  const state=()=>h.state(), labels=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  let compare='locations', metricFilter='', planFilter='all', chartPlan='', chartPoint=0;
  const factor=m=>state().metrics[m]?.unit==='money'?100:1;
  const customOptions=()=>state().kpi_definitions.map(d=>[d.id,d.label]);
  const locOptions=()=>[['','Вся компания'],...state().locations.map(l=>[l.id,l.name])];
  const empOptions=()=>[['','Все сотрудники'],...state().employees.map(e=>[e.id,e.name])];
  const plans=()=>state().plans.filter(p=>(!metricFilter||p.metric===metricFilter)&&(planFilter==='all'||p.status===planFilter));
  const rule=p=>p.direction==='down'?'Не выше':p.direction==='range'?'Диапазон':'Не ниже';
  function planFields(p) {
    const o=p.options||{}, weekdays=o.weekdays||[1,1,1,1,1,1,1];
    return `<fieldset class="full kpi-calendar"><legend>Рабочий календарь и уведомления</legend><p class="small">Вес 0 — выходной, 1 — обычный день. Можно указать часы смены или повышенный вес загруженного дня. Темп считается на единицу веса.</p><div class="weekday-weights">${[1,2,3,4,5,6,0].map(i=>input('weekday_'+i,labels[i],weekdays[i],'number',true)).join('')}</div>${textarea('calendar_dates','Исключения и смены: дата = вес (по одному на строку)',Object.entries(o.dates||{}).map(([d,w])=>`${d} = ${w}`).join('\n'))}<p class="small">Например: 2026-12-31 = 0. Для индивидуальных смен задавайте план сотрудника и веса его рабочих дат.</p><div class="form-grid">${input('plan_source','Источник для плана (пусто — все)',o.source||'')}${input('tolerance','Допустимое отклонение, %',o.tolerance??0,'number',true)}${input('stale_hours','Предупреждать без обновлений через, часов',o.stale_hours??24,'number',true)}${input('upper','Верхняя граница (для диапазона)',o.upper===null||o.upper===undefined?'':o.upper/factor(p.metric),'number')}<label class="check-line"><input name="notify" type="checkbox" ${o.notify===false?'':'checked'}>Уведомления в кабинете</label></div></fieldset>`;
  }
  function planOptions(v,metric) {
    const dates={};
    for(const line of (v.calendar_dates||'').split('\n').filter(x=>x.trim())) {
      const match=line.trim().match(/^(\d{4}-\d{2}-\d{2})\s*=\s*(\d+(?:[.,]\d+)?)$/);
      if(!match) throw Error('Исключение календаря: укажите дату = вес.');
      if(Object.hasOwn(dates,match[1])) throw Error('Дата в календаре повторяется.');
      dates[match[1]]=Number(match[2].replace(',','.'));
    }
    return {source:v.plan_source||'',weekdays:labels.map((_,i)=>Number(v['weekday_'+i])),dates,tolerance:Number(v.tolerance),stale_hours:Number(v.stale_hours),upper:v.upper===''?null:Number(v.upper)*factor(metric),notify:v.notify==='on'};
  }
  function comparison() {
    const ps=plans(),metrics=[...new Set(ps.map(p=>p.metric))],groups=compare==='employees'?state().employees:state().locations;
    return `<div class="metric-tabs"><button class="${compare==='locations'?'active':''}" data-kpi-compare="locations">Точки</button><button class="${compare==='employees'?'active':''}" data-kpi-compare="employees">Сотрудники</button></div>`+table(['Объект',...metrics.map(m=>esc(state().metrics[m].label))],groups.map(g=>[esc(g.name),...metrics.map(m=>{
      const matches=ps.filter(p=>p.metric===m&&(compare==='employees'?p.employee_id===g.id:p.location_id===g.id&&!p.employee_id));
      return matches.length?matches.map(p=>`<div class="kpi-cell ${p.status}"><strong>${format(p.actual,m)}</strong><span>${rule(p)} ${format(p.target_to_date,m)}${p.direction==='range'?' — '+format(p.upper_to_date,m):''}</span><span>Отклонение ${format(p.deviation,m)}</span><span>${esc(p.start_on)} — ${esc(p.end_on)}</span>${p.category||p.product_id||compare==='employees'&&p.location_id?`<span>${esc(h.planName(p))}</span>`:''}</div>`).join(''):'<span class="small">План не задан</span>';
    })]));
  }
  function chart() {
    const ps=plans();if(!ps.length)return '';
    if(!ps.some(p=>p.id===chartPlan)) chartPlan=ps[0].id;
    const p=ps.find(p=>p.id===chartPlan),pts=p.timeline;
    if(!pts.length)return '<p class="small">Выберите показатель или нажмите «Обновить», чтобы загрузить график.</p>';
    chartPoint=Math.max(0,Math.min(chartPoint,pts.length-1));
    const width=Math.max(280,document.getElementById('content').clientWidth-60),height=230,left=75,right=width-20,top=22,bottom=190;
    const vals=pts.flatMap(d=>[d.actual,d.plan,...(p.direction==='range'?[d.upper]:[])]).filter(v=>v!==null);
    const lo=Math.min(0,...vals),hi=Math.max(...vals,1),x=i=>left+i/Math.max(1,pts.length-1)*(right-left),y=v=>bottom-(v-lo)/(hi-lo)*(bottom-top);
    const path=key=>{let segment=false;return pts.map((d,i)=>{if(d[key]===null){segment=false;return '';}const cmd=segment?'L':'M';segment=true;return `${cmd}${x(i)},${y(d[key])}`;}).join(' ');};
    const d=pts[chartPoint];
    return select('kpi_chart','Показатель и план',ps.map(p=>[p.id,`${state().metrics[p.metric].label} · ${h.planName(p)} · ${p.start_on} — ${p.end_on}`]),chartPlan)+`<svg class="kpi-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="График план и факт">${[0,.5,1].map(f=>{const v=lo+(hi-lo)*f;return `<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="#e7e9f1"/><text x="${left-8}" y="${y(v)+4}" text-anchor="end">${esc(format(v,p.metric))}</text>`;}).join('')}<path d="${path('plan')}" fill="none" stroke="#969cb0" stroke-width="2" stroke-dasharray="6 4"/>${p.direction==='range'?`<path d="${path('upper')}" fill="none" stroke="#969cb0" stroke-dasharray="6 4"/>`:''}<path d="${path('actual')}" fill="none" stroke="#665fe2" stroke-width="3"/>${pts.map((pt,i)=>`<circle cx="${x(i)}" cy="${pt.actual===null?y(pt.plan):y(pt.actual)}" r="${i===chartPoint?6:3}" fill="${pt.actual===null?'#969cb0':'#665fe2'}" data-kpi-point="${i}"/>`).join('')}<text x="${left}" y="220">${esc(p.start_on)}</text><text x="${right}" y="220" text-anchor="end">${esc(p.end_on)}</text></svg><label class="small">Выбрать дату<input type="range" name="kpi_point" min="0" max="${pts.length-1}" value="${chartPoint}"></label><div class="chart-readout"><strong>${esc(d.date)}</strong><span>Факт: ${format(d.actual,p.metric)} · Цель: ${format(d.plan,p.metric)}${p.direction==='range'?' — '+format(d.upper,p.metric):''}</span></div><p class="small">Сплошная линия — факт, пунктир — план. Длинные периоды показаны с укрупнением дат.</p>`;
  }
  function notifications() {
    const ns=state().notifications||[];
    return ns.length?ns.map(n=>{const p=state().plans.find(p=>p.id===n.plan_id);return `<div class="attention-item ${n.seen?'kpi-seen':''}"><h3>${esc(n.title)} · ${esc(state().metrics[n.metric].label)}</h3><p>${esc(h.planName(p))} · ${esc(n.detail)}</p>${n.seen?'<span class="small">Прочитано</span>':`<button class="inline-link" data-kpi-seen="${esc(n.id)}" ${h.demo()?'disabled':''}>Прочитано</button>`}</div>`;}).join(''):'<p class="small">Нет текущих уведомлений. Допуск и срок обновления настраиваются в каждом плане.</p>';
  }
  function render() {
    const ps=plans();
    return `<div class="notice">План к дате учитывает рабочий календарь. Для среднего чека, долей и снимков сравниваем уровень показателя с целью. Факт считается с начала каждого плана до выбранной даты.</div><div class="kpi-toolbar">${select('kpi_metric','Показатель',[['','Все показатели'],...Object.entries(state().metrics).map(([k,v])=>[k,v.label])],metricFilter)}${select('kpi_status','Состояние',[['all','Все планы'],['attention','Отклонение'],['good','По плану'],['unknown','Нет данных'],['pending','Ещё не начат']],planFilter)}<button class="secondary" data-kpi-refresh>Обновить</button></div>`+
      panel('Планы компании','Календарь, необходимый темп и прогноз',h.planRows(ps),`<div class="actions">${action('Добавить план','plan','plans')}${action('Копировать планы','kpiCopy','plans')}</div>`)+
      panel('План и факт','Выберите план, наведите на точку или используйте ползунок',chart())+
      panel('Сравнение KPI','Факт, цель к дате и отклонение. Периоды указаны в ячейках.',comparison())+
      panel('Уведомления','В кабинете проверяются при открытии и раз в минуту. На исторических датах уведомления не показываются.',notifications())+
      panel('Собственные показатели','Сумма за период, последнее значение или отношение двух величин',table(['Показатель','Расчёт','Источник',''],state().kpi_definitions.map(d=>[esc(d.label),esc({sum:'Сумма',latest:'Последнее значение',ratio:d.numerator_label+' / '+d.denominator_label+(d.unit==='percent'?' × 100%':'')}[d.aggregation]),esc(d.source||'Любой'),action('Изменить','kpiDefinition','structure',d.id)])),action('Добавить показатель','kpiDefinition','structure'))+
      panel('Фактические значения','Ручная форма, файл и API записывают данные в одни и те же показатели. Денежные значения в форме — рубли.',table(['Дата','Показатель','Точка / сотрудник','Значение','Источник',''],state().kpi_values.map(r=>[esc(r.date),esc(state().metrics[r.metric]?.label),esc([h.locName(r.location_id),h.empName(r.employee_id)].filter(Boolean).join(' · ')),r.value===null?`${num(r.numerator)} / ${num(r.denominator)}`:format(r.value,r.metric),esc(r.source),action('Изменить','kpiValue','plans',r.id)])),`<div class="actions">${action('Ввести факт','kpiValue','plans')}${action('Загрузить KPI','kpiFile','plans')}</div>`);
  }
  function form(kind,r={},id='') {
    if(kind==='kpiDefinition')return {title:id?'Изменить показатель':'Собственный показатель',fields:input('label','Название',r.label||'','text',true)+select('aggregation','Как считать',[['sum','Сумма за период'],['latest','Последнее значение (снимок)'],['ratio','Отношение: сумма числителя / сумма знаменателя']],r.aggregation||'sum')+select('unit','Единица',[['number','Число'],['money','Рубли'],['percent','Проценты']],r.unit||'number')+select('direction','Цель',[['up','Не ниже'],['down','Не выше'],['range','В диапазоне']],r.direction||'up')+input('source','Название источника (пусто — любой)',r.source||'')+input('numerator_label','Название числителя',r.numerator_label||'Занято часов')+input('denominator_label','Название знаменателя',r.denominator_label||'Доступно часов')+`<p class="small full">Для отношения в процентах: сумма числителей / сумма знаменателей × 100. Пустые данные и нулевой знаменатель не превращаются в ноль. Последнее значение допускает только одну серию (один источник, точка и сотрудник). ${id?'Единица, расчёт и правило существующего показателя неизменны.':''}</p>`};
    if(kind==='kpiValue')return {title:id?'Исправить факт KPI':'Ввести факт KPI',fields:select('metric','Показатель',customOptions(),r.metric||customOptions()[0]?.[0])+input('date','Дата',r.date||h.date(),'date',true)+select('location_id','Точка',locOptions(),r.location_id||'')+select('employee_id','Сотрудник',empOptions(),r.employee_id||'')+input('value','Значение (рубли для денежных KPI)',r.value===null?'':(r.value??0)/factor(r.metric),'number')+input('numerator','Числитель',r.numerator??'','number')+input('denominator','Знаменатель',r.denominator??'','number')+input('source','Источник',r.source||state().metrics[r.metric||customOptions()[0]?.[0]]?.source||'manual','text',true)+input('external_id','ID записи (необязательно)',r.external_id||'')+'<p class="small full">Для отношения заполните числитель и знаменатель. Для суммы или снимка — значение. Без ID форма исправляет запись за выбранную дату, точку и сотрудника.</p>'};
    if(kind==='kpiFile')return {title:'Загрузить факты KPI',fields:input('source','Источник','manual','text',true)+'<label class="full">Файл<input type="file" name="file" accept=".csv,.xlsx,.json" required></label><button type="button" class="secondary" data-kpi-template>Скачать шаблон CSV</button><p class="small full">CSV / Excel: заполните строки шаблона, названия столбцов сохраните. Для точки и сотрудника можно указать точное название или ID. JSON использует формат API. Денежные значения в файле — рубли, в JSON API — копейки.</p>'};
    if(kind==='kpiCopy')return {title:'Копировать и назначить планы',fields:`<fieldset class="full"><legend>Исходные планы</legend>${state().plans.map(p=>`<label class="check-line"><input name="copy_ids" type="checkbox" value="${esc(p.id)}">${esc(state().metrics[p.metric].label)} · ${esc(h.planName(p))} · ${esc(p.start_on)} — ${esc(p.end_on)}</label>`).join('')}</fieldset>`+input('start_on','Новый период: начало',h.from(),'date',true)+input('end_on','Окончание',h.to(),'date',true)+`<fieldset class="full"><legend>Назначить точкам (пусто — сохранить исходные)</legend>${state().locations.map(l=>`<label class="check-line"><input name="copy_locations" type="checkbox" value="${esc(l.id)}">${esc(l.name)}</label>`).join('')}</fieldset><p class="small full">Создаются новые планы с той же целью и правилами. Исключения календаря сдвигаются вместе с началом периода; проверьте праздничные даты. Исходные планы сохраняются.</p>`};
    return null;
  }
  const toNumber=x=>{if(x===undefined||x===null||String(x).trim()==='')throw Error('Заполните числовые поля.');const n=Number(String(x).replace(/\s/g,'').replace(',','.'));if(!Number.isFinite(n))throw Error('Некорректное число.');return n;};
  async function submit(kind,v,fd,id) {
    if(kind==='kpiDefinition') return api('/api/kpi-definitions',{...v,id:id||undefined});
    if(kind==='kpiCopy') return api('/api/plans/copy',{ids:fd.getAll('copy_ids'),location_ids:fd.getAll('copy_locations'),start_on:v.start_on,end_on:v.end_on});
    if(kind==='kpiValue') {
      const def=state().metrics[v.metric];if(!def)throw Error('Сначала создайте собственный показатель.');
      return api('/api/kpi-values',{source:v.source,rows:[{metric:v.metric,date:v.date,location_id:v.location_id,employee_id:v.employee_id,external_id:v.external_id||`manual:${v.metric}:${v.date}:${v.location_id}:${v.employee_id}`, ...(def.aggregation==='ratio'?{numerator:toNumber(v.numerator),denominator:toNumber(v.denominator)}:{value:toNumber(v.value)*factor(v.metric)})}]});
    }
    if(kind==='kpiFile') {
      const file=fd.get('file');
      if(/\.json$/i.test(file.name))return api('/api/kpi-values',JSON.parse(await file.text()));
      const wb=await readFile(file);if(wb.sheets.length!==1)throw Error('Оставьте в файле один лист с фактами KPI.');
      const matrix=wb.sheets[0].rows,header=matrix[0].map(x=>String(x).trim());
      const resolve=(type,key)=>{if(!key)return '';const matches=state()[type].filter(r=>r.id===key||r.name===key||r.label===key);if(matches.length!==1)throw Error('Не найден или неоднозначен объект: '+key);return matches[0].id;};
      const rows=matrix.slice(1).filter(row=>row.some(x=>x!==''&&x!==null)).map((row,i)=>{
        const r=Object.fromEntries(header.map((k,j)=>[k,row[j]])),metric=resolve('kpi_definitions',String(r.metric||'')),def=state().metrics[metric];
        if(!def)throw Error('Укажите собственный KPI в строке '+(i+2));
        const date=String(r.date||'').trim(),location=resolve('locations',String(r.location_id||'').trim()),employee=resolve('employees',String(r.employee_id||'').trim());
        return {metric,date,location_id:location,employee_id:employee,external_id:String(r.external_id||`file:${metric}:${date}:${location}:${employee}`),...(def.aggregation==='ratio'?{numerator:toNumber(r.numerator),denominator:toNumber(r.denominator)}:{value:toNumber(r.value)*factor(metric)})};
      });
      return api('/api/kpi-values',{source:v.source,rows});
    }
    return null;
  }
  function template() {
    const metric=state().kpi_definitions[0];
    const csv='\ufeffmetric;date;location_id;employee_id;external_id;value;numerator;denominator\r\n'+[metric?.id||'',h.date(),state().locations[0]?.id||'','','example-1',metric?.aggregation==='ratio'?'':'0',metric?.aggregation==='ratio'?'30':'',metric?.aggregation==='ratio'?'40':''].join(';')+'\r\n';
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='business-pulse-kpi.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function click(b) {
    if(b.hasAttribute('data-kpi-template')){template();return true;}
    if(b.dataset.kpiCompare){compare=b.dataset.kpiCompare;h.render();return true;}
    if(b.hasAttribute('data-kpi-refresh')){await h.load();return true;}
    if(b.dataset.kpiSeen){await api('/api/notifications/seen',{id:b.dataset.kpiSeen});await h.load();return true;}
    if(b.dataset.kpiHistory){
      if(h.demo())return true;
      const rows=await api('/api/plans/history?id='+encodeURIComponent(b.dataset.kpiHistory));
      h.history(rows.map(r=>`<div class="attention-item"><h3>${esc(new Date(r.changed_at).toLocaleString('ru-RU'))} · версия ${r.after.version}</h3><p>Цель: ${format(r.after.target,r.after.metric)} · ${esc(r.after.start_on)} — ${esc(r.after.end_on)}</p><p class="small">До изменения: ${r.before?format(r.before.target,r.before.metric):r.before_hidden?'За пределами доступа':'Новый план'}. Календарь: ${(r.after.options?.weekdays||[1,1,1,1,1,1,1]).map((w,i)=>labels[i]+': '+num(w)).join(' · ')}. Допуск: ${num(r.after.options?.tolerance||0)}%.</p></div>`).join(''));
      return true;
    }
    return false;
  }
  function change(e){
    const n=e.target.name;
    if(n==='kpi_chart')chartPlan=e.target.value;
    else if(n==='kpi_point')chartPoint=Number(e.target.value);
    else if(n==='kpi_metric')metricFilter=e.target.value;
    else if(n==='kpi_status')planFilter=e.target.value;
    else return false;
    if(n!=='kpi_point') {const ps=plans();if(!ps.some(p=>p.id===chartPlan))chartPlan=ps[0]?.id||'';h.load().catch(h.error);return true;}
    h.render();
    if(n==='kpi_point')document.querySelector('[name="kpi_point"]')?.focus({preventScroll:true});
    return true;
  }
  function mount(){
    document.querySelectorAll('[data-kpi-point]').forEach(el=>el.addEventListener('pointerenter',()=>{const index=Number(el.dataset.kpiPoint);if(index!==chartPoint){chartPoint=index;h.render();}}));
  }
  function editor(kind) {
    const form=document.getElementById('editor');
    const metric=form.elements.metric?.value;
    const def=state().metrics[metric];
    const show=(name,visible)=>{const el=form.elements[name];if(el){el.closest('label').hidden=!visible;el.disabled=!visible;}};
    if(kind==='plan') {
      show('upper',def?.direction==='range');
      show('product_id',!def?.aggregation);show('category',!def?.aggregation);
      if(def?.aggregation){form.elements.product_id.value='';form.elements.category.value='';}
    }
    if(kind==='kpiValue') {
      const ratio=def?.aggregation==='ratio';
      show('value',!ratio);show('numerator',ratio);show('denominator',ratio);
      for(const name of ['numerator','denominator']) {
        const el=form.elements[name];if(el)el.closest('label').firstChild.textContent=def?.[name+'_label']||name;
      }
    }
  }
  return {chartId:()=>chartPlan,editor,render,planFields,planOptions,form,submit,click,change,mount,notifications};
}
