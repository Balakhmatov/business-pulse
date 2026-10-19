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
  $('importUtilities').appendChild(quick);
  const retryLoad=document.createElement('button');
  retryLoad.type='button';
  retryLoad.className='ghost-btn';
  retryLoad.textContent='Повторить загрузку';
  retryLoad.hidden=true;
  $('importUtilities').appendChild(retryLoad);
  retryLoad.onclick=()=>{ if(!state.mineLoading)void loadMine(); };

  const clearTests=document.createElement('button');
  clearTests.type='button';
  clearTests.id='clearTestData';
  clearTests.className='ghost-btn';
  clearTests.textContent='Очистить тестовые данные';
  clearTests.hidden=true;
  $('importUtilities').appendChild(clearTests);

  // Owner-only import journal. Filenames are always rendered via textContent.
  const importHistoryButton=document.createElement('button');
  importHistoryButton.type='button';
  importHistoryButton.className='ghost-btn';
  importHistoryButton.textContent='История загрузок';
  importHistoryButton.hidden=true;
  $('importUtilities').appendChild(importHistoryButton);
  const importHistoryPanel=document.createElement('section');
  importHistoryPanel.hidden=true;
  importHistoryPanel.style.cssText='background:white;border:1px solid #e0e4ed;border-radius:15px;padding:15px;margin-bottom:18px';
  $('importUtilities').after(importHistoryPanel);
  function historyText(container,text,bold=false){
    const node=document.createElement('div');
    node.textContent=String(text);
    node.style.cssText='font-size:12px;line-height:1.55;color:#525e76;margin:6px 0'+(bold?';font-weight:750':'');
    container.appendChild(node);
  }
  async function refreshImportHistory(){
    if(importHistoryPanel.hidden||state.business!=='mine')return;
    importHistoryPanel.replaceChildren();
    historyText(importHistoryPanel,'Загружаем историю…');
    try{
      const response=await request('/import/history');
      if(importHistoryPanel.hidden||state.business!=='mine')return;
      importHistoryPanel.replaceChildren();
      historyText(importHistoryPanel,'Последние загрузки',true);
      const entries=response.history||[];
      if(!entries.length)historyText(importHistoryPanel,'Загрузок пока нет.');
      for(const entry of entries){
        const block=document.createElement('div');
        block.style.cssText='padding-top:10px;margin-top:8px;border-top:1px solid #ebeef5';
        historyText(block,String(entry.source||'Отчёт')+' · '+
          (financialTitles[entry.financial_basis]||financialTitles.unverified)+
          (entry.undone?' · отменён':''),true);
        historyText(block,'Новых: '+entry.added+' · исправлено: '+entry.updated+
          (entry.deleted?' · отменено: '+entry.deleted:'')+' · без изменений: '+entry.unchanged);
        if(entry.can_undo){
          const undo=document.createElement('button');
          undo.type='button';
          undo.className='ghost-btn';
          undo.textContent='Отменить загрузку';
          undo.onclick=async()=>{
            const ask='Отменить последнюю загрузку? Новые операции будут удалены, а исправленные суммы восстановлены.';
            const approved=await new Promise(resolve=>{
              if(typeof tg.showConfirm==='function')tg.showConfirm(ask,resolve);
              else resolve(window.confirm(ask));
            });
            if(!approved)return;
            undo.disabled=true;
            try{
              const result=await request('/import/undo',{batch_id:entry.id});
              ++analysisSeq;
              state.mineReport=result.report;
              state.mineAI=null;
              state.mineImportStats=null;
              state.mineTemplateNotice='';
              renderMine();
              void loadAI();
              await refreshImportHistory();
            }catch(error){
              undo.disabled=false;
              historyText(block,error.message||'Ошибка отмены.');
            }
          };
          block.appendChild(undo);
        }
        importHistoryPanel.appendChild(block);
      }
    }catch(error){
      importHistoryPanel.replaceChildren();
      historyText(importHistoryPanel,error.message||'История временно недоступна.');
    }
  }
  importHistoryButton.onclick=()=>{
    if(state.business!=='mine')return;
    importHistoryPanel.hidden=!importHistoryPanel.hidden;
    importHistoryButton.textContent=importHistoryPanel.hidden?'История загрузок':'Скрыть историю';
    if(!importHistoryPanel.hidden)void refreshImportHistory();
  };
  function updateQuickButton(){
    const busy=!!(state.mineLoading||state.mineSaving||state.mineQuickSaving||state.mineClearing);
    quick.hidden=state.business!=='mine'||!!state.mineReport?.source||!!state.mineError;
    quick.disabled=busy;
    importHistoryButton.hidden=state.business!=='mine';
    if(state.business!=='mine'){importHistoryPanel.hidden=true;importHistoryButton.textContent='История загрузок';}
    retryLoad.hidden=state.business!=='mine'||!state.mineError;
    retryLoad.disabled=busy;
    const src=state.mineReport?.source;
    clearTests.hidden=state.business!=='mine'||!src||!src.rows||
      !/синтетич|тестов|demo|sample|пример/i.test(src.name);
    clearTests.disabled=busy;
  }
  clearTests.onclick=async()=>{
    if(clearTests.hidden||state.mineClearing||state.mineSaving)return;
    const prompt='Удалить все синтетические операции из «Моя компания»? Данные других компаний не затрагиваются. Это действие нельзя отменить.';
    const confirmed=await new Promise(resolve=>{
      if(typeof tg.showConfirm==='function')tg.showConfirm(prompt,resolve);
      else resolve(window.confirm(prompt));
    });
    if(!confirmed)return;
    state.mineClearing=true;
    state.mineError='';
    clearTests.textContent='Удаляем…';
    updateQuickButton();
    try{
      const result=await request('/reset-test-data',{confirm:'DELETE_TEST_DATA'});
      ++analysisSeq; // cancel any stale pending analysis responses
      state.mineReport=result.report;
      state.mineAI=null;
      state.mineImportStats=null;
      renderMine();
      if(typeof tg.showAlert==='function')tg.showAlert('Удалено тестовых операций: '+result.removed+'. Теперь можно загрузить чистый набор.');
    }catch(error){
      state.mineError=error.message||'Не удалось очистить тестовые данные.';
      renderMine();
    }finally{
      state.mineClearing=false;
      clearTests.textContent='Очистить тестовые данные';
      updateQuickButton();
    }
  };
  function sampleRows(){
    const end=yesterday;
    const goods=[['Консультация терапевта',2800],['УЗИ',3500],['Анализы',1500],['Профилактический чек-ап',6200],['Консультация невролога',3200]];
    const rows=[];
    for(let day=59;day>=0;day--){
      const date=dateShift(end,-day);
      const dayNumber=Math.floor(Date.parse(date+'T00:00:00Z')/86400000);
      for(let i=0;i<7;i++){
        const [item,price]=goods[((dayNumber*7+i*3)%goods.length+goods.length)%goods.length];
        const amount=Math.max(1,price+((((dayNumber*17+i*31)%9+9)%9)-4)*30);
        rows.push({date,id:'DEMO-'+date+'-'+i,item,amount_kopecks:amount*100,status:'sale'});
      }
      if(dayNumber%12===0)rows.push({date,id:'REF-'+date,item:goods[0][0],amount_kopecks:-goods[0][1]*100,status:'refund'});
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
      state.mineImportStats=answer.stats||null;
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
    // VPS may briefly restart the API after a new commit. Retry READS only.
    // Never retry POST: repeating financial imports or deletion is unsafe.
    const tries=body?1:4;
    let response;
    for(let attempt=0;attempt<tries;attempt++){
      try{
        response=await fetch(URL_ROOT+route,{
          method:body?'POST':'GET',
          headers:{'X-Telegram-Init-Data':tg.initData,...(body?{'Content-Type':'application/json'}:{})},
          body:body?JSON.stringify(body):undefined,
          cache:'no-store'
        });
        break;
      }catch(error){
        if(attempt===tries-1){
          throw Error('Не удалось связаться с сервером Бизнес Пульс. Проверьте соединение и повторите попытку.');
        }
        await new Promise(resolve=>setTimeout(resolve,800*(attempt+1)));
      }
    }
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
  const industryMoneyLabels={
    clinic:{paid:'Оплачено пациентами',done:'Оказано услуг на сумму'},
    store:{paid:'Оплачено покупателями',done:'Продано товаров на сумму'},
    auto:{paid:'Оплачено клиентами',done:'Выполнено работ на сумму'},
    cafe:{paid:'Оплачено гостями',done:'Продано на сумму'},
    other:{paid:'Получено от клиентов',done:'Выполнено на сумму'}
  };
  const industryFor=report=>industryMoneyLabels[report?.company?.industry]||industryMoneyLabels.other;
  const financialTitles={
    cash_receipts:'Поступления',
    recognized_revenue:'Продажи',
    unverified:'Суммы без уточнения'
  };
  function renderFinanceBooks(report){
    const holder=$('financeBooks');
    const review=$('unverifiedReview');
    if(state.business!=='mine'||!report?.financial_books){
      holder.hidden=true;review.hidden=true;
      $('debtInfo').hidden=true;
      return;
    }
    holder.hidden=false;
    const copy=industryFor(report);
    const labels=[
      ['cash_receipts',copy.paid,'Фактически полученные деньги, включая авансы'],
      ['recognized_revenue',copy.done,'Стоимость уже оказанных услуг, работ или переданных товаров']
    ];
    holder.innerHTML=labels.map(([basis,name,hint])=>{
      const book=report.financial_books[basis]||{};
      const selected=report.primary_basis===basis;
      return '<button type="button" class="finance-book" data-financial-basis="'+basis+
        '" aria-pressed="'+selected+'" '+(book.available?'':'disabled')+'>'+
        '<div class="finance-book-name">'+name+'</div>'+
        '<div class="finance-book-amount">'+(book.available?fmtK(book.amount30_kopecks):'Нет данных')+'</div>'+
        '<div class="finance-book-hint">'+hint+'</div></button>';
    }).join('');
    holder.querySelectorAll('button:not(:disabled)').forEach(button=>{
      button.onclick=()=>{
        const basis=button.dataset.financialBasis;
        if(basis===state.mineReport?.primary_basis)return;
        state.mineViewBasis=basis;
        void loadMine();
      };
    });
    const unknown=report.financial_books.unverified;
    review.hidden=!unknown?.available;
    if(unknown?.available){
      review.innerHTML='<details><summary>Нужно уточнить данные · '+fmtK(unknown.amount30_kopecks)+'</summary>'+
        '<div>По старым отчётам пока неизвестно, что означают суммы. '+
        'Они не добавляются ни к оплатам, ни к выполненным продажам.</div></details>';
    }
    const debt=$('debtInfo');
    debt.hidden=!report.unpaid_customer_debt_available;
    if(report.unpaid_customer_debt_available&&Number.isFinite(report.unpaid_customer_debt_kopecks)){
      debt.innerHTML='<strong>Не оплачено клиентами: '+fmtK(report.unpaid_customer_debt_kopecks)+'</strong>'+
        '<div>По подтверждённым данным о конкретных заказах и их оплате.</div>';
    }else{
      debt.innerHTML='<strong>Не оплачено клиентами: нет данных для расчёта</strong>'+
        '<div>Чтобы показать задолженность, нужны сведения об оплатах и выполненных заказах с общей связью. '+
        'Разница между общей суммой оплат и продаж не равна долгу.</div>';
    }
  }
  function renderMine(){
    const r=state.mineReport||null;
    const imported=!!(r&&r.source), loading=!!state.mineLoading;
    const end=r&&r.as_of?r.as_of:yesterday;
    const chartData=r?.primary_basis!=='unverified'&&r&&Array.isArray(r.chart7)&&r.chart7.length===7?r.chart7:null;
    const dates=chartData?chartData.map(x=>x.date):Array.from({length:7},(_,i)=>dateShift(end,-6+i));
    const values=chartData?chartData.map(x=>x.amount_kopecks/100):Array(7).fill(0);
    const change=imported&&r.primary_basis!=='unverified'?r.change_percent:null;
    $('businessDesc').textContent='Ваши показатели · полученные оплаты и выполненная работа';
    renderFinanceBooks(r);
    const financialLabel=financialTitles[r?.primary_basis]||financialTitles.unverified;
    const shortMetric=r?.primary_basis==='cash_receipts'?'Поступления':
      r?.primary_basis==='recognized_revenue'?'Продажи':'Суммы';
    const moneyLabels=industryFor(r);
    const metricTitle=r?.primary_basis==='cash_receipts'?moneyLabels.paid:
      r?.primary_basis==='recognized_revenue'?moneyLabels.done:'Данные требуют уточнения';
    const verified=r?.primary_basis==='cash_receipts'||r?.primary_basis==='recognized_revenue';
    document.querySelector('.revenue-panel .kpi-name').textContent=metricTitle+' за 30 дней';
    $('revenueChart').closest('.panel').querySelector('.section-title').textContent='Динамика: '+shortMetric.toLowerCase();
    $('revenueChart').closest('.panel').querySelector('.subtle-chip').textContent=shortMetric+' по дням';
    $('companyName').textContent=r&&r.company?r.company.name:'Моя компания';
    $('asOf').textContent='По '+verboseDate(end)+' включительно (МСК)';
    $('rowsInfo').textContent=imported?'В базе '+number(r.source.rows)+' операций':(loading?'Загружаем данные…':state.mineError?'Данные временно недоступны':'Нет загруженных отчётов');
    $('dataBadge').textContent=imported?'Ваши данные':'Личная панель';
    $('dataBadge').style.cssText='color:#6252a4;background:#f1edff;border-color:#e5dfff';
    $('revenue30').textContent=imported&&verified?fmtK(r.revenue30_kopecks):'—';
    $('revenueChange').textContent=change===null?'Пока не с чем сравнить':(change>0?'+':'')+String(change).replace('.',',')+'% к предыдущему периоду';
    $('revenueChange').classList.toggle('down',change!==null&&change<0);
    $('comparisonDesc').textContent=imported&&verified&&r.coverage&&!r.coverage.comparable?'Для сравнения нужно больше данных: записи за '+r.coverage.current_days+' из 30 дней, ранее — за '+r.coverage.previous_days+' из 30':'Последние 30 завершённых дней с учётом возвратов';
    $('revenueYesterday').closest('.mini-kpi').querySelector('.kpi-name').textContent=
      shortMetric+' за вчера';
    $('revenueYesterday').textContent=imported&&verified?fmtK(r.yesterday_kopecks):'—';
    $('yesterdayDate').textContent=verboseDate(end);
    const volume=r?.volume;
    $('countLabel').textContent=(volume?.label||'Количество операций')+' за 30 дней';
    $('salesCount').textContent=imported&&Number.isFinite(volume?.value)
      ?Number(volume.value).toLocaleString('ru-RU',{maximumFractionDigits:3})+(volume.unit?' '+volume.unit:'')
      :'—';
    $('salesCaption').textContent=volume?.caption||'Пока нет данных о количестве';
    $('averageLabel').textContent='Средний чек';
    $('averageTicket').textContent=imported&&verified&&r.average_receipt_kopecks!==null?fmtK(r.average_receipt_kopecks):'—';
    $('averageCaption').textContent='Сумма за 30 дней / число операций';
    $('specialLabel').textContent='Другие показатели';
    $('specialIcon').innerHTML=svgIcon('alert');
    $('specialValue').textContent='—';
    $('specialCaption').textContent='Появятся, когда будут нужные данные';
    $('topTitle').textContent=r?.company?.industry==='clinic'?'Топ-3 услуги':
      r?.company?.industry==='store'?'Топ-3 товара':
      r?.company?.industry==='auto'?'Топ-3 работы':'Топ-3 позиции';
    const top=imported&&verified?(r.top3||[]).filter(x=>x.amount_kopecks>0):[];
    const highest=top.length?top[0].amount_kopecks:1;
    $('topItems').innerHTML=top.length?top.map((x,i)=>'<div><div class="top-row-head"><strong title="'+escapeHTML(x.item)+'">'+(i+1)+'. '+escapeHTML(x.item)+'</strong><span>'+fmtK(x.amount_kopecks)+'</span></div><div class="progress-track"><div class="progress-fill" style="width:'+Math.max(0,x.amount_kopecks/highest*100).toFixed(1)+'%;opacity:'+(1-i*.14)+'"></div></div></div>').join(''):'<p class="small-muted">Позиции появятся после загрузки CSV или Excel.</p>';
    chart(values,dates);
    $('chartCaption').textContent=verified?shortMetric+' по дням. Возвраты и исправления учтены.':
      'Загрузите подтверждённые оплаты или выполненные продажи для графика.';
    const bad=[],good=[];
    if(imported&&change!==null&&change<0)bad.push({title:shortMetric+' — снижение',desc:'Изменение к прошлым 30 дням: '+String(change).replace('.',',')+'%. Проверьте полноту выгрузки.'});
    if(imported&&change!==null&&change>0)good.push({title:shortMetric+' — рост',desc:'Рост к предыдущим 30 дням: +'+String(change).replace('.',',')+'%.'});
    if(imported&&top.length)good.push({title:'Больше всего по сумме — '+top[0].item,desc:'За 30 дней: '+fmtK(top[0].amount_kopecks)+'.'});
    if(imported)bad.push({title:'Проверьте, все ли данные загружены',desc:'Дни без записей могут быть пропусками в отчёте. Это влияет на сравнение с прошлым месяцем.'});
    if(!bad.length)bad.push({title:'Начните с загрузки отчёта',desc:'Выберите CSV или Excel (.xlsx) с датой, суммой и названиями товаров или услуг.'});
    if(!good.length)good.push({title:'Показатели появятся здесь',desc:'После загрузки CSV или Excel увидите результаты и изменения.'});
    const ai=state.mineAI;
    const ready=imported&&ai?.status==='ready'&&ai.analysis&&
      ai.primary_basis===r?.primary_basis;
    if(ready){
      const asItem=x=>({
        title:x.title,
        desc:[x.explanation,...(x.evidence||[]),'Рекомендация: '+x.recommendation].join(' ')
      });
      bad.splice(0,bad.length,...ai.analysis.issues.map(asItem));
      good.splice(0,good.length,...ai.analysis.positives.map(asItem));
      if(!good.length)good.push({title:'Пока нет заметных положительных изменений',desc:'По загруженным данным пока нельзя уверенно выделить положительные изменения.'});
    }
    for(const [id] of [['concerns'],['positives']]){
      const chip=$(id).closest('.panel')?.querySelector('.subtle-chip');
      if(chip)chip.textContent=ready?'Выводы по данным':imported&&ai?.status==='pending'?'Готовим выводы':'Показатели и выводы';
    }
    $('concerns').innerHTML=insightHTML(bad.slice(0,3),true);
    $('positives').innerHTML=insightHTML(good.slice(0,2),false);
    $('warningBanner').classList.toggle('show',!!state.mineError);
    $('warningBanner').textContent=state.mineError||'';
    $('bottomDataTitle').textContent=imported?'Данные сохранены. Новые отчёты дополняют историю.':(loading?'Получаем показатели…':state.mineError?'Не удалось получить сохранённые данные.':'Загрузите первый отчёт вашей компании.');
    $('bottomDataHint').textContent=imported?'Последняя загрузка: '+r.source.name+'. Всего операций в базе: '+number(r.source.rows)+'. Новые файлы дополняют историю.':state.mineError?'Сохранённые операции не удалены. Повторите запрос, когда соединение восстановится.':'Загрузите обезличенный CSV или Excel (.xlsx). Данные сохраняются на сервере.';
    if(imported){
      if(state.mineImportStats){
        const x=state.mineImportStats;
        $('bottomDataHint').textContent+=' Последний импорт: +'+number(x.added)+' новых, '+number(x.updated)+' исправлено'+(x.deleted?', '+number(x.deleted)+' отменено':'')+', '+number(x.unchanged)+' без изменений.';
        if(state.mineTemplateNotice)$('bottomDataHint').textContent+=state.mineTemplateNotice;
      }
      const message=ready?' Выводы готовы.':ai?.status==='pending'?' Готовим выводы по загруженным данным…':ai?.status==='disabled'?' Автоматические выводы недоступны, но основные показатели рассчитаны.':ai?.status==='error'?' Автоматические выводы временно недоступны. Основные показатели рассчитаны.':'';
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
      state.mineReport=await request('/report'+(state.mineViewBasis?'?basis='+state.mineViewBasis:''));
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
      $('financeBooks').hidden=true;
      $('unverifiedReview').hidden=true;
      $('debtInfo').hidden=true;
      document.querySelector('.revenue-panel .kpi-name').textContent='Продажи за 30 дней';
      $('revenueYesterday').closest('.mini-kpi').querySelector('.kpi-name').textContent='Продажи за вчера';
      $('revenueChart').closest('.panel').querySelector('.section-title').textContent='Динамика продаж';
      $('revenueChart').closest('.panel').querySelector('.subtle-chip').textContent='Продажи по дням';
      const concernsChip=$('concerns').closest('.panel')?.querySelector('.subtle-chip');
      const positivesChip=$('positives').closest('.panel')?.querySelector('.subtle-chip');
      if(concernsChip)concernsChip.textContent='Анализ';
      if(positivesChip)positivesChip.textContent='Позитив';
      updateQuickButton();
    });
  });

  const intro=document.querySelector('.modal-intro');
  const localIntro=intro.textContent;
  function refreshIntro(){
    intro.textContent=state.business==='mine'
      ?'CSV и Excel (.xlsx) дополняют историю: совпадающие операции обновляются. Обязателен стабильный ID чека или визита. Не загружайте персональные данные клиентов.'
      :'Файл обрабатывается только в браузере, на сервер не отправляется. Все данные демокомпаний остаются локальными.';
  }
  ['openImport','sideImport'].forEach(id=>$(id).addEventListener('click',refreshIntro));
  // Financial classification is explicit: field names alone cannot prove
  // whether a sum was collected or earned. Historical data stays unverified.
  const bookChoice=document.createElement('section');
  bookChoice.hidden=true;
  bookChoice.className='import-preview';
  bookChoice.style.cssText='margin:12px 0';
  bookChoice.innerHTML=
    '<label for="financialBookSelect" style="display:block;font-size:13px;font-weight:800;margin-bottom:8px">Что означают суммы в этом файле?</label>'+
    '<select id="financialBookSelect" style="width:100%;min-height:43px;background:white;color:#29334f;border:1px solid #cfd5e5;border-radius:10px;padding:9px;font-size:13px">'+
    '<option value="unverified">Не знаю, что за суммы — сохранить отдельно</option>'+
    '<option value="cash_receipts">Полученные деньги (включая авансы)</option>'+
    '<option value="recognized_revenue">Продажи: оказанные услуги и проданные товары</option>'+
    '</select>'+
    '<div id="financialBookHelp" style="margin-top:7px;font-size:12px;line-height:1.5;color:#66718a"></div>'+
    '<label id="earnedConfirmLabel" hidden style="display:flex;align-items:flex-start;gap:9px;margin-top:10px;font-size:12px">'+
    '<input type="checkbox" id="earnedConfirm" style="flex:none;margin-top:2px;accent-color:#625fea">'+
    '<span>Подтверждаю: услуги уже оказаны или товары переданы. Просто выставленные счета и авансы за будущие услуги не включены.</span></label>';
  $('financialPanel').before(bookChoice);
  const bookSelect=$('financialBookSelect'),earnedConfirm=$('earnedConfirm');
  const earnedConfirmLabel=$('earnedConfirmLabel'),bookHelp=$('financialBookHelp');
  function basisConflict(){
    if(!state.fileTable)return '';
    const local=window.BP_SmartImport?.financialSemantics(state.fileTable.head,mapping());
    if(bookSelect.value==='recognized_revenue'&&local?.basis==='cash_receipts')
      return 'Здесь указаны оплаты. Нельзя считать их продажами без данных об оказанных услугах или переданных товарах.';
    if(bookSelect.value==='cash_receipts'&&local?.basis==='reported_revenue')
      return 'Здесь указана стоимость продаж. Для поступлений выберите суммы реально полученных оплат.';
    return '';
  }
  function validateBookChoice(){
    const earned=bookSelect.value==='recognized_revenue';
    earnedConfirmLabel.hidden=!earned;
    bookHelp.textContent=earned
      ?'Стоимость уже оказанных услуг и переданных товаров — даже если клиент заплатит позже. Авансы за будущие услуги сюда не входят.'
      :bookSelect.value==='cash_receipts'
        ?'Все деньги, которые пришли в кассу или на счёт, включая авансы. Это не то же самое, что продажи.'
        :'Эти суммы сохраним отдельно, пока не выясним, что именно они означают.';
    const conflict=basisConflict();
    if(conflict)bookHelp.textContent=conflict;
    const approved=(!earned||earnedConfirm.checked)&&!conflict;
    if(!approved)$('confirmImport').disabled=true;
    if(typeof correctionMode!=='undefined'&&correctionMode.checked)setCorrectionButton();
    return approved;
  }
  function inferCashBook(file){
    if(!file||!file.head)return;
    const semantic=window.BP_SmartImport?.financialSemantics(file.head,mapping());
    if(!bookSelect.dataset.manuallyChosen)
      bookSelect.value=semantic?.basis==='cash_receipts'?'cash_receipts':'unverified';
    earnedConfirm.checked=false;
    validateBookChoice();
  }
  bookSelect.onchange=()=>{
    bookSelect.dataset.manuallyChosen='yes';
    earnedConfirm.checked=false;
    invalidateCorrection();
    if(state.fileTable)demo.preview(state.fileTable);
    validateBookChoice();
  };
  earnedConfirm.onchange=()=>{
    if(state.fileTable)demo.preview(state.fileTable);
    validateBookChoice();
  };
  document.addEventListener('bp:import-table-ready',event=>{
    bookChoice.hidden=state.business!=='mine';
    delete bookSelect.dataset.manuallyChosen;
    bookSelect.value='unverified';
    inferCashBook(event.detail?.file);
  });
  document.addEventListener('change',event=>{
    if(event.target?.closest?.('#mappingFields')&&state.business==='mine'){
      inferCashBook(state.fileTable);
    }
    if(event.target?.id==='financialConfirm')validateBookChoice();
  });
  // A separate, opt-in operation-correction workflow. Missing rows in an
  // ordinary/partial report can NEVER imply deletion from the company ledger.
  const correctionsPanel=document.createElement('section');
  correctionsPanel.id='correctionsPanel';
  correctionsPanel.style.cssText='margin:12px 0;border:1px solid #e4e6ee;border-radius:12px;padding:12px;color:#343e57;font-size:12px;line-height:1.5;';
  correctionsPanel.hidden=true;
  correctionsPanel.innerHTML=
    '<label style="display:flex;align-items:center;gap:9px;font-weight:700;cursor:pointer">'+
    '<input type="checkbox" id="useCorrections" style="flex:none;accent-color:#6260d5">'+
    'Исправить или отменить ранее загруженные операции</label>'+
    '<div id="correctionDetails" hidden style="padding-top:10px">'+
    '<div style="color:#606a80;margin-bottom:10px">Сверяем только операции, присутствующие в этом файле. '+
    'Для каждой нужен уникальный ID. Отсутствующие строки из базы не удаляются.</div>'+
    '<button type="button" class="ghost-btn" id="checkCorrections" style="min-height:38px;white-space:normal">Проверить изменения</button>'+
    '<div id="correctionResult" role="status" style="margin-top:9px;white-space:pre-line"></div>'+
    '<label id="correctionApproveLabel" hidden style="display:flex;align-items:start;gap:9px;margin-top:10px">'+
    '<input type="checkbox" id="approveCorrections" style="accent-color:#6260d5;flex:none">'+
    '<span>Я проверил список исправлений и отмен. Подтверждаю применение этих изменений.</span></label>'+
    '</div>';
  $('importPreview').before(correctionsPanel);
  const correctionMode=$('useCorrections');
  const correctionDetails=$('correctionDetails');
  const correctionReviewButton=$('checkCorrections');
  const correctionResult=$('correctionResult');
  const correctionApproveLabel=$('correctionApproveLabel');
  const correctionApprove=$('approveCorrections');
  let checkedCorrection=null;
  function correctionPayload(){
    const file=state.fileTable;
    if(!file)throw Error('Сначала выберите файл.');
    const cols=mapping();
    if(cols.id<0)throw Error('Для исправлений обязателен уникальный ID операции.');
    const parsed=parseImported(file,cols);
    if(parsed.invalid>0)throw Error('Исправьте '+parsed.invalid+' ошибочных строк: '+parsed.invalidExamples.join('; '));
    if(parsed.skipped>parsed.cancelled)
      throw Error('В выгрузке есть неоплаченные или ожидающие операции. В режиме исправлений нельзя пропускать такие строки незаметно. Уточните их статус и выгрузите только окончательные операции или явные отмены.');
    if(parsed.duplicate>0)throw Error('В файле есть одинаковые строки. Для сверки нужен уникальный ID каждого платежа.');
    const rows=parsed.rows.map(x=>({
      date:x.date,id:String(x.id),item:String(x.item),
      amount_kopecks:Math.round(x.amount*100),status:x.status,quantity_milli:x.quantity_milli??null
    }));
    if(rows.length+parsed.cancelled_ids.length>1000)
      throw Error('Пакет исправлений ограничен 1000 строками. Разделите выгрузку.');
    return {source:file.name.slice(0,120),rows,cancelled_ids:parsed.cancelled_ids,
      financial_basis:bookSelect.value};
  }
  function setCorrectionButton(){
    if(!correctionMode.checked)return;
    const financial=state.fileTable?._bpFinancialReview;
    let canApply=!!checkedCorrection&&checkedCorrection.file===state.fileTable&&
      correctionApprove.checked&&
      (bookSelect.value!=='recognized_revenue'||earnedConfirm.checked)&&!basisConflict()&&!financial?.blocked&&
      (!financial?.needsConfirm||$('financialConfirm').checked);
    if(canApply){
      try{
        canApply=JSON.stringify(correctionPayload())===checkedCorrection.payloadText&&
          Date.now()<checkedCorrection.expires_at_ms;
      }catch{canApply=false;}
    }
    $('confirmImport').disabled=!canApply;
  }
  function invalidateCorrection(){
    checkedCorrection=null;
    correctionApprove.checked=false;
    correctionApproveLabel.hidden=true;
    correctionResult.textContent='';
    if(correctionMode.checked)$('confirmImport').disabled=true;
  }
  correctionMode.onchange=()=>{
    correctionDetails.hidden=!correctionMode.checked;
    invalidateCorrection();
    if(state.fileTable)demo.preview(state.fileTable);
    setCorrectionButton();
  };
  correctionApprove.onchange=setCorrectionButton;
  $('financialConfirm').addEventListener('change',setCorrectionButton);
  document.addEventListener('change',event=>{
    if(event.target?.closest?.('#mappingFields')&&correctionMode.checked){
      invalidateCorrection();setCorrectionButton();
    }
  });
  document.addEventListener('bp:import-table-ready',event=>{
    correctionsPanel.hidden=state.business!=='mine';
    correctionMode.checked=false;
    correctionDetails.hidden=true;
    invalidateCorrection();
    if(event.detail?.file&&state.business==='mine')demo.preview(event.detail.file);
  });
  correctionReviewButton.onclick=async()=>{
    const file=state.fileTable;
    if(!correctionMode.checked||!file)return;
    correctionReviewButton.disabled=true;
    correctionResult.textContent='Проверяем изменения…';
    try{
      const financial=file._bpFinancialReview;
      if(financial?.blocked)throw Error('Выбран неподходящий столбец суммы. Проверьте, что именно в нём указано.');
      if(financial?.needsConfirm&&!$('financialConfirm').checked)
        throw Error('Сначала проверьте замечания к суммам и подтвердите их.');
      const payload=correctionPayload(),payloadText=JSON.stringify(payload);
      const response=await request('/import/corrections/preview',payload);
      if(state.fileTable!==file||!correctionMode.checked||
         JSON.stringify(correctionPayload())!==payloadText)return;
      const summary=response.summary||{};
      correctionResult.textContent='Добавить: '+(summary.added||0)+
        ' · исправить: '+(summary.updated||0)+' · отменить: '+(summary.deleted||0)+
        ' · без изменений: '+(summary.unchanged||0)+
        (summary.moved?' · перенос дат: '+summary.moved:'')+
        '\n'+(response.examples||[]).slice(0,8).map(x=>{
          const dates=x.old_date!==x.new_date?
            ' · '+(x.old_date||'—')+' → '+(x.new_date||'—'):'';
          const amounts=x.old_amount_kopecks!==x.new_amount_kopecks
            ?' · '+(x.old_amount_kopecks==null?'—':money(x.old_amount_kopecks/100))+
              ' → '+(x.new_amount_kopecks==null?'—':money(x.new_amount_kopecks/100))
            :'';
          return x.change+' · ID '+String(x.id).slice(0,45)+dates+amounts;
        }).join('\n');
      if(response.can_apply){
        checkedCorrection={file,payloadText,confirm_token:response.confirm_token,
          expires_at_ms:response.expires_at_ms};
        correctionApprove.checked=false;
        correctionApproveLabel.hidden=false;
      }else{
        correctionResult.textContent+='\nИзменений нет, повторная запись не требуется.';
        invalidateCorrection();
        correctionResult.textContent='Изменений нет, повторная запись не требуется.';
      }
      setCorrectionButton();
    }catch(error){
      invalidateCorrection();
      correctionResult.textContent=error.message||'Не удалось проверить изменения.';
    }finally{correctionReviewButton.disabled=false;}
  };
  // Mapping lookup sends only column headers and coarse numeric type ratios.
  // Never send cell values, payments, receipt IDs, filenames or raw rows.
  const recognitionStatus=document.createElement('div');
  recognitionStatus.id='importRecognitionStatus';
  recognitionStatus.className='import-recognition-status';
  recognitionStatus.setAttribute('role','status');
  recognitionStatus.hidden=true;
  $('smartImportInfo').after(recognitionStatus);
  const retryRecognition=document.createElement('button');
  retryRecognition.id='retryRecognition';
  retryRecognition.className='ghost-btn import-recognition-retry';
  retryRecognition.type='button';
  retryRecognition.textContent='Повторить распознавание';
  retryRecognition.hidden=true;
  recognitionStatus.after(retryRecognition);
  let currentRecognition=null;

  function recognitionMessage(message){
    recognitionStatus.textContent=message||'';
    recognitionStatus.hidden=!message;
  }
  async function resolveRecognition(work,retry=false){
    const {file,profiles,needsAI}=work;
    if(state.business!=='mine'||state.fileTable!==file||
        !$('modal').classList.contains('show')||file._bpUserAdjusted)return;
    const attempt=(file._bpRecognitionAttempt||0)+1;
    file._bpRecognitionAttempt=attempt;
    retryRecognition.hidden=true;
    retryRecognition.disabled=true;
    recognitionMessage('Проверяем формат выгрузки…');
    try{
      const answer=await request('/import/mapping/resolve',{
        head:file.head,profiles,needs_ai:needsAI,retry
      });
      if(state.business!=='mine'||state.fileTable!==file||
          !$('modal').classList.contains('show')||file._bpUserAdjusted||
          file._bpRecognitionAttempt!==attempt)return;

      if(answer?.mapping&&['template','suggestion','ai'].includes(answer.source)){
        if(answer.financial){
          file._bpAiFinancial=answer.financial;
          file._bpAiMappingAmount=answer.mapping.amount;
        }
        file._bpApplying=true;
        try{
          for(const key of ['date','amount','id','item','status','quantity']){
            const select=$('col_'+key),column=answer.mapping[key];
            if(select&&Number.isInteger(column)&&column>=-1&&column<file.head.length){
              select.value=String(column);
            }
          }
          $('col_date').dispatchEvent(new Event('change'));
        }finally{file._bpApplying=false;}
        recognitionMessage(answer.source==='template'
          ?'Применён сохранённый формат компании. Проверьте поля.'
          :answer.source==='suggestion'
            ?'Восстановлено ранее найденное соответствие. Подтвердите поля перед импортом.'
            :'Столбцы сопоставлены. Проверьте результат перед импортом.');
      }else{
        const seconds=Number(answer?.retry_after_seconds)||0;
        const minutes=Math.max(1,Math.ceil(seconds/60));
        recognitionMessage(answer?.reason==='disabled'
          ?'Автоматическое распознавание недоступно. Выберите столбцы вручную.'
          :answer?.reason==='limit'&&!answer?.can_retry
            ?'Дополнительная проверка временно ограничена. Повторите через '+minutes+' мин или выберите столбцы вручную.'
            :answer?.reason==='unrecognized'
              ?'Не удалось однозначно распознать формат. Проверьте поля вручную.'
              :needsAI
                ?'Не удалось определить все поля. Можно повторить или выбрать их вручную.'
                :'Проверьте соответствие столбцов перед импортом.');
        retryRecognition.hidden=!(needsAI&&answer?.can_retry===true);
      }
    }catch(error){
      if(state.fileTable!==file||file._bpRecognitionAttempt!==attempt)return;
      console.warn('Import mapping lookup unavailable:',error.message);
      recognitionMessage('Сопоставление временно недоступно. Проверьте столбцы или повторите попытку.');
      retryRecognition.hidden=false;
    }finally{
      if(state.fileTable===file&&file._bpRecognitionAttempt===attempt){
        retryRecognition.disabled=false;
      }
    }
  }
  retryRecognition.onclick=()=>{
    const work=currentRecognition;
    if(!work||state.fileTable!==work.file||work.file._bpUserAdjusted)return;
    void resolveRecognition(work,true);
  };

  document.addEventListener('bp:import-table-ready',event=>{
    const file=event.detail?.file;
    retryRecognition.hidden=true;
    recognitionMessage('');
    currentRecognition=null;
    if(!file||state.business!=='mine'||file.reportType==='aggregate')return;
    const header=file.head;
    const statistical=window.BP_SmartImport?.guess(header,file.rows.slice(0,80))?.profiles;
    if(!Array.isArray(statistical))return;
    const profiles=statistical.map(p=>({
      dates:p.dates,nums:p.nums,statuses:p.statuses,unique:p.unique,
      words:p.words,zeroids:p.zeroids,filled:p.filled
    }));
    const missing=['date','id','amount'].some(k=>file.mappingGuess?.[k]<0);
    const ambiguous=Object.values(file.confidence||{}).some(v=>v==='неоднозначно'||v==='требует проверки');
    const localFinance=window.BP_SmartImport?.financialSemantics(header,file.mappingGuess);
    const financialAmbiguity=(localFinance?.flags?.length||0)>0 ||
      ['accrual','advance','debt','tax','unit_price'].includes(localFinance?.basis) ||
      /аванс|предоплат|депозит|задат|задолж|дебитор|долг|частичн|рассроч|зачет|зачёт|сторно|возврат|ндс|налог|начислен|акт выполненных/i.test(header.join(' '));
    const needsAI=missing||ambiguous||file.mappingGuess?.item<0||financialAmbiguity;
    const work={file,profiles,needsAI};
    currentRecognition=work;
    void resolveRecognition(work);
  });
  const originalConfirm=$('confirmImport').onclick;
  $('confirmImport').onclick=async()=>{
    if(state.business!=='mine'){intro.textContent=localIntro;return originalConfirm();}
    if(state.mineSaving)return;
    let submitError='';
    try{
      const columns=mapping();
      const financial=state.fileTable?._bpFinancialReview;
      if(financial?.blocked)throw Error('В этом столбце не сумма полученных денег или выполненных продаж. Выберите подходящую сумму.');
      if(financial?.needsConfirm&&!$('financialConfirm').checked){
        throw Error('Проверьте замечания к суммам и подтвердите их перед загрузкой.');
      }
      if(columns.id<0)throw Error('Для накопительной загрузки выберите столбец «ID чека / визита». Без него нельзя надёжно исключить дубли.');
      if(state.fileTable.rows.some(values=>!String(values[columns.id]??'').trim()))throw Error('В столбце ID есть пустые значения. Нужны стабильные идентификаторы.');
      const isCorrection=correctionMode.checked;
      const result=parseImported(state.fileTable,columns);
      if(result.cancelled>0&&!isCorrection)throw Error('В файле есть отменённые операции. Выберите режим исправлений и проверьте изменения.');
      if(result.invalid>0)throw Error('Обнаружено '+result.invalid+' строк с ошибками: '+result.invalidExamples.join('; ')+'. Исправьте данные перед загрузкой.');
      if(!result.rows.length&&!(isCorrection&&result.cancelled_ids.length))
        throw Error('Нет корректных оплаченных операций для импорта.');
      if(result.rows.length>10000)throw Error('Сервер принимает до 10 000 операций за одну загрузку.');
      const rows=result.rows.map(x=>({
        date:x.date,id:String(x.id),item:String(x.item),
        amount_kopecks:Math.round(x.amount*100),status:x.status,quantity_milli:x.quantity_milli??null
      }));
      if(rows.some(x=>!Number.isSafeInteger(x.amount_kopecks)||x.amount_kopecks===0||Math.abs(x.amount_kopecks)>1e12))throw Error('Некорректные суммы: проверьте нулевые и слишком большие значения.');
      if(!validateBookChoice())
        throw Error(basisConflict()||'Подтвердите, что услуги уже оказаны или товары переданы. Авансы за будущие услуги и просто выставленные счета сюда не входят.');
      const financialBasis=bookSelect.value;
      const correctionData=isCorrection?correctionPayload():null;
      if(isCorrection&&(!checkedCorrection||checkedCorrection.file!==state.fileTable||
          !correctionApprove.checked||
          JSON.stringify(correctionData)!==checkedCorrection.payloadText||
          Date.now()>=checkedCorrection.expires_at_ms)){
        throw Error('Сначала проверьте исправления и подтвердите список изменений.');
      }
      state.mineSaving=true;
      $('confirmImport').disabled=true;
      $('importAlert').textContent='Сохраняем отчёт на сервере…';
      const actionError=$('importActionError');
      if(actionError){actionError.hidden=true;actionError.textContent='';}
      const template={
        head:state.fileTable.head,mapping:columns,
        financial:state.fileTable._bpAiMappingAmount===columns.amount
          ?state.fileTable._bpAiFinancial||null:null
      };
      const answer=isCorrection
        ?await request('/import/corrections/apply',{
          ...correctionData,confirm_token:checkedCorrection.confirm_token,
          expires_at_ms:checkedCorrection.expires_at_ms
        })
        :await request('/import',{source:state.fileTable.name.slice(0,120),
          financial_basis:financialBasis,rows});
      // Saving the mapping is independent of successful accounting: a template
      // API outage must not undo or retry a completed transaction import.
      let savedTemplate=false;
      try{
        const result=await request('/import/mapping/save',template);
        savedTemplate=result.saved===true;
      }catch(error){console.warn('Mapping could not be saved:',error.message);}
      state.mineTemplateNotice=savedTemplate
        ?' Формат выгрузки запомнен для следующих загрузок.'
        :' Соответствие столбцов не удалось запомнить; операции сохранены.';
      state.mineImportStats=answer.stats||null;
      state.mineViewBasis=financialBasis;
      try{
        state.mineReport=await request('/report?basis='+financialBasis);
      }catch{state.mineReport=answer.report;}
      state.mineAI=null;
      state.mineError='';
      invalidateCorrection();
      showModal(false);
      renderMine();
      if(!importHistoryPanel.hidden)void refreshImportHistory();
      void loadAI();
    }catch(error){
      const message=error.message||'Не удалось сохранить отчёт.';
      submitError=message;
      $('importAlert').textContent=message;
      const actionError=$('importActionError');
      if(actionError){actionError.textContent=message;actionError.hidden=false;}
    }
    finally{
      state.mineSaving=false;
      if($('modal').classList.contains('show')){
        demo.preview(state.fileTable);
        if(correctionMode.checked)setCorrectionButton();
        if(submitError){
          $('importAlert').textContent=submitError;
          const actionError=$('importActionError');
          if(actionError){actionError.textContent=submitError;actionError.hidden=false;}
        }
      }
    }
  };

  // Preserve explicitly requested demo launch parameters.
  const start=tg.initDataUnsafe&&tg.initDataUnsafe.start_param;
  if(!['clinic','store','cafe'].includes(start)){
    state.business='mine';
    renderMine();
  }
  loadMine();
})();
