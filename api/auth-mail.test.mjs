import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthMail } from './auth-mail.mjs';

test('email delivery is disabled without real credentials',async()=>{
  const sender=createAuthMail({apiKey:'',from:''});
  assert.equal(sender.ready,false);
  await assert.rejects(()=>sender.sendVerification('owner@example.com','a'.repeat(48)),/не настроена/);
});
test('verification and reset emails only transmit one-time URL and omit credentials from body',async()=>{
  const sent=[];
  const sender=createAuthMail({
    apiKey:'test-secret-not-for-production',
    from:'no-reply@example.com',
    fetchFn:async (url,options)=>{
      sent.push({url,options});
      return {ok:true};
    }
  });
  assert.equal(sender.ready,true);
  await sender.sendVerification('owner@example.com','a'.repeat(48));
  await sender.sendReset('owner@example.com','b'.repeat(48));
  assert.equal(sent.length,2);
  assert.equal(sent[0].url,'https://api.resend.com/emails');
  assert.match(JSON.parse(sent[0].options.body).text,/#verify=a{48}/);
  assert.match(JSON.parse(sent[1].options.body).text,/#reset=b{48}/);
  assert.ok(!sent[0].options.body.includes('test-secret-not-for-production'));
  assert.match(sent[0].options.headers.Authorization,/Bearer/);
});
test('failed email delivery rejects without exposing provider response',async()=>{
  const sender=createAuthMail({
    apiKey:'test-key',from:'no-reply@example.com',
    fetchFn:async()=>({ok:false,status:401,text:async()=>'private provider error'})
  });
  await assert.rejects(()=>sender.sendReset('owner@example.com','f'.repeat(48)),/Письмо не отправлено/);
});

test('existing Timeweb Cloud mailbox is preferred to Resend API',async()=>{
  const sent=[];
  const sender=createAuthMail({
    smtpUser:'support@cityai.site',smtpPassword:'secret-password',
    from:'support@cityai.site',apiKey:'resend-key',
    fetchFn:async()=>{throw Error('Resend must not be used');},
    smtpFn:async info=>{sent.push(info);return true;}
  });
  assert.equal(sender.ready,true);
  await sender.sendVerification('user@example.com','c'.repeat(48));
  await sender.sendReset('user@example.com','d'.repeat(48));
  assert.equal(sent.length,2);
  assert.equal(sent[0].host,'smtp.timeweb.ru');
  assert.equal(sent[0].port,465);
  assert.equal(sent[0].user,'support@cityai.site');
  assert.match(sent[0].text,/#verify=c{48}/);
  assert.match(sent[1].text,/#reset=d{48}/);
});
test('SMTP sender requires matching account address and password',()=>{
  const missing=createAuthMail({smtpUser:'support@cityai.site',smtpPassword:'',from:'support@cityai.site',apiKey:''});
  const mismatch=createAuthMail({smtpUser:'support@cityai.site',smtpPassword:'ok',from:'info@cityai.site',apiKey:''});
  assert.equal(missing.ready,false);
  assert.equal(mismatch.ready,false);
});

test('Trial emails reuse mailbox and correct deadline/prices with a safe cabinet link',async()=>{
 const sent=[],mail=createAuthMail({smtpUser:'support@cityai.site',smtpPassword:'test',from:'support@cityai.site',smtpFn:async p=>sent.push(p)});
 const at=Date.parse('2026-10-29T09:00:00Z');
 for(const kind of ['trial_unused','trial_ending','trial_ended'])await mail.sendTrialReminder({to:'owner@example.test',kind,trialEndsMs:at,companyName:'Тестовая клиника'});
 assert.equal(sent.length,3);assert.match(sent[1].text,/1 990 ₽ вместо 2 490 ₽/);assert.match(sent[1].text,/29\.10\.(?:20)?26/);
 assert.ok(!sent[2].text.includes('1 990'));assert.match(sent[2].text,/2 490/);
 assert.ok(sent.every(p=>p.text.includes('index.html?login=1')&&!p.text.includes('password')&&!p.text.includes('#reset=')));
});
