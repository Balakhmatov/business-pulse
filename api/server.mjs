import http from 'node:http';
import { createWebLogin } from './web-login.mjs';
import { createWebsiteAccounts } from './website-accounts.mjs';
import { createWebsiteSelfService } from './website-selfservice.mjs';
import { createAuthMail } from './auth-mail.mjs';
import { createPayments } from './yookassa.mjs';
import { ensurePaymentLinks } from './payment-links.mjs';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAI } from './ai.mjs';
import { createAccumulator } from './accumulate.mjs';
import { calculateFinancialSummary } from './finance-summary.mjs';
import { createCorrectionService } from './corrections.mjs';
import { resetTestData,clearCompanyData } from './test-reset.mjs';
import { createImportMapper } from './import-mapping.mjs';
import { ensureCompanyMembers,companyForUser } from './company-members.mjs';
import { createAccountLink } from './account-link.mjs';
import { inferImportedBasis } from './financial-auto.mjs';
import { setCompanyIndustry } from './company-industry.mjs';
import { ensureBillingSchema,ensureCompanyBilling,subscriptionFor,assertSubscription,PLANS } from './billing.mjs';

// Localhost-only service. Nginx provides HTTPS. Telegram initData is ALWAYS signed and verified.
const port = Number(process.env.BP_API_PORT || 3117);
const token = process.env.BP_BOT_TOKEN;
const dbFile = process.env.BP_DB_FILE || '/var/lib/business-pulse/pulse.db';
const allowedOrigins = new Set(['https://balakhmatov.github.io','https://pulse.cityai.site']);
if(!token || token.length<20)throw Error('BP_BOT_TOKEN required');
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid API port');
fs.mkdirSync(path.dirname(dbFile),{recursive:true,mode:0o700});
const db=new DatabaseSync(dbFile);
db.exec(
  'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;' +
  'CREATE TABLE IF NOT EXISTS users (telegram_id TEXT PRIMARY KEY,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);' +
  "CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(telegram_id),name TEXT NOT NULL,industry TEXT NOT NULL DEFAULT 'other',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);" +
  'CREATE INDEX IF NOT EXISTS ix_companies_owner ON companies(owner_id);' +
  "CREATE TABLE IF NOT EXISTS operations (id INTEGER PRIMARY KEY AUTOINCREMENT,company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,sold_on TEXT NOT NULL,source_id TEXT NOT NULL,item TEXT NOT NULL,amount_kopecks INTEGER NOT NULL,status TEXT NOT NULL CHECK (status IN ('sale','refund')));" +
  'CREATE INDEX IF NOT EXISTS ix_ops_company_day ON operations(company_id,sold_on);' +
  'CREATE TABLE IF NOT EXISTS imports (company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,source TEXT NOT NULL,row_count INTEGER NOT NULL);'
);
// Upgrade existing SQLite schema before preparing statements that use the new columns.
ensureCompanyMembers(db);
ensureBillingSchema(db);
ensurePaymentLinks(db);
const payments=createPayments({db});
const webLogin=createWebLogin(db);
const websiteAccounts=createWebsiteAccounts(db);
const accountLink=createAccountLink(db);
const websiteSelfService=createWebsiteSelfService(db);
const authMail=createAuthMail();
const paymentTimer=setInterval(()=>void payments.reconcile(),60000);
paymentTimer.unref();
void payments.reconcile();
const accumulator=createAccumulator(db);
const correctionService=createCorrectionService({db,secret:token});
const importMapper=createImportMapper({db});
const st={
  user:db.prepare('INSERT OR IGNORE INTO users(telegram_id) VALUES(?)'),
  newCompany:db.prepare('INSERT INTO companies(id,owner_id,name,industry) VALUES(?,?,?,?)'),
  rows:db.prepare('SELECT sold_on,source_id,item,amount_kopecks,status,financial_basis,quantity_milli FROM operations WHERE company_id=? AND sold_on>=? AND sold_on<=?'),
  countBasis:db.prepare('SELECT financial_basis,COUNT(*) AS n FROM operations WHERE company_id=? GROUP BY financial_basis'),
  latest:db.prepare('SELECT imported_at,source,row_count,last_change_at FROM imports WHERE company_id=?'),
  total:db.prepare('SELECT COUNT(*) AS n FROM operations WHERE company_id=?')
};
function reply(res,status,data,origin){
  const h={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Vary':'Origin'};
  if(origin && allowedOrigins.has(origin))h['Access-Control-Allow-Origin']=origin;
  res.writeHead(status,h);res.end(JSON.stringify(data));
}
function telegramID(raw){
  if(typeof raw!=='string'||!raw||raw.length>8192)throw Error('Authorization required');
  const p=new URLSearchParams(raw),hash=p.get('hash');
  if(p.getAll('hash').length!==1||p.getAll('auth_date').length!==1||p.getAll('user').length!==1||!/^[0-9a-f]{64}$/i.test(hash||''))throw Error('Bad authorization');
  const list=[];
  for(const [k,v] of p){
    if(p.getAll(k).length!==1||!/^[a-z_]+$/.test(k))throw Error('Bad authorization');
    if(k!=='hash')list.push(k+'='+v);
  }
  list.sort();
  const key=createHmac('sha256','WebAppData').update(token).digest();
  const candidate=createHmac('sha256',key).update(list.join('\n')).digest();
  if(!timingSafeEqual(candidate,Buffer.from(hash,'hex')))throw Error('Bad authorization');
  const at=Number(p.get('auth_date')),now=Math.floor(Date.now()/1000);
  if(!Number.isSafeInteger(at)||at<now-86400||at>now+60)throw Error('Expired authorization');
  let user;try{user=JSON.parse(p.get('user'));}catch{throw Error('Invalid user');}
  if(!user||!Number.isSafeInteger(user.id)||user.id<1)throw Error('Invalid user');
  return String(user.id);
}
function companyFor(id){
  st.user.run(id);
  let c=companyForUser(db,id);
  if(!c){st.newCompany.run(randomUUID(),id,'Моя компания','other');c=companyForUser(db,id);}
  ensureCompanyBilling(db,c);
  return c;
}

async function readCompanyJSON(req,c,id){
  const input=await readJSON(req);
  // Access may have been revoked while the request body was still uploading.
  if(companyForUser(db,id)?.id!==c.id){const e=Error('Доступ к компании изменился. Откройте приложение заново.');e.status=403;throw e;}
  assertSubscription(db,c);
  return input;
}
const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'});
function mskToday(){const p=Object.fromEntries(fmt.formatToParts(new Date()).map(x=>[x.type,x.value]));return [p.year,p.month,p.day].join('-');}
function shift(day,n){const x=new Date(day+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);}
function resolveRange(c,params){
  const yesterday=shift(mskToday(),-1);
  const sub=subscriptionFor(db,c);
  const upgraded=sub?.state==='paid'||sub?.state==='admin';
  const hasCustom=params?.has('from')||params?.has('to');
  if(hasCustom&&(!params?.get('from')||!params?.get('to')))
    throw Object.assign(Error('Укажите начало и конец периода.'),{status:400});
  const wanted=hasCustom?null:Number(params?.get('days')||30);
  if(!hasCustom&&(!Number.isInteger(wanted)||![7,30,90,365,1095].includes(wanted)))
    throw Object.assign(Error('Выберите период 7, 30, 90, 365 или 1095 дней.'),{status:400});
  const from=hasCustom?params.get('from'):shift(yesterday,1-wanted);
  const to=hasCustom?params.get('to'):yesterday;
  const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&
    !Number.isNaN(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
  const days=valid(from)&&valid(to)?
    Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000)+1:0;
  if(days<1||days>1095||to>yesterday||from<shift(yesterday,-3650))
    throw Object.assign(Error('Допустимый диапазон — завершённые дни за последние 10 лет, максимум три года.'),{status:400});
  if(!upgraded&&days>90)
    throw Object.assign(Error('Анализ более 90 дней доступен в платной подписке.'),{status:403,code:'HISTORY_PREMIUM_REQUIRED'});
  return {from,to,days};
}
function report(c,requestedBasis=null,range=null){
  const period=range||{to:shift(mskToday(),-1),days:30};
  const end=period.to,start=range?shift(range.from,-range.days):shift(end,-59);
  const entries=st.rows.all(c.id,start,end);
  const counts=Object.fromEntries(st.countBasis.all(c.id).map(x=>[x.financial_basis,x.n]));
  const summary=calculateFinancialSummary(entries,counts,end,requestedBasis,c.industry,range);
  const src=st.latest.get(c.id);
  return {...summary,company:c,subscription:subscriptionFor(db,c),
    source:src?{name:src.source,imported_at:src.imported_at,rows:st.total.get(c.id).n,
      last_import_rows:src.row_count,last_change_at:src.last_change_at}:null,
    warning:src?null:'Отчёт ещё не загружен. Здесь пока нет финансовых данных.'
  };
}

async function readJSON(req){
  let size=0;const parts=[];
  for await(const chunk of req){size+=chunk.length;if(size>6*1024*1024){const e=Error('Too large');e.status=413;throw e;}parts.push(chunk);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{const e=Error('Invalid JSON');e.status=400;throw e;}
}
function normalize(input){
  if(!input||!Array.isArray(input.rows)||input.rows.length<1||input.rows.length>10000)throw Error('Expected 1..10000 rows');
  if(typeof input.source!=='string'||!input.source.trim()||input.source.length>120)throw Error('Invalid source');
  const today=mskToday(),result=[],seen=new Set();
  for(const r of input.rows){
    if(!r||typeof r.date!=='string'||!(/^\d{4}-\d{2}-\d{2}$/).test(r.date)||Number.isNaN(Date.parse(r.date+'T00:00:00Z'))||new Date(r.date+'T00:00:00Z').toISOString().slice(0,10)!==r.date||r.date>today||r.date<shift(today,-3650))throw Error('Invalid date');
    if(typeof r.id!=='string'||!r.id.trim()||r.id.length>100||typeof r.item!=='string'||!r.item.trim()||r.item.length>140)throw Error('Invalid ID or item');
    if(!Number.isSafeInteger(r.amount_kopecks)||Math.abs(r.amount_kopecks)>1e12||r.amount_kopecks===0)throw Error('Invalid amount');
    if(!(r.quantity_milli===undefined||r.quantity_milli===null||
      (Number.isSafeInteger(r.quantity_milli)&&r.quantity_milli>0&&r.quantity_milli<=1000000000)))
      throw Error('Неверное количество: проверьте столбец «Количество».');
    if(!['sale','refund'].includes(r.status)||(r.status==='sale'&&r.amount_kopecks<0)||(r.status==='refund'&&r.amount_kopecks>0))throw Error('Invalid status');
    if(r.occurrence!==undefined&&(!Number.isSafeInteger(r.occurrence)||r.occurrence<0||r.occurrence>100000))throw Error('Invalid line occurrence');
    const key=[r.date,r.id,r.item,r.amount_kopecks,r.status,r.quantity_milli??null,r.occurrence??null].join('\u0000');
    if(!seen.has(key)){result.push(r);seen.add(key);}
  }
  return result;
}
function ingest(c,input){
  const rows=normalize(input);
  return accumulator.ingest(c,input,rows);
}

// The interpreter receives ONLY aggregates, never rows or user identity.
const ai=createAI({db,report,listOperations:(c,range,basis)=>{
  const r=report(c,basis,range);
  const from=range?.from||shift(r.as_of,-179);
  const compareStart=range?shift(from,-range.days):from;
  return st.rows.all(c.id,compareStart,r.as_of)
    .filter(x=>x.financial_basis===r.primary_basis||x.financial_basis==='paid_fulfilled');
}});

const sampleCatalog={
  clinic:[['Консультация терапевта',2800],['УЗИ',3500],['Анализы',1500],['Профилактический чек-ап',6200],['Консультация невролога',3200]],
  store:[['Футболка',1900],['Джинсы',4200],['Худи',5100],['Рубашка',3500],['Брюки',4600]],
  cafe:[['Капучино',290],['Латте',350],['Круассан',260],['Сэндвич',420],['Чизкейк',390]]
};
function generateSample(type='clinic'){
  const catalog=sampleCatalog[type]||sampleCatalog.clinic;
  const lines=['Дата;Номер чека;Товар или услуга;Сумма оплаты;Статус'];
  const end=shift(mskToday(),-1);
  for(let day=59;day>=0;day--){
    const date=shift(end,-day);
    const dayNumber=Math.floor(Date.parse(date+'T00:00:00Z')/86400000);
    for(let i=0;i<7;i++){
      const idx=((dayNumber*7+i*3)%catalog.length+catalog.length)%catalog.length;
      const [item,price]=catalog[idx];
      const shiftAmount=((dayNumber*17+i*31)%9+9)%9-4;
      const amount=Math.max(1,price+shiftAmount*30);
      lines.push([date,'DEMO-'+date+'-'+i,item,amount,'оплата'].join(';'));
    }
    if(dayNumber%12===0){
      const [item,price]=catalog[0];
      lines.push([date,'REF-'+date,item,-price,'возврат'].join(';'));
    }
  }
  return '\uFEFF'+lines.join('\r\n')+'\r\n';
}
function sendSample(req,res,url){
  const type=['clinic','store','cafe'].includes(url.searchParams.get('type'))?url.searchParams.get('type'):'clinic';
  const fileName='business_pulse_sample_'+type+'.csv';
  const body=Buffer.from(generateSample(type),'utf8');
  res.writeHead(200,{
    'Content-Type':'text/csv; charset=utf-8',
    'Content-Disposition':'attachment; filename="'+fileName+'"',
    'Content-Length':String(body.length),
    'Access-Control-Allow-Origin':'https://web.telegram.org',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff'
  });
  res.end(req.method==='HEAD'?undefined:body);
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/api/sample.csv'){
    if(req.method==='GET'||req.method==='HEAD')return sendSample(req,res,url);
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'https://web.telegram.org','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Vary':'Origin'});res.end();return;}
    return reply(res,405,{error:'Method not allowed'});
  }
  const origin=req.headers.origin;
  if(origin&&!allowedOrigins.has(origin))return reply(res,403,{error:'Origin not allowed'});
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':origin||'https://balakhmatov.github.io','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'X-Telegram-Init-Data, X-BP-Web-Session, Content-Type','Access-Control-Max-Age':'600','Vary':'Origin'});res.end();return;}
  if(req.method==='GET'&&url.pathname==='/api/health')return reply(res,200,{status:'ok',service:'business-pulse-api',db:db.prepare('SELECT 1 AS ok').get().ok===1},origin);
  if(!url.pathname.startsWith('/api/'))return reply(res,404,{error:'Not found'},origin);
  if(req.method==='GET'&&url.pathname==='/api/prices')return reply(res,200,{plans:Object.entries(PLANS).map(([id,p])=>({id,...p})),payments_available:payments.ready},origin);
  if(req.method==='POST'&&url.pathname==='/api/web-login'){
    try{return reply(res,200,webLogin.create(),origin);}catch(e){return reply(res,429,{error:e.message},origin);}
  }
  if(req.method==='POST'&&url.pathname==='/api/web-login/poll'){
    try{const input=await readJSON(req);return reply(res,200,webLogin.poll(input.challenge,input.secret),origin);}catch(e){return reply(res,400,{error:e.message},origin);}
  }

  if(req.method==='GET'&&url.pathname==='/api/web-auth/config')
    return reply(res,200,{registration_available:authMail.ready,password_reset_available:authMail.ready},origin);
  if(req.method==='POST'&&url.pathname==='/api/web-auth/signup'){
    try{
      if(!authMail.ready)return reply(res,503,{error:'Регистрация по email временно недоступна. Обратитесь в поддержку.'},origin);
      const input=await readJSON(req);
      const request=websiteSelfService.beginSignup(input);
      if(request)await authMail.sendVerification(request.email,request.token);
      return reply(res,202,{pending:true,message:'Если адрес доступен для регистрации, письмо для подтверждения отправлено.'},origin);
    }catch(error){return reply(res,error.status||503,{error:error.message},origin);}
  }
  if(req.method==='POST'&&url.pathname==='/api/web-auth/verify'){
    try{
      const input=await readJSON(req);
      return reply(res,200,websiteSelfService.verifySignup(input?.token),origin);
    }catch(error){return reply(res,error.status||400,{error:error.message},origin);}
  }
  if(req.method==='POST'&&url.pathname==='/api/web-auth/reset/request'){
    try{
      if(!authMail.ready)return reply(res,503,{error:'Восстановление пароля временно недоступно. Обратитесь в поддержку.'},origin);
      const input=await readJSON(req);
      const request=websiteSelfService.beginReset(input?.email);
      if(request)await authMail.sendReset(request.email,request.token);
      return reply(res,202,{pending:true,message:'Если аккаунт существует, письмо для восстановления отправлено.'},origin);
    }catch(error){return reply(res,error.status||503,{error:error.message},origin);}
  }
  if(req.method==='POST'&&url.pathname==='/api/web-auth/reset/confirm'){
    try{
      const input=await readJSON(req);
      return reply(res,200,websiteSelfService.finishReset(input),origin);
    }catch(error){return reply(res,error.status||400,{error:error.message},origin);}
  }
  if(req.method==='POST'&&url.pathname==='/api/web-auth/register'){
    try{const input=await readJSON(req);return reply(res,201,websiteAccounts.register(input),origin);}
    catch(e){return reply(res,e.status||400,{error:e.message},origin);}
  }
  if(req.method==='POST'&&url.pathname==='/api/web-auth/login'){
    try{const input=await readJSON(req);return reply(res,200,websiteAccounts.login(input),origin);}
    catch(e){return reply(res,e.status||400,{error:e.message},origin);}
  }
  if(req.method==='POST'&&url.pathname==='/api/web-auth/logout'){
    websiteAccounts.logout(req.headers['x-bp-web-session']);
    return reply(res,200,{ok:true},origin);
  }
  const webSession=req.headers['x-bp-web-session'];
  const websiteActor=websiteAccounts.actor(webSession);
  // Telegram-authorized web sessions remain payment-only, as originally intended.
  const paymentOnlyActor=webLogin.actor(webSession);
  const webPaymentRoute=['/api/payments','/api/payments/refresh'].includes(url.pathname)&&req.method==='POST';
  let id;
  try{id=websiteActor||(paymentOnlyActor&&webPaymentRoute?paymentOnlyActor:telegramID(req.headers['x-telegram-init-data']));}
  catch{return reply(res,401,{error:'Войдите в личный кабинет или откройте приложение через Telegram.'},origin);}
  try{
    if(url.pathname==='/api/account-link/status'&&req.method==='GET'){
      if(!websiteActor)return reply(res,403,{error:'Войдите на сайт по email для привязки.'},origin);
      return reply(res,200,accountLink.linked(websiteActor),origin);
    }
    if(url.pathname==='/api/account-link/start'&&req.method==='POST'){
      if(!websiteActor)return reply(res,403,{error:'Войдите на сайт по email для привязки.'},origin);
      return reply(res,200,accountLink.start(websiteActor),origin);
    }
    const c=companyFor(id);
    if(req.method==='GET'&&url.pathname==='/api/me')return reply(res,200,{authenticated:true,company:c,subscription:subscriptionFor(db,c),stored_operations:st.total.get(c.id).n},origin);
    if(req.method==='GET'&&url.pathname==='/api/subscription')return reply(res,200,{company:c,subscription:subscriptionFor(db,c),plans:PLANS},origin);
    if(req.method==='POST'&&url.pathname==='/api/company/industry'){
      // Available to the owner even outside an active subscription.
      if(c.access_role!=='owner')return reply(res,403,{error:'Тип бизнеса может изменить только владелец компании.'},origin);
      const input=await readJSON(req);
      // Re-resolve ownership on the same DB connection and atomically
      // invalidate old AI interpretations if the industry changed.
      const updated=setCompanyIndustry(db,id,input?.industry);
      const sub=subscriptionFor(db,updated.company);
      return reply(res,200,{...updated,subscription:sub,report:sub.access?report(updated.company):null},origin);
    }
    if(req.method==='POST'&&url.pathname==='/api/payments'){
      const input=await readJSON(req);
      if(companyForUser(db,id)?.id!==c.id)return reply(res,403,{error:'Доступ к компании изменился.'},origin);
      if(input?.accepted_terms!==true)return reply(res,400,{error:'Примите условия оплаты.'},origin);
      return reply(res,200,{payment:await payments.create(c,id,input.plan)},origin);
    }
    if(req.method==='POST'&&url.pathname==='/api/payments/refresh')return reply(res,200,{subscription:await payments.refresh(c)},origin);
    // Data deletion must remain available to the authenticated owner after
    // a trial expires; access to one's own records is not subscription-gated.
    if(req.method==='POST'&&url.pathname==='/api/clear-company-data'){
      if(c.access_role!=='owner')return reply(res,403,{error:'Очистить данные может только владелец компании.'},origin);
      const input=await readJSON(req);
      if(companyForUser(db,id)?.id!==c.id)return reply(res,403,{error:'Доступ к компании изменился. Откройте кабинет заново.'},origin);
      const result=clearCompanyData(db,c,id,input?.confirm);
      return reply(res,200,{...result,report:report(c)},origin);
    }
    assertSubscription(db,c);
    if(req.method==='GET'&&url.pathname==='/api/report')
      return reply(res,200,report(c,url.searchParams.get('basis'),resolveRange(c,url.searchParams)),origin);
    if(req.method==='GET'&&url.pathname==='/api/analysis')
      return reply(res,200,ai.get(c,resolveRange(c,url.searchParams),url.searchParams.get('basis')),origin);
    if(req.method==='POST'&&url.pathname==='/api/import/mapping/resolve'){
      const input=await readCompanyJSON(req,c,id);
      return reply(res,200,await importMapper.resolve(c,input),origin);
    }
    if(req.method==='POST'&&url.pathname==='/api/import/mapping/save'){
      const input=await readCompanyJSON(req,c,id);
      return reply(res,200,importMapper.confirm(c,input),origin);
    }
    if(req.method==='POST'&&url.pathname==='/api/import/corrections/preview'){
      const input=await readCompanyJSON(req,c,id);
      if(input.financial_basis==='paid_fulfilled')return reply(res,400,{error:'Для совмещённых чеков используйте повторную обычную загрузку. Режим исправлений поддерживает отдельные финансовые типы.'},origin);
      return reply(res,200,correctionService.preview(c,input),origin);
    }
    if(req.method==='POST'&&url.pathname==='/api/import/corrections/apply'){
      const input=await readCompanyJSON(req,c,id);
      if(input.financial_basis==='paid_fulfilled')return reply(res,400,{error:'Для совмещённых чеков используйте повторную обычную загрузку.'},origin);
      const result=correctionService.apply(c,input);
      if(result.changed)ai.onImport(c);
      return reply(res,200,{...result,report:report(c),history:accumulator.history(c)},origin);
    }
    if(req.method==='GET'&&url.pathname==='/api/import/history'){
      return reply(res,200,{history:accumulator.history(c)},origin);
    }
    if(req.method==='POST'&&url.pathname==='/api/import/undo'){
      const input=await readCompanyJSON(req,c,id);
      const result=accumulator.undoLatest(c,input?.batch_id);
      // An undo changes the underlying financial evidence just like an import.
      ai.onImport(c);
      return reply(res,200,{...result,report:report(c),history:accumulator.history(c)},origin);
    }
    if(req.method==='POST'&&url.pathname==='/api/reset-test-data'){
      if(c.access_role!=='owner')return reply(res,403,{error:'Очистка тестовых данных доступна только владельцу компании.'},origin);
      const input=await readCompanyJSON(req,c,id);
      if(input?.confirm!=='DELETE_TEST_DATA')return reply(res,400,{error:'Подтвердите удаление тестовых операций.'},origin);
      const result=resetTestData(db,c.id);
      return reply(res,200,{...result,report:report(c)},origin);
    }
    if(req.method==='POST'&&url.pathname==='/api/import'){
      const input=await readCompanyJSON(req,c,id);
      if(input.financial_basis==='paid_fulfilled'&&
        (!['cafe','store'].includes(c.industry)||input.confirm_paid_fulfilled!==true)){
        return reply(res,400,{error:'Совмещённые продажи и оплаты разрешены только для кафе и магазинов при явном подтверждении, что заказы оплачены и выданы без авансов.'},origin);
      }
      if(Array.isArray(input.source_headers)&&Number.isInteger(input.amount_index)){
        const inference=inferImportedBasis(input.source_headers,input.amount_index);
        input.financial_basis=inference.basis;
        input.classification=inference.reason;
      }
      const stats=ingest(c,input);
      const updated=report(c);
      if(stats.added || stats.updated){
        if(input.more_chunks===true)db.prepare('DELETE FROM ai_analyses WHERE company_id=?').run(c.id);
        else ai.onImport(c); // generate once after the last upload chunk
      }
      return reply(res,200,{saved:stats.received,stats,report:updated,classification:input.classification||null},origin);
    }
    return reply(res,404,{error:'Unknown API route'},origin);
  }catch(e){console.error('API request rejected:',e.message);return reply(res,e.status||400,{error:e.status===413?'File too large':e.message,code:e.code},origin);}
});
server.listen(port,'127.0.0.1',()=>console.log('Business Pulse API started on 127.0.0.1:'+port));


