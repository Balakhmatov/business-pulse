import { sendTimewebMail, safeMailAddress } from './smtp-mail.mjs';
import {trialReminderText} from './billing.mjs';
// Server-side transactional mail through the configured SMTP mailbox or HTTPS Resend API.
// The browser never sees mail credentials or authentication tokens.
const WEB_APP='https://balakhmatov.github.io/business-pulse/index.html';
export function createAuthMail({
  apiKey=process.env.BP_MAIL_RESEND_API_KEY,
  from=process.env.BP_MAIL_FROM,
  fetchFn=globalThis.fetch,
  smtpUser=process.env.BP_MAIL_SMTP_USER,
  smtpPassword=process.env.BP_MAIL_SMTP_PASSWORD,
  smtpFn=sendTimewebMail
}={}) {
  const smtpReady=Boolean(safeMailAddress(smtpUser)&&safeMailAddress(from)&&
    smtpUser.trim()===from.trim()&&typeof smtpPassword==='string'&&smtpPassword.length>0);
  const resendReady=Boolean(apiKey?.trim()&&from?.trim()&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from.trim()));
  const ready=smtpReady||resendReady;
  async function send(kind,to,token) {
    if(!ready)throw Object.assign(Error('Отправка писем пока не настроена.'),{status:503});
    if(!['verify','reset'].includes(kind)||!/^[a-f0-9]{48}$/.test(token))
      throw Error('Invalid email action');
    const link=WEB_APP+'#'+kind+'='+token;
    const subject=kind==='verify'?'Подтвердите email — Бизнес Пульс':'Восстановление пароля — Бизнес Пульс';
    const message=kind==='verify'
      ?'Для завершения регистрации подтвердите адрес электронной почты. Ссылка действует 24 часа.'
      :'Для установки нового пароля перейдите по ссылке. Ссылка действует 30 минут.';
    const text=message+'\n\n'+link+'\n\nЕсли вы не запрашивали это письмо, просто проигнорируйте его. Никому не сообщайте ссылку.';
    return deliver(to,subject,text);
  }
  async function deliver(to,subject,text,idempotencyKey=null){
    if(!ready)throw Object.assign(Error('Отправка писем пока не настроена.'),{status:503,deliveryUncertain:false});
    if(!safeMailAddress(to))throw Object.assign(Error('Invalid recipient'),{deliveryUncertain:false});
    if(smtpReady){
      await smtpFn({host:'smtp.timeweb.ru',port:465,user:smtpUser.trim(),password:smtpPassword,
        from:from.trim(),to,subject,text});
      return true;
    }
    let response;
    try {
      response=await fetchFn('https://api.resend.com/emails',{
        method:'POST',
        headers:{Authorization:'Bearer '+apiKey.trim(),'Content-Type':'application/json','User-Agent':'BusinessPulse/1.0',...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},
        body:JSON.stringify({from:from.trim(),to:[to],subject,text}),
        signal:AbortSignal.timeout(12000)
      });
    }catch{throw Object.assign(Error('Не удалось отправить письмо. Попробуйте позже.'),{status:503,deliveryUncertain:true});}
    if(!response.ok)throw Object.assign(Error('Письмо не отправлено. Проверьте настройки почтового сервиса.'),{status:503,deliveryUncertain:!response.status||response.status>=500||response.status===408});
    return true;
  }
  function sendTrialReminder({to,kind,trialEndsMs,companyName='',idempotencyKey}){
    const subjects={trial_unused:'Загрузите данные в Бизнес Пульс',trial_ending:'Тестовый период заканчивается — скидка на первый месяц',trial_ended:'Тестовый период Бизнес Пульс завершён'};
    const text=(companyName?'Компания: '+companyName+'\n\n':'')+trialReminderText(kind,trialEndsMs)+
      '\n\nОткрыть кабинет: '+WEB_APP+'?login=1'+
      '\n\nЭто служебное уведомление о тестовом доступе вашей компании. Если вы уже оплатили подписку, проверьте статус в кабинете или обратитесь в поддержку: https://t.me/business_pulse_app_bot?start=support';
    return deliver(to,subjects[kind],text,idempotencyKey);
  }
  return {ready,sendTrialReminder,sendVerification:(to,token)=>send('verify',to,token),sendReset:(to,token)=>send('reset',to,token)};
}
