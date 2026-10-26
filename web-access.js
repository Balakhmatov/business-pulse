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
      <label>Email <input name="email" type="email" autocomplete="username" maxlength="254" required placeholder="name@company.ru"></label>
      <label>Пароль <input name="password" type="password" autocomplete="current-password" minlength="10" maxlength="128" required placeholder="Не менее 10 символов"></label>
      <label id="bp-web-invite-box" hidden>Код приглашения <input name="invite" autocomplete="off" inputmode="text" autocapitalize="off" spellcheck="false" maxlength="48" pattern="[a-f0-9]{48}" placeholder="Код из личного сообщения"></label>
      <label class="bp-web-accept" id="bp-web-accept-box" hidden><input type="checkbox" name="accepted"> <span>Принимаю <a href="./legal/offer.html" target="_blank" rel="noopener">условия сервиса</a> и ознакомлен с <a href="./legal/privacy.html" target="_blank" rel="noopener">политикой обработки данных</a>.</span></label>
      <button type="submit" class="bp-web-auth-submit">Войти</button>
      <p role="status" class="bp-web-auth-message" aria-live="polite"></p>
    </form>
    <button type="button" class="bp-web-auth-switch">Есть приглашение? Создать аккаунт</button>
    <p style="font-size:11px">Нет приглашения? <a href="mailto:ilya.balahmatov@gmail.com">Свяжитесь с нами</a> для подключения бесплатного теста.</p>
  </div>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const message = dialog.querySelector('[role=status]');
  const inviteBox = dialog.querySelector('#bp-web-invite-box');
  const acceptBox = dialog.querySelector('#bp-web-accept-box');
  const switchButton = dialog.querySelector('.bp-web-auth-switch');
  let registering = false;
  function setMode(value) {
    registering = value;
    inviteBox.hidden = !registering;
    acceptBox.hidden = !registering;
    form.elements.invite.required = registering;
    form.elements.accepted.required = registering;
    form.elements.password.autocomplete = registering ? 'new-password' : 'current-password';
    dialog.querySelector('h2').textContent = registering ? 'Активация приглашения' : 'Вход в Бизнес Пульс';
    dialog.querySelector('#bp-web-intro').textContent = registering
      ? 'Создайте личный кабинет. Бесплатный тест на 48 часов начнётся после регистрации.'
      : 'Войдите, чтобы загрузить отчёт и получить аналитику своей компании.';
    form.querySelector('[type=submit]').textContent = registering ? 'Создать аккаунт' : 'Войти';
    switchButton.textContent = registering ? 'Уже есть аккаунт? Войти' : 'Есть приглашение? Создать аккаунт';
    message.textContent = '';
  }
  function open(register = false) {
    setMode(register);
    if (!dialog.open) dialog.showModal();
    form.elements.email.focus();
  }
  switchButton.onclick = () => setMode(!registering);
  dialog.querySelector('.bp-web-auth-close').onclick = () => dialog.close();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    message.textContent = '';
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    const endpoint = registering ? '/web-auth/register' : '/web-auth/login';
    const body = {email: form.elements.email.value, password: form.elements.password.value};
    if (registering) {
      body.invite = form.elements.invite.value.trim();
      body.accepted_terms = form.elements.accepted.checked;
    }
    try {
      const response = await fetch(root + endpoint, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
        cache:'no-store', signal:AbortSignal.timeout(20000)
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Не удалось выполнить вход.');
      if (!validToken(data.token)) throw Error('Сервер вернул недействительную сессию.');
      sessionStorage.setItem(storeKey,data.token);
      window.location.replace(window.location.pathname);
    } catch (error) {
      message.textContent = error.message || 'Ошибка соединения. Повторите попытку.';
    } finally {
      submit.disabled = false;
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
  const query = new URLSearchParams(location.search);
  if (query.get('login') === '1' && !validToken(session())) open(false);
  if (query.get('register') === '1' && !validToken(session())) open(true);
  window.addEventListener('bp:web-session-expired',()=>{
    sessionStorage.removeItem(storeKey);
    open(false);
    message.textContent='Сессия закончилась. Войдите ещё раз.';
  });
})();
