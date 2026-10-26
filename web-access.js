'use strict';
(function () {
  const tg = window.Telegram?.WebApp;
  if (tg?.initData) return;
  const storeKey = 'bp-web-session';
  const root = 'https://pulse.cityai.site/api';
  const validToken = token => /^[a-f0-9]{48}$/.test(token || '');
  const session = () => sessionStorage.getItem(storeKey) || '';
  const style = document.createElement('style');
  style.textContent = `
    .bp-web-entry{min-height:42px;margin-left:auto}
    .bp-web-auth{border:0;border-radius:20px;padding:0;background:transparent;color:#202943;width:min(420px,calc(100vw - 28px));max-height:calc(100dvh - 32px);box-shadow:0 24px 90px #151a3566;overflow:auto}
    .bp-web-auth::backdrop{background:#0b14368a;backdrop-filter:blur(5px)}
    .bp-web-auth-main{background:#fff;padding:30px}
    .bp-web-auth-top{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:10px}
    .bp-web-auth h2{font-size:25px;letter-spacing:-.8px;margin:0;color:#202943}
    .bp-web-auth p{color:#727e98;font-size:13px;line-height:1.55}
    .bp-web-auth label{display:block;margin:17px 0 0;font-size:12px;color:#454e68;font-weight:720}
    .bp-web-auth select{display:block;margin-top:7px;width:100%;border:1px solid #d9deea;background:white;color:#1c2540;padding:12px 13px;font:inherit;font-size:15px;border-radius:11px}
    .bp-web-auth input:not([type=checkbox]){display:block;margin-top:7px;width:100%;border:1px solid #d9deea;background:#fff;color:#1c2540;padding:12px 13px;font:inherit;font-size:15px;border-radius:11px}
    .bp-web-auth input:focus-visible{outline:2px solid #747ae4;outline-offset:2px}
    .bp-web-auth button{cursor:pointer}
    .bp-web-auth-close{background:#eef1f7;border:0;width:34px;height:34px;border-radius:10px;color:#606a82;font-size:20px}
    .bp-web-auth-submit{width:100%;border:0;border-radius:11px;background:#505dbe;color:#fff;font-weight:750;padding:13px 15px;margin-top:22px;font-size:14px}
    .bp-web-auth-submit:disabled{opacity:.6;cursor:wait}
    .bp-web-auth-switch{border:0;background:transparent;color:#505dbe;font-size:13px;font-weight:700;margin-top:16px;padding:5px}
    .bp-web-auth-message{min-height:18px;color:#a03939!important;margin-bottom:0!important}
    .bp-web-accept{font-size:11px!important;line-height:1.6;display:flex!important;gap:8px;font-weight:400!important}
    .bp-web-accept input{flex-shrink:0}
    .bp-web-auth [hidden]{display:none!important}
    @media(max-width:680px){.bp-web-auth-main{padding:22px}.bp-web-entry{width:100%}}
  `;
  document.head.append(style);
  const dialog = document.createElement('dialog');
  dialog.className = 'bp-web-auth';
  dialog.setAttribute('aria-labelledby','bp-web-auth-heading');
  dialog.innerHTML = `<div class="bp-web-auth-main">
    <div class="bp-web-auth-top"><h2 id="bp-web-auth-heading">Вход в Бизнес Пульс</h2><button type="button" class="bp-web-auth-close" aria-label="Закрыть">×</button></div>
    <p id="bp-web-intro">Войдите, чтобы загрузить отчёт и получить аналитику своей компании.</p>
    <form id="bp-web-form" autocomplete="on">
      <label id="bp-web-company-box" hidden>Название компании <input name="company" minlength="2" maxlength="120" autocomplete="organization" placeholder="Название компании"></label>
      <label id="bp-web-industry-box" hidden>Сфера бизнеса <select name="industry"><option value="other">Другое</option><option value="cafe">Кафе и доставка</option><option value="store">Магазин</option><option value="clinic">Клиника</option><option value="auto">Автосервис</option></select></label>
      <label>Email <input name="email" type="email" autocomplete="username" maxlength="254" required placeholder="name@company.ru"></label>
      <label>Пароль <input name="password" type="password" autocomplete="current-password" minlength="10" maxlength="128" required placeholder="Не менее 10 символов"></label>
      <label id="bp-web-confirm-box" hidden>Повторите пароль <input name="confirm" type="password" minlength="10" maxlength="128" autocomplete="new-password"></label>
      <label id="bp-web-invite-box" hidden>Код приглашения <input name="invite" autocomplete="off" inputmode="text" autocapitalize="off" spellcheck="false" maxlength="48" pattern="[a-f0-9]{48}" placeholder="Код из личного сообщения"></label>
      <label class="bp-web-accept" id="bp-web-accept-box" hidden><input type="checkbox" name="accepted"> <span>Принимаю <a href="./legal/offer.html" target="_blank" rel="noopener">условия сервиса</a> и ознакомлен с <a href="./legal/privacy.html" target="_blank" rel="noopener">политикой обработки данных</a>.</span></label>
      <button type="submit" class="bp-web-auth-submit">Войти</button>
      <p role="status" class="bp-web-auth-message" aria-live="polite"></p>
    </form>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <button type="button" class="bp-web-auth-switch" data-mode="signup">Зарегистрироваться</button>
      <button type="button" class="bp-web-auth-switch" data-mode="forgot">Забыли пароль?</button>
      <button type="button" class="bp-web-auth-switch" data-mode="invite">Есть приглашение</button>
      <button type="button" class="bp-web-auth-switch" data-mode="login">Войти</button>
    </div>
    <p style="font-size:11px">Не приходит письмо? Проверьте «Спам» или свяжитесь с поддержкой.</p>
  </div>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const message = dialog.querySelector('[role=status]');
  const inviteBox = dialog.querySelector('#bp-web-invite-box');
  const acceptBox = dialog.querySelector('#bp-web-accept-box');
  const switchButton = dialog.querySelector('.bp-web-auth-switch');
  let mode = 'login', linkToken = '', mailEnabled = null;
  const fields={
    login:['email','password'],signup:['company','industry','email','password','accepted'],
    invite:['email','password','invite','accepted'],forgot:['email'],
    reset:['password','confirm'],verify:[]
  };
  const copy={
    login:['Вход в Бизнес Пульс','Войдите, чтобы получить аналитику компании.','Войти'],
    signup:['Регистрация','Подтвердите email, чтобы начать бесплатный тест на 48 часов.','Зарегистрироваться'],
    invite:['Активация приглашения','Введите код приглашения, чтобы создать аккаунт.','Создать аккаунт'],
    forgot:['Восстановление пароля','Отправим ссылку для смены пароля на вашу почту.','Отправить ссылку'],
    reset:['Новый пароль','Придумайте новый пароль (не менее 10 символов).','Сохранить пароль'],
    verify:['Подтверждение почты','Проверяем ссылку подтверждения.','']
  };
  function setMode(value) {
    mode=value;
    const active=fields[value];
    const nodes={company:dialog.querySelector('#bp-web-company-box'),
      industry:dialog.querySelector('#bp-web-industry-box'),
      email:form.elements.email.closest('label'),
      password:form.elements.password.closest('label'),
      confirm:dialog.querySelector('#bp-web-confirm-box'),
      invite:inviteBox,accepted:acceptBox};
    for(const [key,node] of Object.entries(nodes)){
      const shown=active.includes(key);
      node.hidden=!shown;
      const input=key==='accepted'?form.elements.accepted:form.elements[key];
      input.disabled=!shown;
      input.required=shown&&key!=='industry';
    }
    dialog.querySelector('h2').textContent=copy[value][0];
    dialog.querySelector('#bp-web-intro').textContent=copy[value][1];
    form.querySelector('[type=submit]').textContent=copy[value][2];
    form.querySelector('[type=submit]').hidden=value==='verify';
    form.elements.password.autocomplete=value==='login'?'current-password':'new-password';
    dialog.querySelectorAll('[data-mode]').forEach(button=>button.hidden=button.dataset.mode===value);
    message.textContent='';
    form.querySelector('[type=submit]').disabled=mailEnabled===false&&['signup','forgot'].includes(value);
    if(mailEnabled===false&&['signup','forgot'].includes(value))
      message.textContent='Отправка писем пока не настроена. Свяжитесь с поддержкой.';
  }
  function open(value='login') {
    setMode(typeof value==='boolean'?(value?'invite':'login'):value);
    if (!dialog.open) dialog.showModal();
    const first=fields[mode].find(k=>!['accepted','industry'].includes(k));
    if(first&&form.elements[first])form.elements[first].focus();
  }
  dialog.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>open(button.dataset.mode));
  dialog.querySelector('.bp-web-auth-close').onclick = () => dialog.close();
  async function post(route,body){
    const response=await fetch(root+route,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(20000)
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(data.error||'Ошибка запроса. Попробуйте снова.');
    return data;
  }
  function enter(token){
    if(!validToken(token))throw Error('Сервер не вернул действительную сессию.');
    sessionStorage.setItem(storeKey,token);
    window.location.replace(window.location.pathname);
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const submit=form.querySelector('[type=submit]');
    if(submit.disabled)return;
    submit.disabled=true;message.textContent='';
    const email=form.elements.email.value.trim(),password=form.elements.password.value;
    try{
      if(mode==='login'){
        const data=await post('/web-auth/login',{email,password});enter(data.token);return;
      }
      if(mode==='invite'){
        const data=await post('/web-auth/register',{
          email,password,invite:form.elements.invite.value.trim(),
          accepted_terms:form.elements.accepted.checked});
        enter(data.token);return;
      }
      if(mode==='signup'){
        const data=await post('/web-auth/signup',{email,password,
          company_name:form.elements.company.value,industry:form.elements.industry.value,
          accepted_terms:form.elements.accepted.checked});
        message.textContent=data.message+' Проверьте папку «Спам».';
        message.style.color='#267d6a';
      }
      if(mode==='forgot'){
        const data=await post('/web-auth/reset/request',{email});
        message.textContent=data.message+' Проверьте папку «Спам».';
        message.style.color='#267d6a';
      }
      if(mode==='reset'){
        if(password!==form.elements.confirm.value)throw Error('Пароли не совпадают.');
        await post('/web-auth/reset/confirm',{token:linkToken,password});
        linkToken='';
        message.textContent='Пароль изменён. Теперь войдите с новым паролем.';
        message.style.color='#267d6a';
      }
    }catch(error){
      message.style.color='#a03939';
      message.textContent=error.message||'Ошибка соединения.';
    }finally{
      submit.disabled=mailEnabled===false&&['signup','forgot'].includes(mode);
    }
  });
  // The demo hides .right-top; keep the login entry visible in the page header.
  const buttons = validToken(session()) ? document.querySelector('.right-top') : document.querySelector('.topbar');
  if (buttons) {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'ghost-btn bp-web-entry';
    entry.textContent = validToken(session()) ? 'Выйти' : 'Войти';
    entry.addEventListener('click',async()=>{
      if (!validToken(session())) {open();return;}
      const token = session();
      sessionStorage.removeItem(storeKey);
      try {
        await fetch(root+'/web-auth/logout',{method:'POST',headers:{'X-BP-Web-Session':token},signal:AbortSignal.timeout(5000)});
      } catch {}
      window.location.replace(window.location.pathname+'?login=1');
    });
    buttons.append(entry);
  }
  window.BP_WebAuth = { open, token:session };
  const query=new URLSearchParams(location.search);
  const fragment=new URLSearchParams(location.hash.slice(1));
  if(fragment.has('verify')||fragment.has('reset')){
    const verifying=fragment.has('verify');
    linkToken=fragment.get(verifying?'verify':'reset')||'';
    // Remove the secret from the browser URL before loading any more resources.
    history.replaceState(null,'',location.pathname);
    if(!validToken(linkToken)){
      open(verifying?'signup':'forgot');
      message.textContent='Ссылка недействительна. Запросите новую.';
    }else if(verifying){
      open('verify');
      message.textContent='Проверяем ссылку…';
      void post('/web-auth/verify',{token:linkToken})
        .then(data=>enter(data.token))
        .catch(error=>{open('signup');message.textContent=error.message;});
    }else open('reset');
  }else if(query.get('login')==='1'&&!validToken(session()))open('login');
  else if(query.get('register')==='1'&&!validToken(session()))open('signup');
  else if(query.get('invite')==='1'&&!validToken(session()))open('invite');
  void fetch(root+'/web-auth/config',{cache:'no-store',signal:AbortSignal.timeout(10000)})
    .then(r=>r.json()).then(data=>{
      mailEnabled=data.registration_available===true;
      if(dialog.open&&['signup','forgot'].includes(mode)){
        const prior=message.textContent;
        setMode(mode);
        if(prior&&!form.querySelector('[type=submit]').disabled)message.textContent=prior;
      }
    }).catch(()=>{});
  window.addEventListener('bp:web-session-expired',()=>{
    sessionStorage.removeItem(storeKey);
    open(false);
    message.textContent='Сессия закончилась. Войдите ещё раз.';
  });
})();
