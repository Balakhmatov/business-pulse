'use strict';
(function(){
  const root='https://pulse.cityai.site/api';
  const tg=window.Telegram?.WebApp;
  const isTelegram=Boolean(tg?.initData);
  const plans=[
    {id:'month',name:'1 месяц',price:2490,detail:'Стандартная подписка'},
    {id:'welcome',name:'Первый месяц',price:1990,detail:'Вместо 2 490 ₽ · −20% · экономия 500 ₽',note:'Только при первой оплате в течение тестовых 48 часов'},
    {id:'halfyear',name:'6 месяцев',price:9990,detail:'−33% · экономия 4 950 ₽'},
    {id:'year',name:'12 месяцев',price:17990,detail:'−40% · экономия 11 890 ₽'}
  ];
  const button=document.createElement('button');button.type='button';button.className='bp-pay-toggle';button.textContent='Оплата';button.setAttribute('aria-haspopup','dialog');
  const dialog=document.createElement('dialog');dialog.className='bp-pay-dialog';dialog.setAttribute('aria-labelledby','bp-pay-title');
  // All interpolated strings below are fixed product copy, never server HTML.
  dialog.innerHTML='<div class="bp-pay-head"><div><span class="bp-pay-kicker">Подписка на компанию</span><h2 id="bp-pay-title">Выберите тариф</h2></div><button type="button" class="bp-pay-close" aria-label="Закрыть">×</button></div>'+
    '<p class="bp-pay-intro">Руководитель и сотрудник работают с общими данными. Автосписаний нет.</p><div class="bp-pay-cards"></div>'+
    '<p class="bp-pay-status" role="status">Загружаем способы оплаты…</p>'+
    '<label class="bp-pay-accept"><input type="checkbox"><span>Принимаю <a href="./legal/offer.html" target="_blank" rel="noopener">оферту и пользовательское соглашение</a>, ознакомлен с <a href="./legal/tariffs.html" target="_blank" rel="noopener">тарифами</a> и <a href="./legal/refunds.html" target="_blank" rel="noopener">порядком возвратов</a>.</span></label>'+
    '<p class="bp-pay-note">Оплата откроется на защищённой странице ЮKassa. Выберите СБП, если она доступна. Подписку подтвердим после проверки поступления денег. Для привязки платежа к компании сообщите об оплате через поддержку бота.</p>'+
    '<a class="bp-pay-support" href="https://t.me/business_pulse_app_bot?start=support">Сообщить об оплате / поддержка</a>'+
    '<p class="bp-pay-trial">48 часов бесплатно с момента подключения компании.</p>';
  document.body.append(button,dialog);document.body.classList.add('bp-has-payment');
  const cards=dialog.querySelector('.bp-pay-cards'),status=dialog.querySelector('[role="status"]'),accept=dialog.querySelector('input');
  const controls=new Map();let chosen=null,loading=false;
  for(const p of plans){
    const card=document.createElement('article');card.className='bp-pay-card';
    const title=document.createElement('h3');title.textContent=p.name;
    const price=document.createElement('strong');price.className='bp-pay-price';price.textContent=p.price.toLocaleString('ru-RU')+' ₽';
    const detail=document.createElement('p');detail.textContent=p.detail;
    const note=document.createElement('small');note.textContent=p.note||'Оплата за весь выбранный период';
    const pay=document.createElement('button');pay.type='button';pay.className='bp-pay-submit';pay.textContent='Оплатить по СБП';pay.disabled=true;
    card.append(title,price,detail,note,pay);cards.append(card);controls.set(p.id,{card,pay,url:null});
    pay.addEventListener('click',()=>{
      const c=controls.get(p.id);if(!accept.checked||!c.url)return;
      status.textContent='После оплаты сообщите о платеже через поддержку — так мы подключим нужную компанию.';
      if(tg&&typeof tg.openLink==='function')tg.openLink(c.url);
      else window.open(c.url,'_blank','noopener,noreferrer');
    });
  }
  function update(){for(const c of controls.values())c.pay.disabled=!accept.checked||!c.url||c.card.hidden;}
  accept.addEventListener('change',update);
  const validURL=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&['yookassa.ru','yoomoney.ru'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h))?u.href:null;}catch{return null;}};
  async function load(){
    if(loading)return;loading=true;status.textContent='Загружаем способы оплаты…';
    for(const c of controls.values()){c.url=null;c.pay.disabled=true;}
    try{
      const response=await fetch(root+'/prices',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('catalog');const data=await response.json();
      let subscription=null;
      if(isTelegram){
        try{const r=await fetch(root+'/subscription',{headers:{'X-Telegram-Init-Data':tg.initData},cache:'no-store',signal:AbortSignal.timeout(10000)});if(r.ok)subscription=(await r.json()).subscription;}catch{}
      }
      // Promo eligibility is confirmed from signed account state, never URL params.
      const welcome=controls.get('welcome');welcome.card.hidden=isTelegram&&!subscription?.promo_available;
      let available=0;
      for(const p of data.plans||[]){const c=controls.get(p.id),expected=plans.find(x=>x.id===p.id);if(!c||p.price!==expected.price)continue;c.url=validURL(p.payment_url);if(c.url&&!c.card.hidden)available++;}
      status.textContent=available?'Выберите тариф и примите условия перед оплатой.':'Оплата пока недоступна. Напишите в поддержку.';
      if(chosen){controls.get(chosen)?.card.scrollIntoView({block:'nearest'});chosen=null;}
      update();
    }catch{status.textContent='Не удалось загрузить оплату. Закройте окно и попробуйте ещё раз или напишите в поддержку.';}
    finally{loading=false;}
  }
  function open(plan){chosen=typeof plan==='string'?plan:null;if(!dialog.open){accept.checked=false;dialog.showModal();}void load();}
  button.addEventListener('click',()=>open());
  dialog.querySelector('.bp-pay-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  document.addEventListener('click',e=>{const trigger=e.target.closest('[data-bp-pay]');if(trigger){e.preventDefault();open(trigger.dataset.bpPay);}});
  window.BP_Payments={open};
})();
