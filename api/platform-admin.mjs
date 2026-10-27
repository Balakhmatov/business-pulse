import {PLANS,isAdminCompany} from './billing.mjs';

const fail=(message,status=400)=>Object.assign(Error(message),{status});
const DAY=86400000;
// Authorize the authenticated person, never the company they happen to work in.
export function isPlatformAdmin(db,actor){
  if(/^[1-9]\d{0,15}$/.test(String(actor))&&isAdminCompany({owner_id:actor}))return true;
  if(!String(actor).startsWith('web:'))return false;
  const webAdmins=new Set((process.env.BP_ADMIN_WEB_IDS||'').split(',').map(v=>v.trim()).filter(v=>/^web:[0-9a-f-]{36}$/.test(v)));
  if(webAdmins.has(String(actor))&&db.prepare('SELECT 1 FROM web_accounts WHERE actor_id=?').get(actor))return true;
  const link=db.prepare('SELECT telegram_id FROM account_links WHERE web_actor_id=?').get(actor);
  return Boolean(link&&isAdminCompany({owner_id:link.telegram_id}));
}
export function createPlatformAdmin(db,now=Date.now){
  const base=`WITH ops AS (SELECT company_id,COUNT(*) operation_count FROM operations GROUP BY company_id),
    members AS (SELECT company_id,COUNT(*) member_count FROM company_members GROUP BY company_id)
    SELECT c.id,c.owner_id,c.name,c.industry,c.created_at,(SELECT email FROM web_accounts WHERE actor_id=c.owner_id OR actor_id=(SELECT web_actor_id FROM account_links WHERE company_id=c.id LIMIT 1) LIMIT 1) email,
    b.trial_started_ms,b.trial_ends_ms,b.trial_granted_by,b.paid_until_ms,b.plan,
    COALESCE(o.operation_count,0) operation_count,COALESCE(m.member_count,0) member_count,
    i.imported_at last_import_at,i.last_change_at,
    (SELECT telegram_id FROM account_links WHERE company_id=c.id LIMIT 1) linked_telegram_id
    FROM companies c LEFT JOIN company_billing b ON b.company_id=c.id
    LEFT JOIN ops o ON o.company_id=c.id LEFT JOIN members m ON m.company_id=c.id
    LEFT JOIN imports i ON i.company_id=c.id
`;
  function companyRows(at){return db.prepare(base+' ORDER BY c.created_at DESC,c.id').all().map(c=>{
    const admin=isPlatformAdmin(db,c.owner_id)||Boolean(c.linked_telegram_id&&isAdminCompany({owner_id:c.linked_telegram_id})),paid=c.paid_until_ms>at,trial=Boolean(c.trial_granted_by)&&c.trial_started_ms<=at&&c.trial_ends_ms>at;
    const state=admin?'admin':paid?'paid':trial?'trial':!c.trial_granted_by&&c.plan===null?'pending':'expired';
    const until=state==='paid'?c.paid_until_ms:state==='trial'?c.trial_ends_ms:null;
    return {...c,state,access:['admin','paid','trial'].includes(state),access_until_ms:until,
      days_left:until?Math.ceil((until-at)/DAY):null,plan_name:PLANS[c.plan]?.name||null};
  });}
  // billing_grants is the receipt journal for applied payments, including manual
  // confirmations. Provider attempts are joined, not added a second time.
  const paymentsSQL=`SELECT p.id,p.company_id,c.name company_name,p.plan,p.amount amount_kopecks,
    p.created_ms,p.applied_ms,p.status,p.provider_id,'yookassa' channel,g.confirmed_ms confirmed_ms
    FROM billing_payments p JOIN companies c ON c.id=p.company_id
    LEFT JOIN billing_grants g ON g.token='yookassa:'||p.id
    UNION ALL SELECT g.token,g.company_id,c.name,g.plan,g.amount_rubles*100,g.confirmed_ms,g.confirmed_ms,
    'succeeded',NULL,'manual',g.confirmed_ms FROM billing_grants g JOIN companies c ON c.id=g.company_id
    WHERE g.token NOT LIKE 'yookassa:%'`;
  function range(params,at){const raw=params.get('days')||'30';if(!['7','30','90','all'].includes(raw))throw fail('Выберите период 7, 30, 90 дней или всё время.');return {days:raw,from:raw==='all'?0:at-Number(raw)*DAY};}
  function paging(params){const raw=params.get('page')||'1';if(!/^[1-9]\d{0,5}$/.test(raw))throw fail('Некорректная страница.');return Number(raw);}
  function list(items,page){const size=30;return {items:items.slice((page-1)*size,page*size),total:items.length,page,page_size:size};}
  function handle(actor,path,params=new URLSearchParams()){
    if(!isPlatformAdmin(db,actor))throw fail('Раздел доступен только администратору сервиса.',403);
    if(path==='access')return {admin:true};
    const at=now(),period=range(params,at);
    if(path==='overview'){
      const companies=companyRows(at),clientIds=new Set(companies.filter(c=>c.state!=='admin').map(c=>c.id)),grants=db.prepare('SELECT g.company_id,g.amount_rubles,g.confirmed_ms,c.owner_id FROM billing_grants g JOIN companies c ON c.id=g.company_id WHERE g.confirmed_ms>=? AND g.confirmed_ms<=?').all(period.from,at).filter(g=>clientIds.has(g.company_id));
      const clients=companies.filter(c=>c.state!=='admin');
      const attempts=db.prepare('SELECT company_id,status,created_ms,applied_ms FROM billing_payments WHERE created_ms>=? AND created_ms<=?').all(period.from,at).filter(p=>clientIds.has(p.company_id));
      return {generated_ms:at,period:period.days,summary:{companies:clients.length,admin_companies:companies.length-clients.length,
        registrations:clients.filter(c=>Date.parse(c.created_at.replace(' ','T')+'Z')>=period.from).length,
        paid:clients.filter(c=>c.state==='paid').length,trial:clients.filter(c=>c.state==='trial').length,
        pending:clients.filter(c=>c.state==='pending').length,expired:clients.filter(c=>c.state==='expired').length,
        expiring_7d:clients.filter(c=>c.access_until_ms>at&&c.access_until_ms<=at+7*DAY).length,
        with_data:clients.filter(c=>c.operation_count>0).length,
        imports_7d:clients.filter(c=>c.last_import_at&&Date.parse(c.last_import_at.replace(' ','T')+'Z')>=at-7*DAY).length,
        receipts_kopecks:Math.round(grants.reduce((s,g)=>s+g.amount_rubles*100,0)),receipt_count:grants.length,paying_companies:new Set(grants.map(g=>g.company_id)).size,
        payment_review:attempts.filter(p=>p.status==='needs_review'||p.status==='succeeded'&&!p.applied_ms).length,
        payment_open:attempts.filter(p=>['creating','pending','waiting_for_capture'].includes(p.status)).length,
        payment_canceled:attempts.filter(p=>p.status==='canceled').length}};
    }
    const page=paging(params),q=(params.get('q')||'').trim().toLowerCase();if(q.length>120)throw fail('Поисковый запрос слишком длинный.');
    if(path==='companies'){
      const status=params.get('status')||'all';if(!['all','paid','trial','pending','expired','admin','expiring','no_data'].includes(status))throw fail('Некорректный фильтр компаний.');
      return list(companyRows(at).filter(c=>(!q||[c.name,c.id,c.owner_id,c.email,c.linked_telegram_id].some(v=>String(v||'').toLowerCase().includes(q)))&&
        (status==='all'||status==='expiring'&&c.access_until_ms>at&&c.access_until_ms<=at+7*DAY||status==='no_data'&&c.operation_count===0||c.state===status)),page);
    }
    if(path==='payments'){
      const status=params.get('status')||'all';if(!['all','succeeded','pending','canceled','needs_review'].includes(status))throw fail('Некорректный фильтр платежей.');
      const rows=db.prepare('SELECT * FROM ('+paymentsSQL+') WHERE created_ms>=? AND created_ms<=? ORDER BY created_ms DESC,id').all(period.from,at);
      return list(rows.filter(p=>(!params.get('company_id')||p.company_id===params.get('company_id'))&&(!q||[p.company_name,p.id,p.provider_id].some(v=>String(v||'').toLowerCase().includes(q)))&&
        (status==='all'||status==='pending'&&['creating','pending','waiting_for_capture'].includes(p.status)||status==='needs_review'&&p.status==='succeeded'&&!p.applied_ms||p.status===status)).map(p=>({...p,plan_name:PLANS[p.plan]?.name||p.plan})),page);
    }
    throw fail('Раздел не найден.',404);
  }
  return {handle};
}
