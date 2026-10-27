import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { sendTimewebMail, safeMailAddress } from './smtp-mail.mjs';

class MockSMTP extends Duplex {
  constructor(){
    super();this.authorized=true;this.encrypted=true;this.lines=[];this.dataMode=false;
    queueMicrotask(()=>this.push('220 smtp.timeweb.ru ESMTP ready\r\n'));
  }
  _read(){}
  setTimeout(){return this;}
  _write(buffer,encoding,callback){
    const command=buffer.toString('utf8');
    this.lines.push(command);
    let response='';
    if(this.dataMode){
      this.dataMode=false;
      response='250 2.0.0 queued\r\n';
    }else if(command.startsWith('EHLO ')){
      response='250-smtp.timeweb.ru\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 100000\r\n';
    }else if(command==='AUTH LOGIN\r\n') response='334 VXNlcm5hbWU6\r\n';
    else if(command===Buffer.from('support@cityai.site').toString('base64')+'\r\n')
      response='334 UGFzc3dvcmQ6\r\n';
    else if(command===Buffer.from('mail-secret').toString('base64')+'\r\n')
      response='235 2.7.0 accepted\r\n';
    else if(command.startsWith('MAIL FROM:')||command.startsWith('RCPT TO:'))response='250 OK\r\n';
    else if(command==='DATA\r\n'){this.dataMode=true;response='354 end with .\r\n';}
    else if(command==='QUIT\r\n')response='221 Bye\r\n';
    else response='550 unsupported command\r\n';
    queueMicrotask(()=>this.push(response));
    callback();
  }
}
test('SMTP over verified TLS authenticates and sends UTF-8 MIME without leaking raw password',async()=>{
  let peer;
  const connect=opts=>{
    assert.equal(opts.host,'smtp.timeweb.ru');
    assert.equal(opts.port,465);
    assert.equal(opts.rejectUnauthorized,true);
    peer=new MockSMTP();
    return peer;
  };
  assert.equal(await sendTimewebMail({
    user:'support@cityai.site',password:'mail-secret',from:'support@cityai.site',
    to:'test@example.com',subject:'Подтвердите email',text:'Подтвердите регистрацию'
  },connect),true);
  const writes=peer.lines.join('');
  assert.match(writes,/AUTH LOGIN/);
  assert.match(writes,/MAIL FROM:<support@cityai.site>/);
  assert.match(writes,/RCPT TO:<test@example.com>/);
  assert.match(writes,/Content-Transfer-Encoding: base64/);
  assert.match(writes,/Subject: =\?UTF-8\?B\?/);
  assert.ok(!writes.includes('mail-secret'));
});
test('SMTP rejects injection and wrong sender before connecting',async()=>{
  let called=false;
  const connect=()=>{called=true;throw Error('unexpected network');};
  assert.equal(safeMailAddress('a@example.com'),true);
  assert.equal(safeMailAddress('a@example.com\r\nBcc:foo@example.com'),false);
  await assert.rejects(()=>sendTimewebMail({
    user:'support@cityai.site',password:'mail-secret',from:'other@cityai.site',
    to:'test@example.com',subject:'',text:''
  },connect),/SMTP/);
  assert.equal(called,false);
});

test('SMTP reports ambiguous acceptance separately from a definite pre-delivery refusal',async()=>{
 const info={user:'support@cityai.site',password:'mail-secret',from:'support@cityai.site',to:'test@example.com',subject:'Тест',text:'Тест'};
 class LostAcceptance extends MockSMTP{
  _write(buffer,encoding,callback){if(this.dataMode){this.dataMode=false;callback();queueMicrotask(()=>this.push(null));return}super._write(buffer,encoding,callback)}
 }
 class RejectedRecipient extends MockSMTP{
  _write(buffer,encoding,callback){if(buffer.toString().startsWith('RCPT TO:')){callback();queueMicrotask(()=>this.push('550 Rejected\r\n'));return}super._write(buffer,encoding,callback)}
 }
 await assert.rejects(()=>sendTimewebMail(info,()=>new LostAcceptance()),e=>e.deliveryUncertain===true);
 await assert.rejects(()=>sendTimewebMail(info,()=>new RejectedRecipient()),e=>e.deliveryUncertain===false);
});
