'use strict';
(function(){
  // Workspace uses either signed Telegram initData or an independently
  // authenticated website account. Synthetic demo remains public/read-only.
  const demo=window.BP_Demo;
  const tg=window.Telegram?.WebApp||{};
  const webSession=()=>sessionStorage.getItem('bp-web-session')||'';
  if(!demo||(!tg.initData&&!/^[a-f0-9]{48}$/.test(webSession())))return;
  // The public demo is a separate view, even for authenticated users.
  if(new URLSearchParams(location.search).get('demo')==='1')return;
  const {state,parseImported,mapping,showModal,chart,insightHTML,escapeHTML,svgIcon,money,number,verboseDate,dateLabel,dateShift,yesterday}=demo;
  const $=id=>document.getElementById(id);
  const adminCompany=new URLSearchParams(location.search).get('admin_company');
  const adminView=Boolean(adminCompany);
  if(adminView){
    document.body.classList.add('bp-admin-view');
    const notice=document.createElement('div');notice.className='bp-admin-view-notice';notice.setAttribute('role','status');
    notice.textContent='Административный просмотр · только чтение. Загружаем компанию…';
    document.querySelector('.topbar').after(notice);
  }
  const accessStyle=document.createElement('style');
  accessStyle.textContent='.bp-access-locked .main > :not(.topbar):not(#subscriptionInfo):not(.bp-admin-view-notice):not(nav){display:none!important} .bp-access-locked #importUtilities{display:none!important}';
  document.head.appendChild(accessStyle);
  const URL_ROOT='https://pulse.cityai.site/api';
  function companySubscription(){
    const s=state.mineReport?.subscription||state.mineSubscription;
    if(adminView&&s)return {...s,access:true};
    if(!s?.access||s.state==='admin')return s;
    const end=s.state==='paid'?s.paid_until_ms:s.state==='trial'?s.trial_ends_ms:null;
    return end&&Number(end)<=Date.now()?{...s,state:'expired',access:false}:s;
  }
  function canImport(){return !adminView&&state.business==='mine'&&companySubscription()?.access===true;}
  const accessMessage=()=>state.mineError||'Загрузка недоступна: нужен действующий пробный период или подписка.';
  function requireImportAccess(){
    if(canImport())return;
    showModal(false);
    renderMine();
    throw Error(accessMessage());
  }

  // Real workspaces do not expose sample companies or a mode selector.
  const style=document.createElement('style');
  style.textContent=`
    body.private-workspace .switchbar{display:none!important}
    body.private-workspace #demoAiPanel{display:none!important}
    body.private-workspace #downloadSample{display:none!important}
    body.private-workspace .calculation-guide{display:none!important}
    body.private-workspace.private-empty-view .kpi-grid,
    body.private-workspace.private-empty-view .two-col,
    body.private-workspace.private-empty-view .bottom-grid,
    body.private-workspace.private-empty-view .data-bar,
    body.private-workspace.private-empty-view .source-note,
    body.private-workspace.private-empty-view #financeBooks,
    body.private-workspace.private-empty-view #unverifiedReview,
    body.private-workspace.private-empty-view #debtInfo{display:none!important}
    body.private-workspace .private-empty[hidden]{display:none!important}
    body.private-workspace .private-empty{background:linear-gradient(125deg,#fff 0%,#f8f8ff 100%);
      border:1px solid #e7e9f5;border-radius:21px;padding:clamp(21px,3vw,34px);
      margin:12px 0 20px;display:flex;align-items:center;gap:28px;justify-content:space-between}
    body.private-workspace .private-empty h2{font-size:clamp(19px,2vw,25px);color:#1c2440;margin:0 0 10px;letter-spacing:-.5px}
    body.private-workspace .private-empty p{color:#727c93;font-size:13px;line-height:1.65;max-width:550px;margin:0}
    body.private-workspace .private-empty .private-empty-actions{display:flex;gap:9px;flex-wrap:wrap}
    body.private-workspace .private-empty .private-empty-actions button{min-height:44px}
    body.private-workspace .private-sidelink{display:flex;align-items:center;gap:8px;color:#a7b1d1;
      text-decoration:none;font-size:12px;padding:12px;border-radius:10px}
    body.private-workspace .private-sidelink:hover{background:#252c49;color:white}
    body.private-workspace.bp-access-locked .main > .private-company-settings:not([hidden]){display:block!important}
    body.private-workspace .finance-book[hidden],
    body.private-workspace .mini-kpi[hidden]{display:none!important}
    body.private-workspace .finance-books.single-book{grid-template-columns:minmax(0,1fr)}
    body.private-workspace .private-company-settings[hidden]{display:none!important}
    body.private-workspace .private-company-settings{background:#fff;border:1px solid #e8eaf2;
      border-radius:13px;margin:0 0 16px;padding:12px 16px;color:#3f4863}
    body.private-workspace .private-company-settings summary{font-size:13px;font-weight:700;cursor:pointer}
    body.private-workspace .private-settings-body{padding-top:15px}
    body.private-workspace .private-settings-body label{display:block;font-weight:650;font-size:12px;margin-bottom:7px}
    body.private-workspace .private-settings-fields{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
    body.private-workspace .private-settings-fields select{flex:1;min-width:160px;max-width:360px;
      font:inherit;font-size:13px;padding:11px;border:1px solid #dfe3ed;border-radius:9px;background:white;color:#252d46}
    body.private-workspace .private-telegram-link{margin-top:18px;border-top:1px solid #eaedf3;padding-top:17px}
    body.private-workspace .private-telegram-link strong{font-size:13px}
    body.private-workspace .private-telegram-link[hidden]{display:none!important}
    body.private-workspace .private-telegram-link [hidden]{display:none!important}
    body.private-workspace .private-settings-note,body.private-workspace #privateIndustryStatus{
      font-size:12px;line-height:1.55;color:#707d95;margin:11px 0 0}
    body.private-workspace.bp-access-locked .main > #importUtilities{display:flex!important}
    body.private-workspace.bp-access-locked .main > #clearCompanyFeedback:not([hidden]){display:block!important}
    body.private-workspace .clear-data-dialog[hidden]{display:none!important}
    body.private-workspace .clear-data-dialog{position:fixed;inset:0;z-index:100;
      background:#10163099;display:flex;justify-content:center;align-items:center;padding:16px}
    body.private-workspace .clear-data-dialog-card{width:min(460px,100%);background:#fff;
      border-radius:19px;padding:clamp(20px,4vw,30px);box-shadow:0 20px 80px #10163055;color:#1e2844}
    body.private-workspace .clear-data-dialog-card h2{font-size:21px;margin:0 0 10px}
    body.private-workspace .clear-data-dialog-card p{font-size:13px;line-height:1.7;color:#58637a}
    body.private-workspace .clear-data-dialog-card label{display:block;font-size:12px;font-weight:750;margin:19px 0 7px}
    body.private-workspace .clear-data-dialog-card input{width:100%;min-height:44px;padding:11px;
      border:1px solid #dce1ed;border-radius:10px;color:#1e2844;background:#fff;font-size:14px}
    body.private-workspace .clear-data-dialog-actions{display:flex;gap:10px;margin-top:16px}
    body.private-workspace .clear-data-dialog-actions button{flex:1;min-height:44px;white-space:normal}
    body.private-workspace .clear-data-dialog-confirm{background:#bd3f57;color:#fff;border:0;
      border-radius:12px;padding:0 16px;font-size:13px;font-weight:700}
    body.private-workspace .clear-data-dialog-confirm:disabled{opacity:.4;cursor:default}
    body.private-workspace .clear-data-feedback{margin:8px 0 16px;font-size:12px;
      line-height:1.5;color:#5c6680}
    body.private-workspace .clear-data-feedback[hidden]{display:none!important}
    body.private-workspace .private-period-panel{background:#fff;border:1px solid #e7e9f2;
      padding:16px;border-radius:16px;margin:0 0 16px}
    body.private-workspace .private-period-heading{display:flex;flex-wrap:wrap;gap:8px;
      justify-content:space-between;font-size:13px;color:#252e47;margin-bottom:13px}
    body.private-workspace .private-period-heading span{font-size:11px;color:#8a94a7}
    body.private-workspace .private-period-options{display:flex;flex-wrap:wrap;gap:7px}
    body.private-workspace .private-period-option{border:0;border-radius:11px;padding:10px 12px;
      background:#f2f3f8;color:#525b76;font-weight:700;font-size:12px;min-height:40px}
    body.private-workspace .private-period-option.active{background:#6862e5;color:#fff}
    body.private-workspace .private-period-option:disabled{opacity:.4;cursor:not-allowed}
    body.private-workspace .private-period-dates{margin-top:13px;display:flex;flex-wrap:wrap;gap:8px;align-items:end}
    body.private-workspace .private-period-dates[hidden]{display:none!important}
    body.private-workspace .private-period-dates label{font-size:12px;display:flex;flex-direction:column;gap:5px}
    body.private-workspace .private-period-dates input{border:1px solid #e1e4ef;border-radius:9px;
      padding:9px;max-width:160px;min-height:40px;background:#fff;color:#252e47}
    body.private-workspace .topbar .eyebrow{color:#625dca}
    body.private-workspace .data-bar{background:#f9faff}
    @media(max-width:680px){
      body.private-workspace .private-empty{flex-direction:column;align-items:stretch;gap:17px}
      body.private-workspace .private-empty .private-empty-actions button{flex:1}
    }
  `;
  document.head.append(style);
  document.body.classList.add('private-workspace');
  const pageHeading=document.querySelector('.topbar .heading');
  const pageEyebrow=document.querySelector('.topbar .eyebrow');
  const sideHeading=document.querySelector('.sidebar .nav-heading');
  const sideOverview=document.querySelector('.sidebar .nav-item.active');
  pageHeading.textContent=adminView?'Кабинет компании':'Моя компания';
  pageEyebrow.textContent=adminView?'Административный просмотр':'Личный кабинет';
  if(sideHeading)sideHeading.textContent='ЛИЧНЫЙ КАБИНЕТ';
  if(sideOverview)sideOverview.lastChild.textContent=' Мои показатели';
  const demoLink=document.createElement('a');
  demoLink.className='private-sidelink';
  demoLink.href='./index.html?demo=1';
  demoLink.textContent='Посмотреть демо отдельно';
  document.querySelector('.sidebar .side-note')?.before(demoLink);
  const empty=document.createElement('section');
  empty.className='private-empty';
  empty.hidden=true;
  empty.setAttribute('aria-label','Начало работы с данными компании');
  empty.innerHTML='<div><h2>Начните с отчёта вашей компании</h2>'+
    '<p>Загрузите CSV или Excel из вашей учётной системы. Мы сохраним историю операций, рассчитаем показатели и покажем выводы ИИ. Никаких демонстрационных цифр.</p></div>'+
    '<div class="private-empty-actions"><button type="button" class="primary-btn" id="privateFirstImport">Загрузить первый отчёт</button></div>';
  $('subscriptionInfo').after(empty);
  $('privateFirstImport').onclick=()=>$('openImport').click();
  const companySettings=document.createElement('details');
  companySettings.className='private-company-settings';
  companySettings.hidden=true;
  companySettings.innerHTML=
    '<summary>Настройки компании</summary>'+
    '<div class="private-settings-body"><label for="privateCompanyIndustry">Тип бизнеса</label>'+
    '<div class="private-settings-fields"><select id="privateCompanyIndustry" aria-label="Тип бизнеса">'+
    '<option value="clinic">Клиника</option><option value="store">Магазин</option>'+
    '<option value="cafe">Кафе</option><option value="auto">Автосервис</option>'+
    '<option value="other">Другой бизнес</option></select>'+
    '<button type="button" class="ghost-btn" id="privateSaveIndustry">Сохранить</button></div>'+
    '<p class="private-settings-note">Тип влияет на названия и расчёт отраслевых показателей. Загруженные данные, история и подписка сохраняются.</p>'+
    '<p id="privateIndustryStatus" role="status" aria-live="polite"></p></div>';
  empty.after(companySettings);
  const industrySelect=$('privateCompanyIndustry'),industrySave=$('privateSaveIndustry');
  const industryStatus=$('privateIndustryStatus');
  let industrySaving=false;
  industrySave.onclick=async()=>{
    const currentCompany=state.mineReport?.company||state.mineCompany;
    if(industrySaving||currentCompany?.access_role!=='owner')return;
    industrySaving=true;
    industrySave.disabled=true;
    industryStatus.textContent='Сохраняем…';
    try {
      const result=await request('/company/industry',{industry:industrySelect.value});
      if(result.report)state.mineReport=result.report;
      state.mineCompany=result.company;
      if(state.mineReport)state.mineReport.company=result.company;
      state.mineAI=null;
      state.mineViewBasis=null;
      industryStatus.textContent=result.changed?'Тип бизнеса сохранён. Показатели пересчитаны.':'Этот тип бизнеса уже выбран.';
      renderMine();
      if(state.mineReport?.source)void loadAI();
    }catch(error){
      industryStatus.textContent=error.message||'Не удалось сохранить тип бизнеса.';
    }finally{industrySaving=false;industrySave.disabled=false;}
  };

  // Linking is initiated only from a verified email session; Telegram
  // confirms the same one-time request using its signed bot identity.
  const linkSection=document.createElement('div');
  linkSection.className='private-telegram-link';
  linkSection.hidden=!!tg.initData;
  linkSection.innerHTML='<strong>Telegram и сайт</strong>'+
    '<p class="private-settings-note">Свяжите аккаунты, чтобы работать с одними отчётами, показателями и подпиской в приложении и браузере.</p>'+
    '<div class="private-settings-fields">'+
    '<button type="button" class="ghost-btn" id="privateLinkTelegram">Связать Telegram</button>'+
    '<a id="privateOpenLink" target="_blank" rel="noopener noreferrer" hidden>Подтвердить в Telegram</a>'+
    '<button type="button" class="ghost-btn" id="privateLinkRefresh" hidden>Проверить привязку</button></div>'+
    '<p id="privateLinkStatus" class="private-settings-note" role="status"></p>';
  companySettings.querySelector('.private-settings-body').append(linkSection);
  const linkButton=$('privateLinkTelegram'),linkOpen=$('privateOpenLink');
  const linkRefresh=$('privateLinkRefresh'),linkStatus=$('privateLinkStatus');
  const showLinkStatus=async()=>{
    if(tg.initData||adminView)return;
    try{
      const data=await request('/account-link/status');
      if(data.linked){
        linkButton.hidden=true;linkOpen.hidden=true;linkRefresh.hidden=true;
        linkStatus.textContent='Telegram привязан. В приложении и на сайте используются одни данные компании.';
        if(state.mineReport?.company?.id!==data.company_id)void loadMine();
      }else{
        linkButton.hidden=false;
        linkStatus.textContent='Telegram пока не привязан.';
      }
    }catch(e){linkStatus.textContent=e.message||'Не удалось проверить связь аккаунтов.';}
  };
  linkButton.onclick=async()=>{
    linkButton.disabled=true;
    linkStatus.textContent='Создаём защищённую ссылку…';
    try{
      const result=await request('/account-link/start',{confirm:true});
      linkOpen.href=result.url;
      linkOpen.hidden=false;
      linkOpen.style.cssText='display:inline-flex;align-items:center;color:#605ad0;font-weight:700;font-size:13px;';
      linkRefresh.hidden=false;
      linkStatus.textContent='Нажмите «Подтвердить в Telegram» и подтвердите привязку в боте. Ссылка действует 10 минут.';
    }catch(e){linkStatus.textContent=e.message||'Не удалось создать ссылку.';}
    finally{linkButton.disabled=false;}
  };
  linkRefresh.onclick=()=>{void showLinkStatus();};

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

  const retryLoad=document.createElement('button');
  retryLoad.type='button';
  retryLoad.className='ghost-btn';
  retryLoad.textContent='Повторить загрузку';
  retryLoad.hidden=true;
  $('importUtilities').appendChild(retryLoad);
  retryLoad.onclick=()=>{ if(!state.mineLoading)void loadMine(); };

  const clearTests=document.createElement('button');
  clearTests.type='button';
  clearTests.id='clearCompanyData';
  clearTests.className='ghost-btn';
  clearTests.textContent='Очистить данные';
  clearTests.hidden=true;
  $('importUtilities').appendChild(clearTests);
  const clearFeedback=document.createElement('p');
  clearFeedback.className='clear-data-feedback';
  clearFeedback.id='clearCompanyFeedback';
  clearFeedback.hidden=true;
  clearFeedback.setAttribute('role','status');
  clearFeedback.setAttribute('aria-live','polite');
  $('importUtilities').after(clearFeedback);

  // Own confirmation dialog works in Safari, normal browsers and Telegram.
  // Telegram.WebApp.showConfirm exists even without signed initData and may
  // never invoke its callback when the page is opened outside Telegram.
  function confirmCompanyClear(){
    return new Promise(resolve=>{
      const overlay=document.createElement('div');
      overlay.className='clear-data-dialog';
      overlay.setAttribute('role','dialog');
      overlay.setAttribute('aria-modal','true');
      overlay.setAttribute('aria-labelledby','clearDataTitle');
      overlay.innerHTML='<section class="clear-data-dialog-card">'+
        '<h2 id="clearDataTitle">Удалить данные компании?</h2>'+
        '<p>Будут безвозвратно удалены все загруженные операции, история импорта, сохранённые шаблоны и выводы ИИ. Компания, сотрудники, учётная запись и подписка останутся.</p>'+
        '<label for="clearDataPhrase">Введите УДАЛИТЬ для подтверждения</label>'+
        '<input id="clearDataPhrase" type="text" autocomplete="off" spellcheck="false" placeholder="УДАЛИТЬ">'+
        '<div class="clear-data-dialog-actions">'+
        '<button class="ghost-btn" type="button" data-action="cancel">Отмена</button>'+
        '<button class="clear-data-dialog-confirm" type="button" data-action="confirm" disabled>Удалить данные</button>'+
        '</div></section>';
      document.body.append(overlay);
      const field=overlay.querySelector('input');
      const approve=overlay.querySelector('[data-action="confirm"]');
      const previousFocus=document.activeElement;
      let finished=false;
      const close=accepted=>{
        if(finished)return;
        finished=true;
        overlay.removeEventListener('keydown',onKeyDown);
        overlay.remove();
        if(previousFocus?.isConnected)previousFocus.focus();
        resolve(accepted);
      };
      const onKeyDown=event=>{
        if(event.key==='Escape'){event.preventDefault();close(false);}
        if(event.key==='Enter'&&!approve.disabled){event.preventDefault();close(true);}
      };
      overlay.addEventListener('keydown',onKeyDown);
      field.addEventListener('input',()=>{approve.disabled=field.value.trim().toUpperCase()!=='УДАЛИТЬ';});
      overlay.querySelector('[data-action="cancel"]').onclick=()=>close(false);
      approve.onclick=()=>{if(!approve.disabled)close(true);};
      overlay.addEventListener('click',event=>{if(event.target===overlay)close(false);});
      field.focus();
    });
  }

  // One reporting period controls financial KPIs, chart and AI interpretation.
  state.minePeriod={days:30};
  function periodQuery(){
    const p=state.minePeriod;
    return p.from&&p.to?'from='+encodeURIComponent(p.from)+'&to='+encodeURIComponent(p.to):
      'days='+p.days;
  }
  function isLongPeriodAllowed(){
    return ['paid','admin'].includes(companySubscription()?.state);
  }
  const periodPanel=document.createElement('section');
  periodPanel.className='private-period-panel';
  periodPanel.innerHTML='<div class="private-period-heading"><strong>Период аналитики</strong>'+
    '<span id="privatePeriodHint">Показатели, динамика и ИИ-анализ за выбранный период</span></div>'+
    '<div class="private-period-options">'+
    [['7 дней',7],['30 дней',30],['90 дней',90],['Год',365],['3 года',1095]].map(
      ([label,days])=>'<button type="button" class="private-period-option" data-days="'+days+'">'+label+'</button>'
    ).join('')+
    '<button type="button" class="private-period-option" id="privateCustomPeriod">По датам</button></div>'+
    '<div class="private-period-dates" id="privatePeriodDates" hidden>'+
    '<label>С <input id="privateFrom" type="date"></label>'+
    '<label>По <input id="privateTo" type="date"></label>'+
    '<button type="button" class="ghost-btn" id="privateApplyDates">Применить</button></div>'+
    '<p class="private-settings-note" id="privatePeriodError" role="status"></p>';
  $('subscriptionInfo').after(periodPanel);
  const periodError=$('privatePeriodError'),periodDates=$('privatePeriodDates');
  function renderPeriodControls(){
    const allowed=isLongPeriodAllowed();
    periodPanel.querySelectorAll('[data-days]').forEach(button=>{
      const days=Number(button.dataset.days);
      button.classList.toggle('active',state.minePeriod.days===days&&!state.minePeriod.from);
      button.disabled=days>90&&!allowed;
      button.title=button.disabled?'Расширенная история доступна с платной подпиской':'';
    });
    $('privateCustomPeriod').classList.toggle('active',!!state.minePeriod.from);
    $('privateFrom').max=yesterday;
    $('privateTo').max=yesterday;
    $('privatePeriodHint').textContent=allowed
      ?'График и рекомендации ИИ за выбранный период, до трёх лет.'
      :'Доступно до 90 дней. История за год и три года — в платной подписке.';
  }
  async function changePeriod(next){
    state.minePeriod=next;
    state.mineAI=null;
    ++analysisSeq;
    periodError.textContent='';
    renderPeriodControls();
    await loadMine();
  }
  periodPanel.querySelectorAll('[data-days]').forEach(button=>{
    button.onclick=()=>{
      if(button.disabled)return;
      periodDates.hidden=true;
      void changePeriod({days:Number(button.dataset.days)});
    };
  });
  $('privateCustomPeriod').onclick=()=>{
    periodDates.hidden=!periodDates.hidden;
    if(!periodDates.hidden){
      $('privateTo').value=state.minePeriod.to||yesterday;
      $('privateFrom').value=state.minePeriod.from||dateShift(yesterday,-29);
    }
  };
  $('privateApplyDates').onclick=()=>{
    const from=$('privateFrom').value,to=$('privateTo').value;
    const span=Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000)+1;
    if(!from||!to||!Number.isFinite(span)||span<1||span>(isLongPeriodAllowed()?1095:90)||to>yesterday){
      periodError.textContent='Укажите завершённые даты в пределах '+(isLongPeriodAllowed()?'трёх лет':'90 дней')+'.';
      return;
    }
    periodDates.hidden=true;
    void changePeriod({from,to,days:span});
  };

  // Shared company import journal. Filenames are always rendered via textContent.
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
        if(entry.can_undo&&!adminView){
          const undo=document.createElement('button');
          undo.type='button';
          undo.className='ghost-btn';
          undo.textContent='Отменить загрузку';
          undo.onclick=async()=>{
            const ask='Отменить последнюю загрузку? Новые операции будут удалены, а исправленные суммы восстановлены.';
            const approved=await new Promise(resolve=>{
              if(tg.initData&&typeof tg.showConfirm==='function')tg.showConfirm(ask,resolve);
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
    const busy=!!(state.mineLoading||state.mineSaving||state.mineClearing);
    const company=state.mineReport?.company||state.mineCompany;
    const total=state.mineReport?.source?.rows??state.mineStoredRows??0;
    importHistoryButton.hidden=state.business!=='mine'||!companySubscription()?.access;
    if(state.business!=='mine'){importHistoryPanel.hidden=true;importHistoryButton.textContent='История загрузок';}
    retryLoad.hidden=state.business!=='mine'||!state.mineError;
    retryLoad.disabled=busy;
    clearTests.textContent=state.mineClearing?'Удаляем…':'Очистить данные';
    clearTests.hidden=state.business!=='mine'||company?.access_role!=='owner'||total<=0;
    clearTests.disabled=busy;
  }
  clearTests.onclick=async()=>{
    if(clearTests.hidden||state.mineClearing||state.mineSaving||state.mineLoading)return;
    const confirmed=await confirmCompanyClear();
    if(!confirmed)return;
    state.mineClearing=true;
    state.mineError='';
    clearFeedback.hidden=false;
    clearFeedback.textContent='Удаляем операции и историю загрузок…';
    updateQuickButton();
    try{
      const result=await request('/clear-company-data',{confirm:'DELETE_ALL_COMPANY_DATA'});
      ++analysisSeq; // cancel any stale pending AI responses
      state.mineReport=result.report;
      state.mineCompany=result.report?.company||state.mineCompany;
      state.mineStoredRows=0;
      state.mineAI=null;
      state.mineImportStats=null;
      state.mineTemplateNotice='';
      state.mineViewBasis=null;
      invalidateCorrection();
      importHistoryPanel.hidden=true;
      importHistoryButton.textContent='История загрузок';
      clearFeedback.textContent='Данные удалены: '+result.removed+' операций. Компания и подписка сохранены.';
      renderMine();
    }catch(error){
      clearFeedback.textContent='Не удалось очистить данные: '+(error.message||'Ошибка сервера');
      renderMine();
    }finally{
      state.mineClearing=false;
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
        const result=await request('/analysis?'+periodQuery()+(state.mineViewBasis?'&basis='+state.mineViewBasis:''));
        if(current!==analysisSeq)return;
        state.mineAI=result;
        if(state.business==='mine')renderMine();
        if(adminView||result.status!=='pending')return;
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
    if(adminView){
      if(body)throw Error('Административный просмотр доступен только для чтения.');
      const path=route.split('?')[0];
      if(!['/report','/me','/subscription','/analysis','/import/history'].includes(path))throw Error('Раздел недоступен в административном просмотре.');
      route='/admin/workspaces/'+encodeURIComponent(adminCompany)+route;
    }
    if(body&&(route.startsWith('/import')||route==='/reset-test-data'))requireImportAccess();
    // VPS may briefly restart the API after a new commit. Retry READS only.
    // Never retry POST: repeating financial imports or deletion is unsafe.
    const tries=body?1:4;
    let response;
    for(let attempt=0;attempt<tries;attempt++){
      try{
        response=await fetch(URL_ROOT+route,{
          method:body?'POST':'GET',
          headers:{...(tg.initData?{'X-Telegram-Init-Data':tg.initData}:{'X-BP-Web-Session':webSession()}),...(body?{'Content-Type':'application/json'}:{})},
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
    if(!response.ok){
      const error=Error(response.status===401?(tg.initData?'Авторизация Telegram устарела. Закройте и снова откройте Mini App.':'Сессия закончилась. Войдите в кабинет заново.'):result.error||'Ошибка сервера '+response.status);
      if(response.status===401&&!tg.initData)window.dispatchEvent(new Event('bp:web-session-expired'));
      error.status=response.status;
      if(response.status===401||response.status===402){
        const previous=companySubscription();
        state.mineReport=null;
        state.mineSubscription=response.status===402?{...previous,state:'expired',access:false}:null;
        state.mineError=error.message;
        showModal(false);
        if(state.business==='mine')renderMine();
      }
      throw error;
    }
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
      ['recognized_revenue',copy.done,'Стоимость уже оказанных услуг, работ или переданных товаров'],
      ['unverified','Суммы из отчёта','Назначение суммы не уточнено; исходные данные показаны отдельно']
    ];
    const available=labels.filter(([basis])=>report.financial_books[basis]?.available);
    holder.hidden=available.length===0;
    holder.classList.toggle('single-book',available.length===1);
    holder.innerHTML=available.map(([basis,name,hint])=>{
      const book=report.financial_books[basis]||{};
      const selected=report.primary_basis===basis;
      return '<button type="button" class="finance-book" data-financial-basis="'+basis+
        '" aria-pressed="'+selected+'">'+
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
        '<div>По части отчётов пока неизвестно, что означают суммы. '+
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
  const customerPanel=document.createElement('section');
  customerPanel.id='customerAnalytics';customerPanel.className='panel customer-panel';customerPanel.hidden=true;
  customerPanel.setAttribute('aria-label','Пациенты, возвращаемость и LTV');
  $('debtInfo').after(customerPanel);
  const customerStyle=document.createElement('style');
  customerStyle.textContent=`.customer-panel{margin:20px 0}.customer-panel[hidden]{display:none!important}
    .customer-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0}
    .customer-kpi{background:#f6f7fc;border-radius:12px;padding:15px;min-width:0}
    .customer-kpi span{display:block;font-size:12px;color:#6a7490;line-height:1.5}
    .customer-kpi strong{display:block;font-size:23px;color:#202848;margin:8px 0;overflow-wrap:anywhere}
    .customer-panel p{font-size:12px;color:#727c93;line-height:1.65}.customer-panel summary{cursor:pointer;font-weight:700;font-size:13px;padding:12px 0}
    .customer-table-wrap{overflow-x:auto}.customer-table{width:100%;border-collapse:collapse;min-width:440px;font-size:12px}
    .customer-table td,.customer-table th{text-align:left;padding:11px 8px;border-bottom:1px solid #e9ecf5}
    @media(max-width:1000px){.customer-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:420px){.customer-kpi{padding:11px}.customer-kpi strong{font-size:20px}}
  `;
  document.head.appendChild(customerStyle);
  function renderCustomers(r){
    customerPanel.hidden=state.business!=='mine'||!r?.source||!companySubscription()?.access;
    if(customerPanel.hidden)return;
    const c=r.customers,isClinic=r.company?.industry==='clinic';
    const estimated=c?.financial?.estimated||c?.visits?.estimated||!c?.visits?.available;
    const header='<h2 class="section-title">'+(isClinic?'Пациенты и LTV':'Клиенты и LTV')+(c?.available&&estimated?' · оценка':'')+'</h2>';
    if(!c?.available){
      customerPanel.innerHTML=header+'<p>Финансовые показатели рассчитаны. Для оценки LTV и повторных обращений достаточно ФИО — например, фамилии и отчества. Сервис также распознаёт ID, телефон или email, если они есть. Без данных о человеке нельзя оценить его повторные обращения.</p>';
      return;
    }
    const f=c.financial,activityOnly=!c.visits.available,v=activityOnly?c.activity:c.visits;
    const num=x=>Number.isFinite(x)?Number(x).toLocaleString('ru-RU',{maximumFractionDigits:2}):'—';
    const percent=x=>Number.isFinite(x)?num(x)+'%':'—';
    const card=(label,value,hint)=>'<div class="customer-kpi"><span>'+escapeHTML(label)+'</span><strong>'+escapeHTML(value)+'</strong><span>'+escapeHTML(hint)+'</span></div>';
    const basis=f.basis==='cash_receipts'?'По оплатам, за вычетом возвратов':f.basis==='recognized_revenue'?'По оказанным услугам / продажам, за вычетом возвратов':'По суммам из отчёта; смысл сумм не подтверждён';
    const cards=[
      card('Средний LTV по истории',fmtK(f.average_ltv_kopecks),basis),
      card('Медианный LTV',fmtK(f.median_ltv_kopecks),'Типичная накопленная сумма на человека'),
      card(isClinic?'Пациентов за период':'Клиентов за период',num(f.active_patients),'По строкам, связанным с человеком'),
      card(f.synthetic_rows?'Средняя сумма за обращение (оценка)':'Средний чек клиента',fmtK(f.average_receipt_kopecks),f.synthetic_rows?'Без ID: по пациенту и дню':'По чекам за доступную историю'),
      card(activityOnly?'Повторные дни операций':isClinic?'Повторных пациентов':'Повторных клиентов',v.available?num(v.returning_patients):'—',activityOnly?'Не подтверждает повторное посещение':'Обращения в разные дни'),
      card(activityOnly?'Доля с повторными операциями':'Доля повторных пациентов',v.available?percent(v.returning_percent):'—','Среди активных в выбранном периоде'),
      card(activityOnly?'Операций на человека':isClinic?'Визитов на пациента':'Продаж на клиента',v.available?num(v.visits_per_patient):'—',v.synthetic_rows?'По условным обращениям за день':'За выбранный период'),
      card(activityOnly?'Между днями операций':'Между посещениями',v.available&&v.average_gap_days!==null?num(v.average_gap_days)+' дн.':'—','Средний интервал за доступную историю')
    ].join('');
    let notes='';
    if(f.name_based_patients||v.name_based_patients)notes+='<p><strong>Пациенты определены по ФИО или его частям.</strong> Совпадающие имена могут объединить разных людей, а опечатки, сокращения и смена фамилии — разделить одного. Процент ошибки по этой выгрузке неизвестен.</p>';
    if(f.synthetic_rows||v.synthetic_rows)notes+='<p><strong>В исходном отчёте нет ID части или всех операций.</strong> Услуги одного пациента за день объединены в условное обращение. Несколько отдельных визитов за один день могут считаться одним; средний чек и число визитов — оценки.</p>';
    if(activityOnly)notes+='<p>Повторы рассчитаны по датам операций выбранного показателя. Несколько оплат или назначений не доказывают несколько состоявшихся визитов. Для подтверждённых посещений нужны данные об оказанных услугах.</p>';
    const coverage='LTV рассчитан по '+num(f.patients)+' людям; связь установлена у '+num(f.coverage.identified_rows)+' из '+num(f.coverage.total_rows)+' строк выбранного показателя.';
    const partial=f.coverage.identified_rows<f.coverage.total_rows?' Данные неполные: средние относятся только к связанным строкам.':'';
    let extra='';
    if(v.available){
      extra='<details><summary>Повторы, группы пациентов и дополнительные показатели</summary><p>Впервые в доступной истории за период: '+num(v.first_observed_patients)+'. Активных за период: '+num(v.period_patients)+'. Обращений / операций: '+num(v.period_visits)+'. Без '+(activityOnly?'операций':'посещений')+' не менее 90 / 180 дней: '+num(v.absent_90_days)+' / '+num(v.absent_180_days)+'. Это не прогноз ухода.</p>'+
        '<p>Возврат — запись в другой день в течение указанного срока после первой даты в доступной истории. Учитываются только люди с завершённым окном наблюдения. Несколько услуг одного обращения не увеличивают число обращений.</p>'+
        '<div class="customer-table-wrap"><table class="customer-table"><caption>Повторные '+(activityOnly?'операции':'посещения')+' по доступной истории</caption><thead><tr><th>Срок</th><th>Достаточно истории</th><th>Повтор</th><th>Доля</th></tr></thead><tbody>'+v.retention.map(x=>'<tr><td>'+x.days+' дней</td><td>'+num(x.eligible)+'</td><td>'+num(x.returned)+'</td><td>'+percent(x.percent)+'</td></tr>').join('')+'</tbody></table></div>'+
        '<div class="customer-table-wrap"><table class="customer-table"><caption>Последние 12 групп по первой дате в доступной истории</caption><thead><tr><th>Месяц</th><th>Людей</th><th>За 30 дней</th><th>За 90 дней</th><th>За 180 дней</th></tr></thead><tbody>'+v.cohorts.map(x=>'<tr><td>'+escapeHTML(x.month)+'</td><td>'+num(x.patients)+'</td>'+x.retention.map(y=>'<td>'+percent(y.percent)+' ('+num(y.returned)+' / '+num(y.eligible)+')</td>').join('')+'</tr>').join('')+'</tbody></table></div>'+
        '<p>Для повторов связь с человеком установлена у '+num(v.coverage.identified_rows)+' из '+num(v.coverage.total_rows)+' строк. Пустые и непригодные для связи значения не входят в расчёт.</p></details>';
    }
    customerPanel.innerHTML=header+'<p>Выбранный период: '+escapeHTML(c.period.from)+' — '+escapeHTML(c.period.to)+'. LTV: история с '+escapeHTML(c.history_from||'—')+' по '+escapeHTML(c.as_of)+', максимум '+(c.history_window_days===1095?'3 года':c.history_window_days+' дней')+'. Это накопленная сумма из доступных данных, не прибыль и не прогноз.</p>'+notes+'<div class="customer-kpis">'+cards+'</div><p>'+escapeHTML(coverage+partial)+'</p>'+extra+'<p>Дополнительные данные вручную создавать не нужно. При наличии сервис предпочитает постоянный ID, затем телефон или email, затем ФИО. Во всех выгрузках лучше использовать один вид данных; разные идентификаторы автоматически не объединяются.</p>';
  }
  function renderMine(){
    document.body.classList.remove('demo-mode');
    const r=state.mineReport||null;
    const subscription=companySubscription();
    const locked=!subscription?.access;
    document.body.classList.toggle('bp-access-locked',locked);
    $('openImport').disabled=adminView||locked||!!state.mineLoading;
    $('sideImport').disabled=adminView||locked||!!state.mineLoading;
    const operator=subscription?.state==='admin'&&r?.company?.access_role==='owner';
    window.dispatchEvent(new CustomEvent('bp:workspace-access',{detail:{admin:operator,pending:!subscription&&!!state.mineLoading}}));

    const subscriptionBox=$('subscriptionInfo');
    subscriptionBox.hidden=false;
    if(subscription?.state==='admin'){
      subscriptionBox.textContent='Постоянный административный доступ. Подписка и пробный период не требуются.';
    }else if(subscription){
      const until=subscription.state==='paid'?subscription.paid_until_ms:subscription.trial_ends_ms;
      const label=subscription.state==='paid'?'Подписка до ':subscription.state==='pending'?'Доступ пока не активирован. Оплатите подписку или обратитесь в поддержку для включения пробных 48 часов.':subscription.state==='expired'?'Доступ завершён. Данные сохранены.':'Пробный доступ — до ';
      const date=subscription.state==='expired'||subscription.state==='pending'?'':new Date(until).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'})+' МСК.';
      subscriptionBox.innerHTML=escapeHTML(label+date)+' <a href="#" data-bp-pay="month">Перейти к оплате</a>'+(!subscription.access?' · <a href="https://t.me/business_pulse_app_bot?start=support">Поддержка</a>':'');
    }else{
      subscriptionBox.textContent=state.mineLoading?'Проверяем доступ к компании…':state.mineError||'Не удалось проверить доступ. Откройте приложение заново.';
    }

    const currentCompany=r?.company||state.mineCompany;
    companySettings.hidden=!currentCompany;
    if(currentCompany){
      industrySelect.value=currentCompany.industry||'other';
      industrySelect.disabled=currentCompany.access_role!=='owner';
      industrySave.hidden=currentCompany.access_role!=='owner';
      industrySave.disabled=industrySaving;
    }
    if(adminView){
      linkSection.hidden=true;
      subscriptionBox.querySelectorAll('a').forEach(a=>a.remove());
      const notice=document.querySelector('.bp-admin-view-notice');
      notice.textContent='Административный просмотр · '+(currentCompany?.name||'Компания')+' · только чтение. '+(state.mineError||'Подписка и данные не изменяются.');
    }
    if(state.fileTable)refreshBothOption();
    renderPeriodControls();
    const imported=!!(r&&r.source), loading=!!state.mineLoading;
    const noData=!imported&&!loading;
    document.body.classList.toggle('private-empty-view',noData);
    empty.hidden=imported||locked||loading||!!state.mineError;
    const end=r&&r.as_of?r.as_of:yesterday;
    const chartData=r&&Array.isArray(r.chart7)&&r.chart7.length>0?r.chart7:null;
    const dates=chartData?chartData.map(x=>x.date):Array.from({length:7},(_,i)=>dateShift(end,-6+i));
    const values=chartData?chartData.map(x=>x.amount_kopecks/100):Array(7).fill(0);
    const change=imported&&r.primary_basis!=='unverified'?r.change_percent:null;
    $('businessDesc').textContent=r?.company?.name?'Финансовый обзор · '+r.company.name:'Отчёты и аналитика вашей компании';
    renderFinanceBooks(r);
    renderCustomers(r);
    const financialLabel=financialTitles[r?.primary_basis]||financialTitles.unverified;
    const shortMetric=r?.primary_basis==='cash_receipts'?'Поступления':
      r?.primary_basis==='recognized_revenue'?'Продажи':'Суммы';
    const moneyLabels=industryFor(r);
    const metricTitle=r?.primary_basis==='cash_receipts'?moneyLabels.paid:
      r?.primary_basis==='recognized_revenue'?moneyLabels.done:'Суммы из отчёта';
    const verified=r?.primary_basis==='cash_receipts'||r?.primary_basis==='recognized_revenue';
    const volumeCard=$('salesCount').closest('.mini-kpi');
    const averageCard=$('averageTicket').closest('.mini-kpi');
    volumeCard.hidden=!Number.isFinite(r?.volume?.value)&&!(r?.operation_identity?.total_rows>0);
    averageCard.hidden=!Number.isFinite(r?.average_receipt_kopecks);
    const periodLabel=r?.period?.days===7?'за 7 дней':r?.period?.days===30?'за 30 дней':r?.period?.days===365?'за год':r?.period?.days===1095?'за 3 года':'за '+(r?.period?.days||30)+' дней';
    document.querySelector('.revenue-panel .kpi-name').textContent=metricTitle+' '+periodLabel;
    $('revenueChart').closest('.panel').querySelector('.section-title').textContent='Динамика: '+shortMetric.toLowerCase();
    $('revenueChart').closest('.panel').querySelector('.subtle-chip').textContent=shortMetric+' по дням';
    $('companyName').textContent=r&&r.company?r.company.name:'Моя компания';
    $('asOf').textContent='По '+verboseDate(end)+' включительно (МСК)';
    $('rowsInfo').textContent=imported?'В базе '+number(r.source.rows)+' операций':(loading?'Загружаем данные…':state.mineError?'Данные временно недоступны':'Нет загруженных отчётов');
    $('dataBadge').textContent=imported?'Ваши данные':'Личная панель';
    $('dataBadge').style.cssText='color:#6252a4;background:#f1edff;border-color:#e5dfff';
    $('revenue30').textContent=imported?fmtK(r.revenue30_kopecks):'—';
    $('revenueChange').textContent=change===null?'Пока не с чем сравнить':(change>0?'+':'')+String(change).replace('.',',')+'% к предыдущему периоду';
    $('revenueChange').classList.toggle('down',change!==null&&change<0);
    $('comparisonDesc').textContent=imported&&verified&&r.coverage&&!r.coverage.comparable?'Для сравнения нужно больше данных: записи за '+r.coverage.current_days+' из '+(r.period?.days||30)+' дней, ранее — за '+r.coverage.previous_days:'Выбранный период с учётом возвратов';
    $('revenueYesterday').closest('.mini-kpi').querySelector('.kpi-name').textContent=
      shortMetric+' за последний день периода';
    $('revenueYesterday').textContent=imported?fmtK(r.yesterday_kopecks):'—';
    $('yesterdayDate').textContent=verboseDate(end);
    const volume=r?.volume;
    $('countLabel').textContent=(Number.isFinite(volume?.value)?volume.label:'Строк в отчёте')+' '+periodLabel;
    $('salesCount').textContent=imported&&Number.isFinite(volume?.value)
      ?Number(volume.value).toLocaleString('ru-RU',{maximumFractionDigits:3})+(volume.unit?' '+volume.unit:'')
      :imported&&r.operation_identity?.total_rows>0?number(r.operation_identity.total_rows):'—';
    $('salesCaption').textContent=Number.isFinite(volume?.value)?volume.caption:'Число строк за выбранный период, включая возвраты. Количество отдельных единиц не указано.';
    $('averageLabel').textContent=r?.operation_identity?.estimated?'Средняя сумма (оценка)':'Средний чек';
    $('averageTicket').textContent=imported&&r.average_receipt_kopecks!==null?fmtK(r.average_receipt_kopecks):'—';
    $('averageCaption').textContent=r?.operation_identity?.estimated?'Без ID: на условную группу записей за день':'Сумма '+periodLabel+' / число чеков';
    $('topTitle').textContent=r?.company?.industry==='clinic'?'Топ-3 услуги':
      r?.company?.industry==='store'?'Топ-3 товара':
      r?.company?.industry==='auto'?'Топ-3 работы':'Топ-3 позиции';
    const top=imported?(r.top3||[]).filter(x=>x.amount_kopecks>0):[];
    $('topItems').closest('.panel').querySelector('.section-muted').textContent='По сумме '+shortMetric.toLowerCase()+' '+periodLabel;
    const highest=top.length?top[0].amount_kopecks:1;
    $('topItems').innerHTML=top.length?top.map((x,i)=>'<div><div class="top-row-head"><strong title="'+escapeHTML(x.item)+'">'+(i+1)+'. '+escapeHTML(x.item)+'</strong><span>'+fmtK(x.amount_kopecks)+'</span></div><div class="progress-track"><div class="progress-fill" style="width:'+Math.max(0,x.amount_kopecks/highest*100).toFixed(1)+'%;opacity:'+(1-i*.14)+'"></div></div></div>').join(''):'<p class="small-muted">Позиции появятся после загрузки CSV или Excel.</p>';
    chart(values,dates);
    $('chartCaption').textContent=verified?shortMetric+' '+(r?.chart_granularity==='month'?'по месяцам':r?.chart_granularity==='week'?'по неделям':'по дням')+'. Возвраты и исправления учтены.':
      'Суммы из отчёта по выбранному периоду. Тип денег не уточнён.';
    const bad=[],good=[];
    if(imported&&change!==null&&change<0)bad.push({title:shortMetric+' — снижение',desc:'Изменение к прошлым 30 дням: '+String(change).replace('.',',')+'%. Проверьте полноту выгрузки.'});
    if(imported&&change!==null&&change>0)good.push({title:shortMetric+' — рост',desc:'Рост к предыдущим 30 дням: +'+String(change).replace('.',',')+'%.'});
    if(imported&&top.length&&!good.length)good.push({title:'Лидер по объёму — '+top[0].item,desc:'Сумма '+periodLabel+': '+fmtK(top[0].amount_kopecks)+'. Лидер по выручке не обязательно самый прибыльный. Для рекомендаций нужен анализ ИИ.'});
    if(imported&&r.coverage&&!r.coverage.comparable)bad.push({title:'Недостаточно данных для сравнения',desc:'Для корректного сравнения нужны операции за оба выбранных периода одинаковой длины.'});
    if(!bad.length)bad.push({title:'Начните с загрузки отчёта',desc:'Выберите CSV или Excel (.xlsx) с датой, суммой и названиями товаров или услуг.'});
    if(!good.length)good.push({title:'Показатели появятся здесь',desc:'После загрузки CSV или Excel увидите результаты и изменения.'});
    const ai=state.mineAI;
    // Do not display preliminary KPI-based suggestions as though the AI
    // recommendations were already ready.
    const aiPending=imported&&!adminView&&(!ai||ai.status==='pending');
    const ready=imported&&ai?.status==='ready'&&ai.analysis&&
      ai.primary_basis===r?.primary_basis&&ai.period_key===(r?.period?.from+'_'+r?.period?.to);
    if(ready){
      const asItem=x=>({
        title:x.title,
        desc:[x.explanation,...(x.evidence||[])].join(' '),
        recommendation:x.recommendation
      });
      bad.splice(0,bad.length,...ai.analysis.issues.map(asItem));
      good.splice(0,good.length,...ai.analysis.positives.map(asItem));
      if(!good.length)good.push({title:'Пока нет заметных положительных изменений',desc:'По загруженным данным пока нельзя уверенно выделить положительные изменения.'});
    }
    for(const [id] of [['concerns'],['positives']]){
      const chip=$(id).closest('.panel')?.querySelector('.subtle-chip');
      if(chip)chip.textContent=ready?'Анализ OpenAI':aiPending?'Идёт анализ':imported&&ai?.status==='disabled'?'OpenAI не подключён':imported&&ai?.status==='error'?'Ошибка анализа OpenAI':'Базовые показатели';
    }
    const pendingHTML='<div class="bp-ai-pending" role="status"><span class="bp-ai-pending-dot" aria-hidden="true"></span>Идёт анализ</div>';
    $('concerns').innerHTML=aiPending?pendingHTML:insightHTML(bad.slice(0,3),true);
    $('positives').innerHTML=aiPending?pendingHTML:insightHTML(good.slice(0,2),false);
    $('warningBanner').classList.toggle('show',!!state.mineError);
    $('warningBanner').textContent=state.mineError||'';
    $('bottomDataTitle').textContent=imported?'Данные сохранены. Новые отчёты дополняют историю.':(loading?'Получаем показатели…':state.mineError?'Не удалось получить сохранённые данные.':'Загрузите первый отчёт вашей компании.');
    $('bottomDataHint').textContent=imported?'Последняя загрузка: '+r.source.name+'. Всего операций в базе: '+number(r.source.rows)+'. Новые файлы дополняют историю.':state.mineError?'Сохранённые операции не удалены. Повторите запрос, когда соединение восстановится.':'Загрузите CSV или Excel (.xlsx). Выбранные поля операций сохраняются на сервере.';
    if(imported){
      if(state.mineImportStats){
        const x=state.mineImportStats;
        $('bottomDataHint').textContent+=' Последний импорт: +'+number(x.added)+' новых, '+number(x.updated)+' исправлено'+(x.deleted?', '+number(x.deleted)+' отменено':'')+', '+number(x.unchanged)+' без изменений.';
        if(!x.added&&!x.updated&&!x.deleted){
          $('bottomDataTitle').textContent='Новых изменений нет: эти операции уже загружены.';
          $('bottomDataHint').textContent+=' Повторная загрузка не дублирует операции и не меняет прежние суммы.';
        }
        if(r.primary_basis==='unverified'){
          $('bottomDataHint').textContent+=' Смысл сумм не подтверждён: они показаны в блоке «Нужно уточнить данные», отдельно от оплат и продаж.';
        }
        if(state.mineTemplateNotice)$('bottomDataHint').textContent+=state.mineTemplateNotice;
      }
      const message=ready?' Выводы готовы.':ai?.status==='pending'?' Готовим выводы по загруженным данным…':ai?.status==='not_generated'?' Сохранённого AI-анализа для этого периода нет. В административном просмотре новый анализ не запускается.':ai?.status==='disabled'?' Автоматические выводы недоступны, но основные показатели рассчитаны.':ai?.status==='error'?' Автоматические выводы временно недоступны. Основные показатели рассчитаны.':'';
      $('bottomDataHint').textContent+=message;
    }
    if(adminView&&noData){empty.querySelector('h2').textContent='У компании пока нет загруженных данных';empty.querySelector('p').textContent='Показатели появятся после загрузки отчёта владельцем компании.';}
    $('clearImport').hidden=true;
    document.querySelector('.side-foot').textContent='Личные данные компании';
    activeTab();
    updateQuickButton();
  }
  async function loadMine(){
    state.mineLoading=true;
    state.mineError='';
    if(state.business==='mine')renderMine();
    try{
      state.mineReport=await request('/report?'+periodQuery()+(state.mineViewBasis?'&basis='+state.mineViewBasis:''));
      state.mineCompany=state.mineReport?.company;
      state.mineStoredRows=state.mineReport?.source?.rows??0;
    }catch(error){
      state.mineError=error.message||'Не удалось получить данные.';
      if(error.status===402||error.status===401){
        state.mineReport=null;
        state.mineSubscription=null;
        if(error.status===402)try{
          const me=await request('/me');
          state.mineSubscription=me.subscription;
          state.mineCompany=me.company;
          state.mineStoredRows=me.stored_operations??0;
        }catch{}
      }
    }
    finally{state.mineLoading=false;if(state.business==='mine')renderMine();if(state.mineReport?.source)void loadAI();if(!tg.initData)void showLinkStatus();}
  }

  const intro=document.querySelector('.modal-intro');
  const localIntro=intro.textContent;
  function refreshIntro(){
    intro.textContent=state.business==='mine'
      ?'Выберите Excel или CSV. Бизнес Пульс сам определит показатели и подготовит аналитику. Если в данных будет неоднозначность, сервис попросит уточнение.'
      :'Файл обрабатывается только в браузере, на сервер не отправляется. Все данные демокомпаний остаются локальными.';
  }
  ['openImport','sideImport'].forEach(id=>{
    $(id).addEventListener('click',event=>{
      if(!canImport()){
        event.preventDefault();event.stopImmediatePropagation();
        showModal(false);renderMine();
      }
    },true);
    $(id).addEventListener('click',refreshIntro);
  });
  $('fileInput').addEventListener('change',event=>{
    if(!canImport()){event.stopImmediatePropagation();$('fileInput').value='';showModal(false);renderMine();}
  },true);
  $('dropZone').addEventListener('drop',event=>{
    if(!canImport()){event.preventDefault();event.stopImmediatePropagation();showModal(false);renderMine();}
  },true);
  setInterval(()=>{
    if(state.business==='mine'&&!companySubscription()?.access){
      if($('modal').classList.contains('show'))showModal(false);
      renderMine();
    }
  },30000);
  // Financial classification is explicit: field names alone cannot prove
  // whether a sum was collected or earned. Historical data stays unverified.
  const bookChoice=document.createElement('section');
  bookChoice.hidden=true;
  bookChoice.className='import-preview';
  bookChoice.style.cssText='margin:12px 0';
  bookChoice.innerHTML=
    '<label for="financialBookSelect" style="display:block;font-size:13px;font-weight:800;margin-bottom:8px">Что означают суммы в этом файле?</label>'+
    '<select id="financialBookSelect" style="width:100%;min-height:43px;background:white;color:#29334f;border:1px solid #cfd5e5;border-radius:10px;padding:9px;font-size:13px">'+
    '<option value="">Выберите, что означают суммы</option>'+
    '<option value="unverified">Не знаю, что за суммы — сохранить отдельно</option>'+
    '<option value="cash_receipts">Полученные деньги (включая авансы)</option>'+
    '<option value="recognized_revenue">Продажи: оказанные услуги и проданные товары</option>'+
    '<option value="paid_fulfilled">Оплачено и продано одновременно (кафе / магазин)</option>'+
    '</select>'+
    '<div id="financialBookHelp" style="margin-top:7px;font-size:12px;line-height:1.5;color:#66718a"></div>'+
    '<label id="earnedConfirmLabel" hidden style="display:flex;align-items:flex-start;gap:9px;margin-top:10px;font-size:12px">'+
    '<input type="checkbox" id="earnedConfirm" style="flex:none;margin-top:2px;accent-color:#625fea">'+
    '<span>Подтверждаю: услуги уже оказаны или товары переданы. Просто выставленные счета и авансы за будущие услуги не включены.</span></label>';
  $('financialPanel').before(bookChoice);
  bookChoice.hidden=true; // Financial meaning is resolved server-side; no mandatory selector.
  const bookSelect=$('financialBookSelect'),earnedConfirm=$('earnedConfirm');
  const earnedConfirmLabel=$('earnedConfirmLabel'),bookHelp=$('financialBookHelp');
  const bothOption=bookSelect.querySelector('option[value="paid_fulfilled"]');
  function refreshBothOption(){
    const industry=(state.mineReport?.company||state.mineCompany)?.industry;
    bothOption.hidden=!['cafe','store'].includes(industry);
    bothOption.disabled=bothOption.hidden;
    if(bothOption.hidden&&bookSelect.value==='paid_fulfilled')bookSelect.value='';
  }
  function basisConflict(){
    if(!state.fileTable)return '';
    const local=window.BP_SmartImport?.financialSemantics(state.fileTable.head,mapping());
    if(bookSelect.value==='recognized_revenue'&&local?.basis==='cash_receipts')
      return 'Здесь указаны оплаты. Нельзя считать их продажами без данных об оказанных услугах или переданных товарах.';
    if(bookSelect.value==='cash_receipts'&&local?.basis==='reported_revenue')
      return 'Здесь указана стоимость продаж. Для поступлений выберите суммы реально полученных оплат.';
    if(bookSelect.value==='paid_fulfilled'){
      if(bothOption.disabled)return 'Совмещённый тип доступен только для кафе и магазина.';
      if(local?.basis==='reported_revenue')
        return 'Отчёт показывает продажи, но не подтверждает получение денег. Выберите «Продажи» или выгрузите оплаченные чеки.';
      if(/аванс|предоплат|долг|задолж|дебитор|начислен|сч[её]т к оплате/i.test(state.fileTable.head.join(' ')))
        return 'В отчёте есть признаки авансов, начислений или долгов. Нельзя автоматически признать такие суммы оплаченными и проданными.';
      if(correctionMode.checked)return 'Для исправления чеков выберите один финансовый тип. Совмещённый режим доступен при обычной загрузке.';
    }
    return '';
  }
  function validateBookChoice(){
    refreshBothOption();
    const combined=bookSelect.value==='paid_fulfilled';
    const earned=bookSelect.value==='recognized_revenue'||combined;
    earnedConfirmLabel.hidden=!earned;
    earnedConfirmLabel.querySelector('span').textContent=combined
      ?'Подтверждаю: все включённые чеки полностью оплачены, заказы уже выданы, авансов, неоплаченных заказов и будущих услуг нет. Одна операция попадёт в оба показателя без удвоения общей базы.'
      :'Подтверждаю: услуги уже оказаны или товары переданы. Просто выставленные счета и авансы за будущие услуги не включены.';
    bookHelp.textContent=!bookSelect.value
      ?'Уточните тип суммы. Полученные оплаты попадут в поступления, выполненные продажи — в продажи. Без выбора загрузка недоступна.'
      :combined
      ?'Для полностью оплаченных и выданных заказов кафе или магазина. Одна операция учитывается отдельно в показателях оплат и продаж, а не дважды в базе.'
      :earned
      ?'Стоимость уже оказанных услуг и переданных товаров — даже если клиент заплатит позже. Авансы за будущие услуги сюда не входят.'
      :bookSelect.value==='cash_receipts'
        ?'Все деньги, которые пришли в кассу или на счёт, включая авансы. Это не то же самое, что продажи.'
        :'Суммы попадут только в блок «Нужно уточнить данные». Поступления, продажи и аналитика по ним не изменятся.';
    const conflict=basisConflict();
    if(conflict)bookHelp.textContent=conflict;
    const approved=!!bookSelect.value&&(!earned||earnedConfirm.checked)&&!conflict;
    if(!approved&&state.business!=='mine')$('confirmImport').disabled=true;
    if(typeof correctionMode!=='undefined'&&correctionMode.checked)setCorrectionButton();
    return approved;
  }
  function inferCashBook(file){
    if(!file||!file.head)return;
    refreshBothOption();
    const semantic=window.BP_SmartImport?.financialSemantics(file.head,mapping());
    if(!bookSelect.dataset.manuallyChosen)
      bookSelect.value=semantic?.basis==='cash_receipts'?'cash_receipts':
        semantic?.basis==='reported_revenue'?'recognized_revenue':'unverified';
    earnedConfirm.checked=true;
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
    bookChoice.hidden=true;
    delete bookSelect.dataset.manuallyChosen;
    bookSelect.value='';
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
    if(parsed.rows.some(row=>row.synthetic_id))throw Error('Для режима исправлений нужны ID всех операций. Файл без ID можно загрузить обычным способом; при изменении детализации потребуется сверка.');
    if(parsed.invalid>0)throw Error('Исправьте '+parsed.invalid+' ошибочных строк: '+parsed.invalidExamples.join('; '));
    if(parsed.skipped>parsed.cancelled)
      throw Error('В выгрузке есть неоплаченные или ожидающие операции. В режиме исправлений нельзя пропускать такие строки незаметно. Уточните их статус и выгрузите только окончательные операции или явные отмены.');
    if(parsed.duplicate>0)throw Error('В файле есть одинаковые строки. Для сверки нужен уникальный ID каждого платежа.');
    const rows=parsed.rows.map(x=>({
      date:x.date,id:String(x.id),item:String(x.item),synthetic_id:x.synthetic_id,
      amount_kopecks:Math.round(x.amount*100),status:x.status,quantity_milli:x.quantity_milli??null,customer_ref:x.customer_ref,customer_ref_kind:x.customer_ref_kind
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
      (!['recognized_revenue','paid_fulfilled'].includes(bookSelect.value)||earnedConfirm.checked)&&!basisConflict()&&!financial?.blocked&&
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
    // Routine data changes are handled by the automatic comparison dialog.
    // Keep legacy cancellation tools out of the customer's upload flow.
    correctionsPanel.hidden=true;
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
  $('fileStatus').after(recognitionStatus);
  const retryRecognition=document.createElement('button');
  retryRecognition.id='retryRecognition';
  retryRecognition.className='ghost-btn import-recognition-retry';
  retryRecognition.type='button';
  retryRecognition.textContent='Повторить распознавание';
  retryRecognition.hidden=true;
  recognitionStatus.after(retryRecognition);
  let currentRecognition=null;

  function showImportReview(file,message){
    if(state.fileTable!==file||!$('modal').classList.contains('show'))return;
    $('mappingSection').hidden=false;
    $('confirmImport').hidden=false;
    $('confirmImport').disabled=false;
    recognitionMessage(message||'Если файл определён неверно, откройте дополнительные настройки.');
  }

  function tryAutomaticImport(file){
    if(!canImport()||state.fileTable!==file||file._bpUserAdjusted||
       file._bpAutoStarted||correctionMode.checked)return {ready:false,reason:'Требуется ручная проверка.'};
    try{
      demo.preview(file);
      const columns=mapping();
      const parsed=parseImported(file,columns);
      const financial=file._bpAiMappingAmount===columns.amount?file._bpAiFinancial:null;
      const decision=window.BP_SmartImport?.automaticDecision({
        file,mapping:columns,parsed,basis:bookSelect.value,financial
      });
      if(!decision?.ready)return decision||{ready:false,reason:'Нужно уточнить формат.'};
      if(!validateBookChoice())
        return {ready:false,reason:basisConflict()||'Нужно уточнить финансовый показатель.'};
      if(file._bpMultipleSheets){
        showImportReview(file,'Выбран первый лист. При необходимости выберите другой, затем нажмите «Применить данные».');
        return {ready:true,requiresClick:true};
      }
      file._bpAutoStarted=true;
      recognitionMessage('Файл распознан. Сохраняем данные и готовим аналитику…');
      // The existing submit handler performs the exact same validations,
      // accounting, chunking, deduplication and AI cache invalidation.
      void $('confirmImport').onclick();
      return {ready:true};
    }catch(error){
      return {ready:false,reason:error.message||'Не удалось проверить таблицу.'};
    }
  }

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
    recognitionMessage('Распознаём данные и проверяем показатели…');
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
          for(const key of ['date','amount','id','item','status','quantity','customer']){
            const select=$('col_'+key),column=answer.mapping[key];
            if(select&&Number.isInteger(column)&&column>=-1&&column<file.head.length){
              select.value=String(column);
            }
          }
          $('col_date').dispatchEvent(new Event('change'));
        }finally{file._bpApplying=false;}
        const automatic=tryAutomaticImport(file);
        if(!automatic.ready)showImportReview(file,'Нужно уточнить формат таблицы.');
      }else{
        const seconds=Number(answer?.retry_after_seconds)||0;
        const minutes=Math.max(1,Math.ceil(seconds/60));
        const automatic=tryAutomaticImport(file);
        if(!automatic.ready){
          const reason=answer?.reason==='limit'&&!answer?.can_retry
            ?'ИИ-проверка временно ограничена. Можно повторить через '+minutes+' мин. '
            :answer?.reason==='unrecognized'
              ?'Система не смогла однозначно распознать таблицу. '
              :answer?.reason==='unavailable'||answer?.reason==='disabled'
                ?'ИИ-распознавание сейчас недоступно. ':'';
          showImportReview(file,reason+'При необходимости откройте дополнительные настройки.');
          retryRecognition.hidden=!(needsAI&&answer?.can_retry===true);
        }
      }
    }catch(error){
      if(state.fileTable!==file||file._bpRecognitionAttempt!==attempt)return;
      console.warn('Import mapping lookup unavailable:',error.message);
      const automatic=tryAutomaticImport(file);
      if(!automatic.ready)showImportReview(file,'Не удалось автоматически определить все данные.');
      retryRecognition.hidden=automatic.ready;
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
    if(!file||state.business!=='mine')return;
    if(file.reportType==='aggregate'){
      showImportReview(file,'В этом листе обнаружена сводка вместо отдельных продаж. Выберите лист с данными.');
      return;
    }
    // Keep technical mapping and money confirmation out of the normal first-run flow.
    $('mappingSection').hidden=true;
    $('confirmImport').hidden=true;
    recognitionMessage('Распознаём таблицу…');
    const header=file.head;
    const statistical=window.BP_SmartImport?.guess(header,file.rows.slice(0,80))?.profiles;
    if(!Array.isArray(statistical)){
      showImportReview(file,'Не удалось проверить структуру таблицы.');
      return;
    }
    const profiles=statistical.map(p=>({
      dates:p.dates,nums:p.nums,statuses:p.statuses,unique:p.unique,
      words:p.words,zeroids:p.zeroids,filled:p.filled
    }));
    const missing=['date','amount'].some(k=>file.mappingGuess?.[k]<0);
    const ambiguous=Object.values(file.confidence||{}).some(v=>v==='неоднозначно'||v==='требует проверки');
    const localFinance=window.BP_SmartImport?.financialSemantics(header,file.mappingGuess);
    const financialAmbiguity=(localFinance?.flags?.length||0)>0 ||
      ['accrual','advance','debt','tax','unit_price'].includes(localFinance?.basis) ||
      /аванс|предоплат|депозит|задат|задолж|дебитор|долг|частичн|рассроч|зачет|зачёт|сторно|возврат|ндс|налог|начислен|акт выполненных/i.test(header.join(' '));
    // AI-first for unfamiliar exports. The server reuses company templates and
    // cached suggestions, so repeated uploads do not spend tokens again.
    const needsAI=true;
    const work={file,profiles,needsAI};
    currentRecognition=work;
    void resolveRecognition(work);
  });
  const differenceNotice=$('importDifferenceNotice'),allowChanges=$('importAllowChanges');
  const importDetails=$('importAdvanced');
  function clearComparison(){
    differenceNotice.hidden=true;
    allowChanges.checked=false;
    $('importDifferenceDetails').hidden=true;
    $('importDifferenceDetails').textContent='';
    $('importInspectChanges').textContent='Проверить изменения';
    if(state.fileTable)state.fileTable._bpPreflight=null;
  }
  document.addEventListener('bp:import-table-ready',()=>{
    clearComparison();
    importDetails.open=false;
    $('importActionError').hidden=true;
    $('importActionError').textContent='';
  });
  $('importInspectChanges').onclick=()=>{
    const details=$('importDifferenceDetails');
    details.hidden=!details.hidden;
    $('importInspectChanges').textContent=details.hidden?'Проверить изменения':'Скрыть изменения';
  };
  function showComparison(file,stats){
    differenceNotice.hidden=false;
    const corrections=stats.updated>0
      ?'В ранее загруженных данных обнаружены изменения: '+number(stats.updated)+' строк. ':'';
    const cancelled=file._bpCancelledCount>0
      ?'В файле есть отменённые записи: '+number(file._bpCancelledCount)+'. Ранее сохранённые строки не удаляются. ':'';
    const missing=stats.possible_missing>0
      ?'За те же даты есть '+number(stats.possible_missing)+' ранее сохранённых строк, которых нет в новом файле. Они не удаляются. ':'';
    $('importDifferenceText').textContent=corrections+cancelled+missing+
      'Новые строки добавятся, совпадающие не продублируются.';
    $('importDifferenceDetails').textContent=(stats.examples||[]).map(x=>
      x.date+' · '+x.item+' · '+money(x.previous_amount_kopecks/100)+' → '+money(x.new_amount_kopecks/100)
    ).join('\n');
    allowChanges.checked=false;
    file._bpAutoStarted=false;
    $('confirmImport').hidden=false;
    $('confirmImport').disabled=false;
    recognitionMessage('Проверьте предупреждение перед загрузкой.');
  }
  function showImportIssue(message){
    $('confirmImport').hidden=false;
    $('confirmImport').disabled=false;
    $('mappingSection').hidden=false;
    const error=$('importActionError');
    error.textContent=message;
    error.hidden=false;
    error.style.cssText='color:#b42318;background:#fff1f0;border:1px solid #e39b93;border-radius:9px;padding:10px;font-size:12px;line-height:1.5;flex-basis:100%';
    importDetails.open=true;
    let focus= /дата|дату/i.test(message)?$('col_date'):
      /сумм|денежн|стоимост|выруч/i.test(message)?$('col_amount'):
      /количеств/i.test(message)?$('col_quantity'):
      $('mappingFields');
    if(focus&&focus.classList)focus.classList.add('bp-import-error-field');
    if(focus?.scrollIntoView)focus.scrollIntoView({behavior:'smooth',block:'center'});
    if(focus?.focus&&focus.tagName==='SELECT')focus.focus({preventScroll:true});
  }
  async function compareImport(file,columns,basis,rows){
    const fingerprint=JSON.stringify([columns,basis,file._bpRecognitionAttempt||0,rows.length]);
    if(file._bpPreflight?.fingerprint===fingerprint)return file._bpPreflight.stats;
    const combined={added:0,updated:0,unchanged:0,received:0,possible_missing:0,examples:[]};
    for(let i=0;i<rows.length;i+=5000){
      const answer=await request('/import/compare',{
        source:file.name.slice(0,120),financial_basis:basis,
        source_headers:file.head.slice(0,80),amount_index:columns.amount,
        check_missing:rows.length<=5000,
        rows:rows.slice(i,i+5000)
      });
      if(state.fileTable!==file)throw Error('Выбран другой лист. Повторите загрузку.');
      const stats=answer.stats||{};
      for(const k of ['received','added','updated','unchanged','possible_missing'])combined[k]+=Number(stats[k]||0);
      combined.examples.push(...(stats.examples||[]).slice(0,Math.max(0,5-combined.examples.length)));
    }
    file._bpPreflight={fingerprint,stats:combined};
    return combined;
  }

  const originalConfirm=$('confirmImport').onclick;
  $('confirmImport').onclick=async()=>{
    if(state.business!=='mine'){intro.textContent=localIntro;return originalConfirm();}
    if(state.mineSaving)return;
    let submitError='';
    try{
      requireImportAccess();
      const columns=mapping();
      const financial=state.fileTable?._bpFinancialReview;
      if(financial?.blocked)throw Error('В этом столбце не сумма полученных денег или выполненных продаж. Выберите подходящую сумму.');
      if(financial?.needsConfirm&&!$('financialConfirm').checked){
        throw Error('Проверьте замечания к суммам и подтвердите их перед загрузкой.');
      }
      const file=state.fileTable;
      if(!file)throw Error('Сначала выберите файл.');
      const isCorrection=correctionMode.checked;
      const result=parseImported(file,columns);
      // Cancelled lines are not deletions. Keep prior values and warn before saving
      // the other valid rows; partial exports must never delete missing entries.
      file._bpCancelledCount=isCorrection?0:result.cancelled;
      if(result.invalid>0)throw Error('Обнаружено '+result.invalid+' строк с ошибками: '+result.invalidExamples.join('; ')+'. Исправьте данные перед загрузкой.');
      if(!result.rows.length&&!(isCorrection&&result.cancelled_ids.length))
        throw Error('Нет корректных оплаченных операций для импорта.');
      if(result.rows.length>100000)throw Error('В одном файле можно загрузить до 100 000 операций. Разделите отчёт на несколько файлов.');
      const occurrenceCounts=new Map();
      const orderedRows=[...result.rows.filter(row=>!row.synthetic_id),...result.rows.filter(row=>row.synthetic_id)
        .sort((a,b)=>Math.round(a.amount*100)-Math.round(b.amount*100)||(a.quantity_milli??0)-(b.quantity_milli??0))];
      const rows=orderedRows.map(x=>{
        const date=x.date,id=String(x.id),item=String(x.item),status=x.status;
        const ref=window.BP_SmartImport.normalizeCustomerRef(x.customer_ref,x.customer_ref_kind);
        const group=JSON.stringify([date,x.synthetic_id?(ref?[x.customer_ref_kind,ref]:null):id.trim(),item.trim(),status]);
        const occurrence=occurrenceCounts.get(group)||0;
        occurrenceCounts.set(group,occurrence+1);
        return {date,id,item,synthetic_id:x.synthetic_id,amount_kopecks:Math.round(x.amount*100),status,
          quantity_milli:x.quantity_milli??null,customer_ref:x.customer_ref,customer_ref_kind:x.customer_ref_kind,occurrence};
      });
      if(rows.some(x=>!Number.isSafeInteger(x.amount_kopecks)||x.amount_kopecks===0||Math.abs(x.amount_kopecks)>1e12))throw Error('Некорректные суммы: проверьте нулевые и слишком большие значения.');
      // Automatic server-side classification from the mapped amount header.
      // Unknown source semantics remain unverified, never guessed as sales.
      if(!validateBookChoice())
        throw Error(basisConflict()||'Выбран неподходящий денежный столбец.');
      const financialBasis=bookSelect.value;
      const correctionData=isCorrection?correctionPayload():null;
      if(isCorrection&&(!checkedCorrection||checkedCorrection.file!==state.fileTable||
          !correctionApprove.checked||
          JSON.stringify(correctionData)!==checkedCorrection.payloadText||
          Date.now()>=checkedCorrection.expires_at_ms)){
        throw Error('Сначала проверьте исправления и подтвердите список изменений.');
      }
      if(!isCorrection){
        // The comparison is read-only. Only real changes to previously
        // imported values require the owner's explicit opt-in.
        state.mineSaving=true;
        $('confirmImport').disabled=true;
        $('importAlert').textContent='Сравниваем с загруженными данными…';
        const differences=await compareImport(file,columns,financialBasis,rows);
        if((differences.updated>0||differences.possible_missing>0||file._bpCancelledCount>0)&&!allowChanges.checked){
          showComparison(file,differences);
          $('importAlert').textContent='';
          return;
        }
        differenceNotice.hidden=true;
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
      let answer;
      if(isCorrection){
        answer=await request('/import/corrections/apply',{
          ...correctionData,confirm_token:checkedCorrection.confirm_token,
          expires_at_ms:checkedCorrection.expires_at_ms
        });
      }else{
        const batchSize=5000,parts=Math.ceil(rows.length/batchSize);
        const combined={received:0,added:0,updated:0,unchanged:0,deleted:0,total:0};
        for(let part=0;part<parts;part++){
          $('importAlert').textContent='Сохраняем отчёт: пакет '+(part+1)+' из '+parts+
            ' · '+Math.min(rows.length,(part+1)*batchSize)+' / '+rows.length+' строк.';
          try{
            answer=await request('/import',{
              source:state.fileTable.name.slice(0,120),
              financial_basis:financialBasis,
              source_headers:state.fileTable.head.slice(0,80),
              amount_index:columns.amount,
              confirm_paid_fulfilled:false,
              more_chunks:part<parts-1,
              rows:rows.slice(part*batchSize,(part+1)*batchSize)
            });
          }catch(error){
            const saved=combined.received;
            throw Error((saved?'Сохранено '+saved+' строк, дальнейшая загрузка остановлена. ':'')+
              error.message+' Повторно загрузите этот же файл: уже записанные операции не задвоятся.');
          }
          const stats=answer.stats||{};
          for(const key of ['received','added','updated','unchanged','deleted'])combined[key]+=Number(stats[key]||0);
          combined.total=stats.total||combined.total;
        }
        answer.stats=combined;
      }
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
      state.mineImportStats={...(answer.stats||{}),skipped:result.skipped,duplicate:result.duplicate,cancelled:result.cancelled};
      state.mineViewBasis=answer.stats?.financial_basis==='paid_fulfilled'?'cash_receipts':
        ['cash_receipts','recognized_revenue'].includes(answer.stats?.financial_basis)?
          answer.stats.financial_basis:null;
      state.mineTemplateNotice+=(answer.classification?' '+answer.classification:'');
      try{
        state.mineReport=await request('/report?'+periodQuery()+'&basis='+state.mineViewBasis);
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
      if(state.fileTable?._bpAutoStarted)state.fileTable._bpAutoStarted=false;
      if($('modal').classList.contains('show'))showImportIssue(message);
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

  window.addEventListener('bp:payment-confirmed',()=>void loadMine());
  // Signed users enter their own workspace; demo is explicitly separate.
  state.business='mine';
  renderMine();
  loadMine();
})();

