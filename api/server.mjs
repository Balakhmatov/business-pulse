import http from 'node:http';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;' +
  'CREATE TABLE IF NOT EXISTS users (telegram_id TEXT PRIMARY KEY,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);' +
  "CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(telegram_id),name TEXT NOT NULL,industry TEXT NOT NULL DEFAULT 'other',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);" +
  'CREATE INDEX IF NOT EXISTS ix_companies_owner ON companies(owner_id);' +
  "CREATE TABLE IF NOT EXISTS operations (id INTEGER PRIMARY KEY AUTOINCREMENT,company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,sold_on TEXT NOT NULL,source_id TEXT NOT NULL,item TEXT NOT NULL,amount_kopecks INTEGER NOT NULL,status TEXT NOT NULL CHECK (status IN ('sale','refund')));" +
  'CREATE INDEX IF NOT EXISTS ix_ops_company_day ON operations(company_id,sold_on);' +
  'CREATE TABLE IF NOT EXISTS imports (company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,source TEXT NOT NULL,row_count INTEGER NOT NULL);'
);
const st={
  user:db.prepare('INSERT OR IGNORE INTO users(telegram_id) VALUES(?)'),
  first:db.prepare('SELECT id,name,industry FROM companies WHERE owner_id=? ORDER BY created_at LIMIT 1'),
  newCompany:db.prepare('INSERT INTO companies(id,owner_id,name,industry) VALUES(?,?,?,?)'),
  rows:db.prepare('SELECT sold_on,source_id,item,amount_kopecks,status FROM operations WHERE company_id=? AND sold_on>=? AND sold_on<=?'),
  wipe:db.prepare('DELETE FROM operations WHERE company_id=?'),
  add:db.prepare('INSERT INTO operations(company_id,sold_on,source_id,item,amount_kopecks,status) VALUES(?,?,?,?,?,?)'),
  upsert:db.prepare('INSERT INTO imports(company_id,source,row_count) VALUES(?,?,?) ON CONFLICT(company_id) DO UPDATE SET imported_at=CURRENT_TIMESTAMP,source=excluded.source,row_count=excluded.row_count'),
  latest:db.prepare('SELECT imported_at,source,row_count FROM imports WHERE company_id=?')
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
  let c=st.first.get(id);
  if(!c){st.newCompany.run(randomUUID(),id,'Моя компания','other');c=st.first.get(id);}
  return c;
}
const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'});
function mskToday(){const p=Object.fromEntries(fmt.formatToParts(new Date()).map(x=>[x.type,x.value]));return [p.year,p.month,p.day].join('-');}
function shift(day,n){const x=new Date(day+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);}
function report(c){
  const end=shift(mskToday(),-1),start=shift(end,-59),cut=shift(end,-29);
  const entries=st.rows.all(c.id,start,end),cur=entries.filter(x=>x.sold_on>=cut),prev=entries.filter(x=>x.sold_on<cut);
  const sum=rows=>rows.reduce((a,x)=>a+x.amount_kopecks,0);
  const receipts=new Set(cur.filter(x=>x.status==='sale').map(x=>x.source_id)).size;
  const revenue=sum(cur),previous=sum(prev);
  const day7=shift(end,-6);
  const chart7=Array.from({length:7},(_,i)=>{const date=shift(day7,i);return {date,amount_kopecks:sum(entries.filter(x=>x.sold_on===date))};});
  const totals=new Map();
  for(const x of cur)totals.set(x.item,(totals.get(x.item)||0)+x.amount_kopecks);
  const top3=[...totals].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([item,amount_kopecks])=>({item,amount_kopecks}));
  const src=st.latest.get(c.id);
  return {company:c,as_of:end,period:{from:cut,to:end},revenue30_kopecks:revenue,previous30_kopecks:previous,
    change_percent:previous>0?Math.round((revenue-previous)/previous*1000)/10:null,
    yesterday_kopecks:chart7[6].amount_kopecks,receipt_count:receipts,
    average_receipt_kopecks:receipts>0?Math.round(revenue/receipts):null,chart7,top3,
    source:src?{name:src.source,imported_at:src.imported_at,rows:src.row_count}:null,
    warning:src?null:'Отчёт ещё не загружен. Здесь пока нет финансовых данных.'};
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
    if(!r||typeof r.date!=='string'||!(/^\d{4}-\d{2}-\d{2}$/).test(r.date)||Number.isNaN(Date.parse(r.date+'T00:00:00Z'))||new Date(r.date+'T00:00:00Z').toISOString().slice(0,10)!==r.date||r.date>today||r.date<shift(today,-730))throw Error('Invalid date');
    if(typeof r.id!=='string'||!r.id.trim()||r.id.length>100||typeof r.item!=='string'||!r.item.trim()||r.item.length>140)throw Error('Invalid ID or item');
    if(!Number.isSafeInteger(r.amount_kopecks)||Math.abs(r.amount_kopecks)>1e12||r.amount_kopecks===0)throw Error('Invalid amount');
    if(!['sale','refund'].includes(r.status)||(r.status==='sale'&&r.amount_kopecks<0)||(r.status==='refund'&&r.amount_kopecks>0))throw Error('Invalid status');
    const key=[r.date,r.id,r.item,r.amount_kopecks,r.status].join('\u0000');
    if(!seen.has(key)){result.push(r);seen.add(key);}
  }
  return result;
}
function ingest(c,input){
  const rows=normalize(input);
  db.exec('BEGIN IMMEDIATE');
  try{
    st.wipe.run(c.id);
    for(const x of rows)st.add.run(c.id,x.date,x.id,x.item,x.amount_kopecks,x.status);
    st.upsert.run(c.id,input.source.trim(),rows.length);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return rows.length;
}
const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin;
  if(origin&&!allowedOrigins.has(origin))return reply(res,403,{error:'Origin not allowed'});
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':origin||'https://balakhmatov.github.io','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'X-Telegram-Init-Data, Content-Type','Access-Control-Max-Age':'600','Vary':'Origin'});res.end();return;}
  const url=new URL(req.url,'http://127.0.0.1');
  if(req.method==='GET'&&url.pathname==='/api/health')return reply(res,200,{status:'ok',service:'business-pulse-api',db:db.prepare('SELECT 1 AS ok').get().ok===1},origin);
  if(!url.pathname.startsWith('/api/'))return reply(res,404,{error:'Not found'},origin);
  let id;try{id=telegramID(req.headers['x-telegram-init-data']);}catch{return reply(res,401,{error:'Open the app in Telegram again'},origin);}
  try{
    const c=companyFor(id);
    if(req.method==='GET'&&url.pathname==='/api/me')return reply(res,200,{authenticated:true,company:c},origin);
    if(req.method==='GET'&&url.pathname==='/api/report')return reply(res,200,report(c),origin);
    if(req.method==='POST'&&url.pathname==='/api/import'){const input=await readJSON(req);const saved=ingest(c,input);return reply(res,200,{saved,report:report(c)},origin);}
    return reply(res,404,{error:'Unknown API route'},origin);
  }catch(e){console.error('API request rejected:',e.message);return reply(res,e.status||400,{error:e.status===413?'File too large':e.message},origin);}
});
server.listen(port,'127.0.0.1',()=>console.log('Business Pulse API started on 127.0.0.1:'+port));
