import { PLANS } from './billing.mjs';
export function ensurePaymentLinks(db){
  db.exec('CREATE TABLE IF NOT EXISTS billing_payment_links (plan TEXT PRIMARY KEY,url TEXT NOT NULL,updated_by TEXT NOT NULL,updated_ms INTEGER NOT NULL);'+
    'CREATE TABLE IF NOT EXISTS billing_link_sessions (actor_id TEXT PRIMARY KEY,plan TEXT NOT NULL,expires_ms INTEGER NOT NULL);');
}
export function checkedPaymentURL(value){
  let u;try{u=new URL(value.trim());}catch{throw Error('Пришлите платёжную ссылку ЮKassa, начинающуюся с https://.');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||u.href.length>2048||
    !['yookassa.ru','yoomoney.ru'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))
    throw Error('Нужна HTTPS-ссылка платёжной страницы ЮKassa или ЮMoney. Секретные ключи сюда отправлять нельзя.');
  return u.href;
}
export function paymentCatalog(db){
  const links=new Map(db.prepare('SELECT plan,url FROM billing_payment_links').all().map(r=>[r.plan,r.url]));
  return Object.entries(PLANS).map(([id,p])=>({id,...p,payment_url:links.get(id)||null}));
}
export function savePaymentLink(db,plan,url,actor,at=Date.now()){
  if(!Object.hasOwn(PLANS,plan))throw Error('Тариф не найден.');
  db.prepare('INSERT INTO billing_payment_links VALUES(?,?,?,?) ON CONFLICT(plan) DO UPDATE SET url=excluded.url,updated_by=excluded.updated_by,updated_ms=excluded.updated_ms')
    .run(plan,checkedPaymentURL(url),String(actor),at);
}
