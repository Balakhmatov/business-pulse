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
