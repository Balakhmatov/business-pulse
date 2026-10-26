import {createHmac,randomBytes} from 'node:crypto';
import smartImport from '../smart-import.js';

// No patient contacts/names are persisted. A company-specific random secret
// prevents linking the same ID/contact between independent company workspaces.
export function createCustomerIdentity(db){
  db.exec(`CREATE TABLE IF NOT EXISTS customer_identity_secrets (
    company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    secret TEXT NOT NULL);`);
  const read=db.prepare('SELECT secret FROM customer_identity_secrets WHERE company_id=?');
  const insert=db.prepare('INSERT OR IGNORE INTO customer_identity_secrets(company_id,secret) VALUES(?,?)');
  return {key(companyId,value,kind){
    if(value===undefined||value===null||value==='')return undefined;
    if(typeof value!=='string'||value.length>200||!['id','phone','email','name'].includes(kind))
      throw Error('Для пациента выберите ID, телефон, email или ФИО.');
    const normalized=smartImport.normalizeCustomerRef(value,kind);
    if(!normalized)return undefined;
    let secret=read.get(companyId)?.secret;
    if(!secret){insert.run(companyId,randomBytes(32).toString('hex'));secret=read.get(companyId).secret;}
    const code=createHmac('sha256',secret).update(JSON.stringify([kind,normalized])).digest('hex');
    return kind==='name'?'name-v1:'+code:code;
  }};
}
const daysBetween=(a,b)=>Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000);
const pct=(a,b)=>b?Math.round(a/b*1000)/10:null;
const average=values=>values.length?Math.round(values.reduce((a,b)=>a+b,0)/values.length):null;
const median=values=>{if(!values.length)return null;const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:Math.round((a[m-1]+a[m])/2);};
function repeatMetrics(sourceRows,period){
  const visits=new Map();
  for(const row of sourceRows){
    if(!row.customer_key)continue;
    let p=visits.get(row.customer_key);
    if(!p){p={dates:new Set(),ids:new Map()};visits.set(row.customer_key,p);}
    p.dates.add(row.sold_on);p.ids.set(row.sold_on+'\0'+row.source_id,row.sold_on);
  }
  const all=[...visits.values()].map(p=>({...p,days:[...p.dates].sort()}));
  const active=all.filter(p=>p.days.some(d=>d>=period.from));
  const returning=active.filter(p=>p.days.length>1&&p.days.some(d=>d>=period.from&&d>p.days[0]));
  const gaps=all.flatMap(p=>p.days.slice(1).map((d,i)=>daysBetween(p.days[i],d)));
  const retention=(group,n)=>{
    const eligible=group.filter(p=>daysBetween(p.days[0],period.to)>=n);
    const returned=eligible.filter(p=>p.days[1]&&daysBetween(p.days[0],p.days[1])<=n);
    return {days:n,eligible:eligible.length,returned:returned.length,percent:pct(returned.length,eligible.length)};
  };
  const cohorts=new Map();
  for(const p of all){const month=p.days[0].slice(0,7);if(!cohorts.has(month))cohorts.set(month,[]);cohorts.get(month).push(p);}
  const periodVisitCount=active.reduce((n,p)=>n+[...p.ids.values()].filter(d=>d>=period.from).length,0);
  const nameBased=[...visits.keys()].filter(key=>key.startsWith('name-v1:')).length;
  const synthetic=sourceRows.filter(row=>row.source_id.startsWith('AUTO-DAY-V1-')).length;
  return {available:all.length>0,patients:all.length,period_patients:active.length,
    first_observed_patients:active.filter(p=>p.days[0]>=period.from).length,
    returning_patients:returning.length,returning_percent:pct(returning.length,active.length),
    period_visits:periodVisitCount,visits_per_patient:active.length?Math.round(periodVisitCount/active.length*100)/100:null,
    average_gap_days:average(gaps),
    absent_90_days:all.filter(p=>daysBetween(p.days.at(-1),period.to)>=90).length,
    absent_180_days:all.filter(p=>daysBetween(p.days.at(-1),period.to)>=180).length,
    name_based_patients:nameBased,synthetic_rows:synthetic,estimated:nameBased>0||synthetic>0,
    coverage:{identified_rows:sourceRows.filter(r=>r.customer_key).length,total_rows:sourceRows.length},
    retention:[30,90,180,365].map(n=>retention(all,n)),
    cohorts:[...cohorts].sort(([a],[b])=>b.localeCompare(a)).slice(0,12)
      .map(([month,group])=>({month,patients:group.length,retention:[30,90,180].map(n=>retention(group,n))}))};
}
export function calculateCustomerAnalytics(rows,period,basis){
  // Bound by selected end: later imports never leak future visits into cohorts.
  const availableRows=rows.filter(r=>r.sold_on<=period.to);
  const moneyRows=availableRows.filter(r=>r.financial_basis===basis||r.financial_basis==='paid_fulfilled'&&basis!=='unverified');
  const matched=moneyRows.filter(r=>r.customer_key);
  const patients=new Map();
  for(const row of matched){
    let p=patients.get(row.customer_key);
    if(!p){p={net:0,receipts:new Set(),active:false};patients.set(row.customer_key,p);}
    p.net+=row.amount_kopecks;
    if(row.status==='sale')p.receipts.add(row.sold_on+'\0'+row.source_id);
    if(row.sold_on>=period.from)p.active=true;
  }
  const patientsWithSales=[...patients.values()].filter(p=>p.receipts.size);
  const net=[...patients.values()].reduce((n,p)=>n+p.net,0);
  const receipts=[...patients.values()].reduce((n,p)=>n+p.receipts.size,0);
  const visits=repeatMetrics(availableRows.filter(r=>['recognized_revenue','paid_fulfilled'].includes(r.financial_basis)&&r.status==='sale'),period);
  const activity=repeatMetrics(moneyRows.filter(r=>r.status==='sale'),period);
  const nameBased=[...patients.keys()].filter(key=>key.startsWith('name-v1:')).length;
  const synthetic=moneyRows.filter(row=>row.source_id.startsWith('AUTO-DAY-V1-')).length;
  return {
    available:matched.length>0||visits.available,
    history_from:availableRows.length?availableRows.reduce((d,r)=>r.sold_on<d?r.sold_on:d,availableRows[0].sold_on):null,
    as_of:period.to,period:{from:period.from,to:period.to},
    financial:{basis,patients:patients.size,patients_with_sales:patientsWithSales.length,
      active_patients:[...patients.values()].filter(p=>p.active).length,
      coverage:{identified_rows:matched.length,total_rows:moneyRows.length,percent:pct(matched.length,moneyRows.length)},
      net_kopecks:matched.length?net:null,
      average_ltv_kopecks:patients.size?Math.round(net/patients.size):null,
      median_ltv_kopecks:median([...patients.values()].map(p=>p.net)),
      average_receipt_kopecks:receipts?Math.round(net/receipts):null,
      receipts_per_patient:patients.size?Math.round(receipts/patients.size*100)/100:null,
      name_based_patients:nameBased,synthetic_rows:synthetic,estimated:nameBased>0||synthetic>0||basis==='unverified'},
    visits,activity
  };
}
