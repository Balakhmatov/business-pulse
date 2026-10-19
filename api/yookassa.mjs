import { randomUUID } from 'node:crypto';
import { PLANS,subscriptionFor,addCalendarMonths } from './billing.mjs';
import { checkedPaymentURL } from './payment-links.mjs';

const fail=(message,status=400)=>Object.assign(Error(message),{status});
export function createPayments({db,shopId=process.env.YOOKASSA_SHOP_ID,secretKey=process.env.YOOKASSA_SECRET_KEY,fetcher=fetch,now=Date.now}){
  db.exec(`CREATE TABLE IF NOT EXISTS billing_payments (
    id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),actor_id TEXT NOT NULL,
    plan TEXT NOT NULL,amount INTEGER NOT NULL,created_ms INTEGER NOT NULL,promo_ends_ms INTEGER,
    provider_id TEXT UNIQUE,payment_url TEXT,status TEXT NOT NULL DEFAULT 'creating',applied_ms INTEGER);
    CREATE INDEX IF NOT EXISTS ix_payments_company ON billing_payments(company_id);`);
  const ready=Boolean(shopId&&secretKey),busy=new Map();
  async function request(path,body,key){
    if(!ready)throw fail('Оплата временно недоступна. Обратитесь в поддержку.',503);
    try{
      const response=await fetcher('https://api.yookassa.ru/v3/payments'+path,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(shopId+':'+secretKey).toString('base64'),'Content-Type':'application/json',...(key?{'Idempotence-Key':key}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error();
      return await response.json();
    }catch{throw fail('Не удалось проверить платёж в ЮKassa. Попробуйте ещё раз.',502);}
  }
  function apply(row,p){
    if(p.id!==row.provider_id||p.amount?.value!==(row.amount/100).toFixed(2)||p.amount?.currency!=='RUB'||p.metadata?.bp_payment_id!==row.id||p.metadata?.company_id!==row.company_id||p.metadata?.product!=='business-pulse'||String(p.recipient?.account_id)!==String(shopId))throw fail('Платёж не прошёл проверку.',502);
    if(!['pending','waiting_for_capture','succeeded','canceled'].includes(p.status))throw fail('Неизвестный статус платежа.',502);
    db.exec('BEGIN IMMEDIATE');
    try{
      row=db.prepare('SELECT * FROM billing_payments WHERE id=?').get(row.id);
      if(!row.applied_ms){
        let status=p.status;
        if(p.status==='succeeded'){
          const paidAt=Date.parse(p.captured_at),s=subscriptionFor(db,{id:row.company_id});
          if(p.paid!==true||p.test===true||!Number.isFinite(paidAt)||paidAt<row.created_ms-60000||paidAt>now()+60000)throw fail('Платёж не прошёл проверку.',502);
          if(row.plan==='welcome'&&(paidAt>=row.promo_ends_ms||s.plan!==null))status='needs_review';
          else{
            const end=addCalendarMonths(Math.max(paidAt,s.trial_ends_ms,s.paid_until_ms||0),PLANS[row.plan].months);
            db.prepare('UPDATE company_billing SET paid_until_ms=?,plan=? WHERE company_id=?').run(end,row.plan,row.company_id);
            db.prepare('INSERT INTO billing_grants VALUES(?,?,?,?,?,?,?)').run('yookassa:'+row.id,row.company_id,row.actor_id,row.plan,row.amount/100,now(),end);
            db.prepare('UPDATE billing_payments SET applied_ms=? WHERE id=?').run(now(),row.id);
          }
        }
        db.prepare('UPDATE billing_payments SET status=? WHERE id=?').run(status,row.id);
      }
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    return db.prepare('SELECT * FROM billing_payments WHERE id=?').get(row.id);
  }
  async function sync(row){
    if(!row.provider_id){
      // YooKassa retains idempotence keys for 24 hours. Never recreate an uncertain older payment.
      if(now()-row.created_ms>=23*3600000)throw fail('Статус платежа уточняется. Обратитесь в поддержку.',409);
      const p=await request('',{amount:{value:(row.amount/100).toFixed(2),currency:'RUB'},capture:true,payment_method_data:{type:'sbp'},confirmation:{type:'redirect',return_url:'https://t.me/business_pulse_app_bot?start=payment'},description:'Бизнес Пульс: '+PLANS[row.plan].name,metadata:{product:'business-pulse',bp_payment_id:row.id,company_id:row.company_id,plan:row.plan}},row.id);
      if(typeof p.id!=='string'||!p.id)throw fail('Некорректный ответ ЮKassa.',502);
      const url=p.confirmation?.confirmation_url?checkedPaymentURL(p.confirmation.confirmation_url):null;
      db.prepare('UPDATE billing_payments SET provider_id=?,payment_url=? WHERE id=?').run(p.id,url,row.id);
      row={...row,provider_id:p.id,payment_url:url};
      return apply(row,p);
    }
    return apply(row,await request('/'+encodeURIComponent(row.provider_id)));
  }
  function locked(key,fn){if(busy.has(key))return busy.get(key);const p=fn().finally(()=>busy.delete(key));busy.set(key,p);return p;}
  const view=row=>({id:row.id,status:row.status,payment_url:['pending','waiting_for_capture'].includes(row.status)?row.payment_url:null,plan:row.plan,amount:row.amount/100});
  async function create(c,actor,plan){
    if(!Object.hasOwn(PLANS,plan))throw fail('Выберите тариф из списка.');
    if(!ready)throw fail('Оплата временно недоступна.',503);
    return locked(c.id,async()=>{
      let row=db.prepare("SELECT * FROM billing_payments WHERE company_id=? AND status IN ('creating','pending','waiting_for_capture') ORDER BY created_ms DESC LIMIT 1").get(c.id);
      if(row){row=await sync(row);if(['creating','pending','waiting_for_capture','needs_review'].includes(row.status)){
        if(row.plan!==plan)throw fail('У вас уже есть незавершённый платёж. Завершите его или дождитесь отмены.',409);
        return view(row);
      }if(row.status==='succeeded')return view(row);}
      const at=now(),s=subscriptionFor(db,c,at);
      if(plan==='welcome'&&!subscriptionFor(db,c,at)?.promo_available)throw fail('Цена 1 990 ₽ доступна только для первой оплаты в тестовые 48 часов.');
      const id=randomUUID();
      db.prepare('INSERT INTO billing_payments(id,company_id,actor_id,plan,amount,created_ms,promo_ends_ms) VALUES(?,?,?,?,?,?,?)').run(id,c.id,String(actor),plan,PLANS[plan].price*100,at,plan==='welcome'?s.trial_ends_ms:null);
      return view(await sync(db.prepare('SELECT * FROM billing_payments WHERE id=?').get(id)));
    });
  }
  async function refresh(c){return locked(c.id,async()=>{
    const rows=db.prepare("SELECT * FROM billing_payments WHERE company_id=? AND status IN ('creating','pending','waiting_for_capture')").all(c.id);
    for(const row of rows)await sync(row);
    return subscriptionFor(db,c);
  });}
  async function reconcile(){
    if(!ready)return;
    for(const c of db.prepare("SELECT DISTINCT company_id AS id FROM billing_payments WHERE status IN ('creating','pending','waiting_for_capture')").all())try{await refresh(c);}catch{console.error('Business Pulse payment reconciliation pending');}
  }
  return {ready,create,refresh,reconcile};
}
