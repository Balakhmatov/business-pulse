'use strict';
(function(){
  const root='https://pulse.cityai.site/api';
  const tg=window.Telegram?.WebApp;
  const isTelegram=Boolean(tg?.initData);
  const plans=[
    {id:'month',name:'1 месяц',price:2490,detail:'Стандартная подписка'},
    {id:'halfyear',name:'6 месяцев',price:9990,detail:'−33% · экономия 4 950 ₽'},
    {id:'year',name:'12 месяцев',price:17990,detail:'−40% · экономия 11 890 ₽'}
  ];
  const button=document.createElement('button');button.type='button';button.className='bp-pay-toggle';button.textContent='Оплата';button.setAttribute('aria-haspopup','dialog');
  const dialog=document.createElement('dialog');dialog.className='bp-pay-dialog';dialog.setAttribute('aria-labelledby','bp-pay-title');
  // All interpolated strings below are fixed product copy, never server HTML.
  dialog.innerHTML='<div class="bp-pay-head"><div><span class="bp-pay-kicker">Подписка на компанию</span><h2 id="bp-pay-title">Выберите тариф</h2></div><button type="button" class="bp-pay-close" aria-label="Закрыть">×</button></div>'+
    '<p class="bp-pay-intro">Руководитель и сотрудник работают с общими данными. Автосписаний нет.</p>'+
    '<label class="bp-pay-accept"><input type="checkbox"><span>Принимаю <a href="./legal/offer.html" target="_blank" rel="noopener">оферту и пользовательское соглашение</a>, ознакомлен с <a href="./legal/tariffs.html" target="_blank" rel="noopener">тарифами</a> и <a href="./legal/refunds.html" target="_blank" rel="noopener">порядком возвратов</a>.</span></label>'+
    '<p class="bp-pay-status" role="status">Загружаем способы оплаты…</p><div class="bp-pay-cards"></div>'+
    '<p class="bp-pay-note">Для вашей компании будет создан отдельный СБП-платёж ЮKassa. После оплаты подписка подключится автоматически.</p>'+
    '<a class="bp-pay-support" href="https://t.me/business_pulse_app_bot?start=support">Поддержка</a>'+
    '<p class="bp-pay-trial">48 часов бесплатно с момента подключения компании.</p>';
  const footer=document.getElementById('bpPaymentFooter')||document.createElement('footer');
  if(!footer.id){footer.id='bpPaymentFooter';footer.className='bp-payment-footer';(document.querySelector('main')||document.body).append(footer);}
  footer.prepend(button);document.body.append(dialog);
  const cards=dialog.querySelector('.bp-pay-cards'),status=dialog.querySelector('[role="status"]'),accept=dialog.querySelector('input');
  const controls=new Map();let chosen=null,loading=false,paying=false,available=false;
  for(const p of plans){
    const card=document.createElement('article');card.className='bp-pay-card';
    const title=document.createElement('h3');title.textContent=p.name;
    const price=document.createElement('strong');price.className='bp-pay-price';price.textContent=p.price.toLocaleString('ru-RU')+' ₽';
    const detail=document.createElement('p');detail.textContent=p.detail;
    const note=document.createElement('small');note.textContent=p.note||'Оплата за весь выбранный период';
    const pay=document.createElement('button');pay.type='button';pay.className='bp-pay-submit';pay.textContent='Оплатить по СБП';pay.disabled=true;
    card.append(title,price,detail,note,pay);cards.append(card);controls.set(p.id,{card,pay,url:null});
    pay.addEventListener('click',async()=>{
      if(!accept.checked||paying||!available||!isTelegram)return;
      paying=true;update();status.textContent='Создаём платёж для вашей компании…';
      try{
        const r=await fetch(root+'/payments',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Init-Data':tg.initData},body:JSON.stringify({plan:p.id,accepted_terms:true}),signal:AbortSignal.timeout(25000)});
        const data=await r.json();if(!r.ok)throw Error(data.error||'Не удалось создать платёж.');
        if(data.payment.status==='succeeded'){status.textContent='Оплата подтверждена. Подписка активна.';return;}
        const url=validURL(data.payment.payment_url);if(!url)throw Error('Платёж проверяется. Обратитесь в поддержку.');
        status.textContent='Завершите оплату в ЮKassa. Подписка подключится автоматически.';
        if(typeof tg.openLink==='function')tg.openLink(url);else window.location.assign(url);
      }catch(e){status.textContent=e.message||'Не удалось создать платёж. Попробуйте ещё раз.';}
      finally{paying=false;update();}
    });
  }
  function update(){for(const c of controls.values())c.pay.disabled=paying||!accept.checked||!available||!isTelegram||c.card.hidden;}

  accept.addEventListener('change',()=>{update();if(available)status.textContent=accept.checked?'Выберите тариф для оплаты.':'Поставьте галочку принятия условий — кнопки оплаты станут доступны.';});
  const validURL=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&['yookassa.ru','yoomoney.ru'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h))?u.href:null;}catch{return null;}};
  async function load(){
    if(loading)return;loading=true;status.textContent='Загружаем способы оплаты…';
    available=false;update();
    try{
      const response=await fetch(root+'/prices',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('catalog');const data=await response.json();
      let subscription=null;
      if(isTelegram){
        const r=await fetch(root+'/payments/refresh',{method:'POST',headers:{'X-Telegram-Init-Data':tg.initData},signal:AbortSignal.timeout(25000)});
        if(!r.ok)throw Error('subscription');subscription=(await r.json()).subscription;
      }
      available=data.payments_available===true&&Boolean(subscription);
      status.textContent=!isTelegram?'Для оплаты откройте приложение через Telegram-бота.':available?'Поставьте галочку принятия условий — кнопки оплаты станут доступны.':'Оплата пока недоступна. Напишите в поддержку.';
      chosen=null;
      update();
    }catch{status.textContent='Не удалось загрузить оплату. Закройте окно и попробуйте ещё раз или напишите в поддержку.';}
    finally{loading=false;}
  }
  async function refreshPayment(){
    if(!dialog.open||!isTelegram||paying||loading)return;
    try{const r=await fetch(root+'/payments/refresh',{method:'POST',headers:{'X-Telegram-Init-Data':tg.initData},signal:AbortSignal.timeout(20000)});if(r.ok&&(await r.json()).subscription?.state==='paid')status.textContent='Оплата подтверждена. Подписка активна.';}catch{}
  }
  window.addEventListener('focus',()=>void refreshPayment());
  setInterval(()=>void refreshPayment(),30000);
  function open(plan){chosen=typeof plan==='string'?plan:null;if(!dialog.open){accept.checked=false;dialog.showModal();}void load();}
  button.addEventListener('click',()=>open());
  dialog.querySelector('.bp-pay-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  document.addEventListener('click',e=>{const trigger=e.target.closest('[data-bp-pay]');if(trigger){e.preventDefault();open(trigger.dataset.bpPay);}});
  window.BP_Payments={open};
  const launchParams=new URLSearchParams(window.location.search);
  const hashParams=new URLSearchParams(window.location.hash.slice(1));
  const paymentRequested=document.body.dataset.bpPaymentPage==='true'||launchParams.get('view')==='payment'||
    launchParams.get('tgWebAppStartParam')==='payment'||hashParams.get('tgWebAppStartParam')==='payment'||
    tg?.initDataUnsafe?.start_param==='payment';
  if(paymentRequested)open();
})();
