import tls from 'node:tls';
import readline from 'node:readline';

// Native Node.js SMTP-over-TLS transport. Timeweb Cloud supports smtps:465.
// No shell commands or external packages; TLS certificate validation stays enabled.
const ADDRESS=/^[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export const safeMailAddress=value=>typeof value==='string'&&value.length<=254&&ADDRESS.test(value)&&!value.includes('..');
const subjectHeader=text=>'=?UTF-8?B?'+Buffer.from(text,'utf8').toString('base64')+'?=';
const mailError=()=>Object.assign(Error('Не удалось отправить письмо через SMTP. Проверьте почтовые настройки.'),{status:503});
function formatMail({from,to,subject,text}){
  if(!safeMailAddress(from)||!safeMailAddress(to))throw Error('Invalid mail address');
  // Text-only mail, MIME UTF-8, ASCII-safe subject and no user-supplied headers.
  const normalized=text.replace(/\r?\n/g,'\r\n').replace(/^\./gm,'..');
  return [
    'From: '+subjectHeader('Бизнес Пульс')+' <'+from+'>',
    'To: <'+to+'>',
    'Subject: '+subjectHeader(subject),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Date: '+new Date().toUTCString(),
    '',
    // Base64 body prevents SMTP dot-stuffing and unicode line issues.
    Buffer.from(normalized,'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n')||'',
  ].join('\r\n')+'\r\n';
}

export async function sendTimewebMail({host='smtp.timeweb.ru',port=465,user,password,from,to,subject,text},
  connect=tls.connect){
  if(!safeMailAddress(user)||!safeMailAddress(from)||user!==from||!safeMailAddress(to)||
    typeof password!=='string'||!password||!['smtp.timeweb.ru'].includes(host)||port!==465)
    throw mailError();
  const socket=connect({host,port,servername:host,rejectUnauthorized:true});
  socket.setTimeout(12000,()=>socket.destroy(mailError()));
  socket.on('error',()=>{}); // errors are handled through the SMTP read stream
  const reader=readline.createInterface({input:socket,crlfDelay:Infinity,terminal:false});
  const iterator=reader[Symbol.asyncIterator]();
  async function reply(expected){
    let lines=0,code='';
    while(lines++<25){
      const next=await iterator.next();
      if(next.done)throw mailError();
      const match=/^(\d{3})([ -])/.exec(next.value);
      if(!match)throw mailError();
      if(code&&code!==match[1])throw mailError();
      code=match[1];
      if(match[2]===' '){
        if(Number(code)!==expected)throw mailError();
        return;
      }
    }
    throw mailError();
  }
  async function command(line,expect){
    if(!socket.writable)throw mailError();
    socket.write(line+'\r\n');
    await reply(expect);
  }
  try{
    await new Promise((resolve,reject)=>{
      if(socket.authorized&&socket.encrypted){resolve();return;}
      socket.once('secureConnect',resolve);
      socket.once('error',reject);
    });
    if(!socket.authorized)throw mailError();
    await reply(220);
    await command('EHLO business-pulse.local',250);
    // LOGIN is supported by Timeweb; credentials travel only in validated TLS.
    await command('AUTH LOGIN',334);
    await command(Buffer.from(user,'utf8').toString('base64'),334);
    await command(Buffer.from(password,'utf8').toString('base64'),235);
    await command('MAIL FROM:<'+from+'>',250);
    await command('RCPT TO:<'+to+'>',250);
    await command('DATA',354);
    socket.write(formatMail({from,to,subject,text})+'.\r\n');
    await reply(250);
    await command('QUIT',221);
    return true;
  }catch{
    throw mailError();
  }finally{
    reader.close();
    socket.destroy();
  }
}
