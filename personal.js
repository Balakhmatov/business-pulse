'use strict';
(function(){
  // Personal workspace is opt-in through verified Telegram Mini App initData.
  // The three synthetic demo companies remain entirely local and unchanged.
  const demo=window.BP_Demo;
  const tg=window.Telegram&&window.Telegram.WebApp;
  if(!demo||!tg||!tg.initData)return;
  const {state,parseImported,mapping,showModal,chart,insightHTML,escapeHTML,svgIcon,money,number,verboseDate,dateLabel,dateShift,yesterday}=demo;
  const $=id=>document.getElementById(id);
  const URL_ROOT='https://pulse.cityai.site/api';

  const style=document.createElement('style');
  style.textContent='@media(max-width:680px){.in-telegram .company-switch{grid-template-columns:repeat(2,minmax(0,1fr))}} #quickDemoImport[hidden]{display:none!important}';
  document.head.appendChild(style);
  const tab=document.createElement('button');
  tab.type='button';
  tab.className='company-tab';
  tab.dataset.business='mine';
  tab.innerHTML='<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="#i-wallet"/></svg> Моя компания';
  const bar=document.querySelector('.company-switch');
  bar.insertBefore(tab,bar.firstChild);
  bar.setAttribute('aria-label','Выбор компании');


  // A reliable sample link, with headers Telegram's native downloader expects.
  const originalSampleDownload=$('downloadSample').onclick;
  $('downloadSample').onclick=()=>{
    const type=['store','cafe'].includes(state.business)?state.business:'clinic';
    const filename='business_pulse_sample_'+type+'.csv';
    const fileURL=URL_ROOT+'/sample.csv?type='+type;
    try{
      if(typeof tg.downloadFile==='function' && typeof tg.isVersionAtLeast==='function' && tg.isVersionAtLeast('8.0')){
        tg.downloadFile({url:fileURL,file_name:filename},accepted=>{
          if(!accepted)console.info('Download declined or not supported by Telegram client.');
        });
        return;
      }
      if(typeof tg.openLink==='function'){tg.openLink(fileURL);return;}
    }catch(e){console.warn('Telegram download unavailable, opening sample link:',e);}
    try{window.open(fileURL,'_blank','noopener,noreferrer')}catch{originalSampleDownload();}
  };

  // No file download is needed to test saving KPI data.
  // This action is offered only for an empty personal workspace.
  const quick=document.createElement('button');
  quick.type='button';
  quick.id='quickDemoImport';
  quick.className='ghost-btn';
  quick.textContent='Загрузить тестовые данные';
  quick.hidden=true;
  $('bottomImport').parentElement.insertBefore(quick,$('bottomImport'));
  function updateQuickButton(){
    quick.hidden=state.business!=='mine'||!!state.mineReport?.source;
    quick.disabled=!!(state.mineLoading||state.mineSaving||state.mineQuickSaving);
  }
  function sampleRows(){
    const end=yesterday;
    const goods=[['Консультация терапевта',2800],['УЗИ',3500],['Анализы',1500],['Профилактический чек-ап',6200],['Консультация невролога',3200]];
    const rows=[];
    for(let day=59;day>=0;day--){
      const date=dateShift(end,-day);
      for(let i=0;i<7;i++){
        const [item,price]=goods[(day*7+i*3)%goods.length];
        const amount=Math.max(1,price+((day*17+i*31)%9-4)*30);
        rows.push({date,id:'DEMO-'+day+'-'+i,item,amount_kopecks:amount*100,status:'sale'});
      }
      if(day%12===0)rows.push({date,id:'REF-'+day,item:goods[0][0],amount_kopecks:-goods[0][1]*100,status:'refund'});
    }
    return rows;
  }
  quick.onclick=async()=>{
    if(state.business!=='mine'||state.mineReport?.source||state.mineQuickSaving)return;
    state.mineQuickSaving=true;
    state.mineError='';
    quick.disabled=true;
    quick.textContent='Загружаем…';
    try{
      const answer=await request('/import',{source:'Синтетический тестовый отчёт',rows:sampleRows()});
      state.mineReport=answer.report;
      state.mineAI=null;
      renderMine();
      void loadAI();
    }catch(e){
      state.mineError=e.message||'Не удалось загрузить тестовый отчёт.';
      renderMine();
    }finally{
      state.mineQuickSaving=false;
      quick.textContent='Загрузить тестовые данные';
      updateQuickButton();
    }
  };

  // Cached OpenAI analysis. The browser never accesses OpenAI or any API key.
  state.mineAI=null;
  let analysisSeq=0;
  async function loadAI(){
    if(!state.mineReport?.source)return;
    const current=++analysisSeq;
    state.mineAI={status:'pending'};
    if(state.business==='mine')renderMine();
    for(let attempt=0;attempt<18;attempt++){
      try{
        const result=await request('/analysis');
        if(current!==analysisSeq)return;
        state.mineAI=result;
        if(state.business==='mine')renderMine();
        if(result.status!=='pending')return;
      }catch(error){
        if(current!==analysisSeq)return;
        console.warn('AI analysis unavailable:',error.message);
        state.mineAI={status:'error'};
        if(state.business==='mine')renderMine();
        return;
      }
      await new Promise(resolve=>setTimeout(resolve,2500));
    }
    // Long-running analysis will be loaded on the next Mini App opening.
    if(current===analysisSeq){
      state.mineAI={status:'pending'};
      if(state.business==='mine')renderMine();
    }
  }
  function fmtK(x){return Number.isFinite(x)?money(x/100):'—'}
  async function request(route,body){
    const response=await fetch(URL_ROOT+route,{
      method:body?'POST':'GET',
      headers:{'X-Telegram-Init-Data':tg.initData,...(body?{'Content-Type':'application/json'}:{})},
      body:body?JSON.stringify(body):undefined,
      cache:'no-store'
    });
    let result;
    try{result=await response.json()}catch{throw Error('Сервер вернул некорректный ответ.')}
    if(!response.ok)throw Error(response.status===401?'Авторизация Telegram устарела. Закройте и снова откройте Mini App.':result.error||'Ошибка сервера '+response.status);
    return result;
  }
  function activeTab(){
    document.querySelectorAll('.company-tab').forEach(button=>{
      const active=button.dataset.business===state.business;
      button.classList.toggle('active',active);
      button.setAttribute('aria-pressed',String(active));
    });
  }
  function renderMine(){
    const r=state.mineReport||null;
    const imported=!!(r&&r.source), loading=!!state.mineLoading;
    const end=r&&r.as_of?r.as_of:yesterday;
    const chartData=r&&Array.isArray(r.chart7)&&r.chart7.length===7?r.chart7:null;
    const dates=chartData?chartData.map(x=>x.date):Array.from({length:7},(_,i)=>dateShift(end,-6+i));
    const values=chartData?chartData.map(x=>x.amount_kopecks/100):Array(7).fill(0);
    const change=imported?r.change_percent:null;
    $('businessDesc').textContent='Ваши показатели · сохранены в отдельной базе компании';
    $('companyName').textContent=r&&r.company?r.company.name:'Моя компания';
    $('asOf').textContent='По '+verboseDate(end)+' включительно (МСК)';
    $('rowsInfo').textContent=imported?'Загружено '+number(r.source.rows)+' строк':(loading?'Загружаем данные…':'Нет загруженных отчётов');
    $('dataBadge').textContent=imported?'Ваши данные':'Личная панель';
    $('dataBadge').style.cssText='color:#6252a4;background:#f1edff;border-color:#e5dfff';
    $('revenue30').textContent=imported?fmtK(r.revenue30_kopecks):'—';
    $('revenueChange').textContent=change===null?'Нет данных для сравнения':(change>0?'+':'')+String(change).replace('.',',')+'% к предыдущему периоду';
    $('revenueChange').classList.toggle('down',change!==null&&change<0);
    $('comparisonDesc').textContent='Последние 30 полных дней с учётом возвратов';
    $('revenueYesterday').textContent=imported?fmtK(r.yesterday_kopecks):'—';
    $('yesterdayDate').textContent=verboseDate(end);
    $('countLabel').textContent='Чеков / операций за 30 дней';
    $('salesCount').textContent=imported?number(r.receipt_count):'—';
    $('salesCaption').textContent='Уникальные ID из CSV (без ID — по строкам)';
    $('averageLabel').textContent='Средняя сумма чека';
    $('averageTicket').textContent=imported&&r.average_receipt_kopecks!==null?fmtK(r.average_receipt_kopecks):'—';
    $('averageCaption').textContent='Выручка / количество чеков';
    $('specialLabel').textContent='Дополнительные показатели';
    $('specialIcon').innerHTML=svgIcon('alert');
    $('specialValue').textContent='—';
    $('specialCaption').textContent='Зависят от состава отчёта';
    $('topTitle').textContent='Топ-3 позиции';
    const top=imported?(r.top3||[]).filter(x=>x.amount_kopecks>0):[];
    const highest=top.length?top[0].amount_kopecks:1;
    $('topItems').innerHTML=top.length?top.map((x,i)=>'<div><div class="top-row-head"><strong title="'+escapeHTML(x.item)+'">'+(i+1)+'. '+escapeHTML(x.item)+'</strong><span>'+fmtK(x.amount_kopecks)+'</span></div><div class="progress-track"><div class="progress-fill" style="width:'+Math.max(0,x.amount_kopecks/highest*100).toFixed(1)+'%;opacity:'+(1-i*.14)+'"></div></div></div>').join(''):'<p class="small-muted">Позиции появятся после загрузки CSV.</p>';
    chart(values,dates);
    $('chartCaption').textContent='Суммы за дни по сохранённым операциям с учётом возвратов';
    const bad=[],good=[];
    if(imported&&change!==null&&change<0)bad.push({title:'Выручка снизилась',desc:'Изменение к прошлым 30 дням: '+String(change).replace('.',',')+'%. Проверьте полноту выгрузки.'});
    if(imported&&change!==null&&change>0)good.push({title:'Выручка выросла',desc:'Рост к предыдущим 30 дням: +'+String(change).replace('.',',')+'%.'});
    if(imported&&top.length)good.push({title:'Лидер по выручке — '+top[0].item,desc:'За 30 дней: '+fmtK(top[0].amount_kopecks)+'.'});
    if(imported)bad.push({title:'Проверьте полноту отчёта',desc:'Дни без операций считаются нулевыми. Пропуски могут исказить сравнение периодов.'});
    if(!bad.length)bad.push({title:'Начните с загрузки отчёта',desc:'Выберите CSV с датой, суммой и названиями товаров или услуг.'});
    if(!good.length)good.push({title:'Показатели появятся здесь',desc:'После загрузки CSV увидите результаты и изменения.'});
    const ai=state.mineAI;
    const ready=imported&&ai?.status==='ready'&&ai.analysis;
    if(ready){
      const asItem=x=>({
        title:x.title,
        desc:[x.explanation,...(x.evidence||[]),'Что проверить: '+x.recommendation].join(' ')
      });
      bad.splice(0,bad.length,...ai.analysis.issues.map(asItem));
      good.splice(0,good.length,...ai.analysis.positives.map(asItem));
      if(!good.length)good.push({title:'Пока нет подтверждённых позитивных сигналов',desc:'ИИ не обнаружил достаточно оснований для отдельного позитивного вывода.'});
    }
    for(const [id] of [['concerns'],['positives']]){
      const chip=$(id).closest('.panel')?.querySelector('.subtle-chip');
      if(chip)chip.textContent=ready?'ИИ-анализ':imported&&ai?.status==='pending'?'ИИ готовит выводы':'По правилам';
    }
    $('concerns').innerHTML=insightHTML(bad.slice(0,3),true);
    $('positives').innerHTML=insightHTML(good.slice(0,2),false);
    $('warningBanner').classList.toggle('show',!!state.mineError);
    $('warningBanner').textContent=state.mineError||'';
    $('bottomDataTitle').textContent=imported?'Показатели рассчитаны по сохранённому CSV.':(loading?'Получаем показатели…':'Загрузите первый отчёт вашей компании.');
    $('bottomDataHint').textContent=imported?'Источник: '+r.source.name+'. Новый импорт заменит ранее загруженные операции.':'Для проверки используйте обезличенный тестовый CSV. Данные сохраняются на сервере.';
    if(imported){
      const message=ready?' Выводы сформированы OpenAI и сохранены.':ai?.status==='pending'?' OpenAI анализирует обновлённые показатели…':ai?.status==='disabled'?' ИИ-анализ ещё не подключён: показаны выводы по правилам.':ai?.status==='error'?' ИИ-анализ временно недоступен: показаны выводы по правилам.':'';
      $('bottomDataHint').textContent+=message;
    }
    $('clearImport').hidden=true;
    document.querySelector('.side-foot').textContent='Прототип · Личные данные компании';
    document.querySelector('.foot').textContent='Бизнес Пульс · Личная панель · Проверяйте полноту и корректность выгрузки';
    activeTab();
    updateQuickButton();
  }
  async function loadMine(){
    state.mineLoading=true;
    state.mineError='';
    if(state.business==='mine')renderMine();
    try{
      state.mineReport=await request('/report');
    }catch(error){state.mineError=error.message||'Не удалось получить данные.';}
    finally{state.mineLoading=false;if(state.business==='mine')renderMine();if(state.mineReport?.source)void loadAI();}
  }

  tab.onclick=()=>{
    state.business='mine';
    renderMine();
    if(!state.mineReport)loadMine();
  };
  // Existing demo tab handlers are installed by index.html before this module.
  document.querySelectorAll('.company-tab:not([data-business="mine"])').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelector('.side-foot').textContent='Прототип · Данные демонстрационные';
      document.querySelector('.foot').textContent='Бизнес Пульс · Демонстрационный прототип · Не использовать синтетические показатели для бизнес-решений';
      updateQuickButton();
    });
  });

  const intro=document.querySelector('.modal-intro');
  const localIntro=intro.textContent;
  function refreshIntro(){
    intro.textContent=state.business==='mine'
      ?'Отчёт будет сохранён на защищённом сервере и заменит предыдущий набор данных. Для теста используйте обезличенный CSV: не загружайте сведения о пациентах и клиентах.'
      :'Файл обрабатывается только в браузере, на сервер не отправляется. Все данные демокомпаний остаются локальными.';
  }
  ['openImport','bottomImport','sideImport'].forEach(id=>$(id).addEventListener('click',refreshIntro));
  const originalConfirm=$('confirmImport').onclick;
  $('confirmImport').onclick=async()=>{
    if(state.business!=='mine'){intro.textContent=localIntro;return originalConfirm();}
    if(state.mineSaving)return;
    try{
      const result=parseImported(state.fileTable,mapping());
      if(result.rows.length>10000)throw Error('Сервер принимает до 10 000 операций за одну загрузку.');
      const rows=result.rows.map(x=>({
        date:x.date,id:String(x.id),item:String(x.item),
        amount_kopecks:Math.round(x.amount*100),status:x.status
      }));
      if(rows.some(x=>!Number.isSafeInteger(x.amount_kopecks)||x.amount_kopecks===0||Math.abs(x.amount_kopecks)>1e12))throw Error('Некорректные суммы: проверьте нулевые и слишком большие значения.');
      state.mineSaving=true;
      $('confirmImport').disabled=true;
      $('importAlert').textContent='Сохраняем отчёт на сервере…';
      const answer=await request('/import',{source:state.fileTable.name.slice(0,120),rows});
      state.mineReport=answer.report;
      state.mineAI=null;
      state.mineError='';
      showModal(false);
      renderMine();
      void loadAI();
    }catch(error){$('importAlert').textContent=error.message||'Не удалось сохранить CSV.';}
    finally{state.mineSaving=false;if($('modal').classList.contains('show'))$('confirmImport').disabled=false;}
  };

  // Preserve explicitly requested demo launch parameters.
  const start=tg.initDataUnsafe&&tg.initDataUnsafe.start_param;
  if(!['clinic','store','cafe'].includes(start)){
    state.business='mine';
    renderMine();
  }
  loadMine();
})();