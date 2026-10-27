const shift=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const money=k=>Math.round(k/100).toLocaleString('ru-RU')+' ₽';
const distinctDays=arr=>new Set(arr.map(x=>x.sold_on)).size;
// Aggregated facts only, no original operation identifiers or user information.
export function buildHistoricalFacts(report,operations){
  const {from,to,days,previous_from,previous_to}=report.period;
  const now=operations.filter(x=>x.sold_on>=from&&x.sold_on<=to);
  const old=operations.filter(x=>x.sold_on>=previous_from&&x.sold_on<=previous_to);
  const total=arr=>arr.reduce((v,x)=>v+x.amount_kopecks,0);
  const count=arr=>new Set(arr.filter(x=>x.status==='sale').map(x=>x.sold_on+'\u0000'+x.source_id)).size;
  const facts={
    selected_period:'Выбранный период: '+from+' — '+to+' ('+days+' дней), '+now.length+' строк операций, сумма '+money(total(now))+'.'
  };
  // An unavailable earlier history must not become the dominant AI "problem".
  // Within-period rolling windows are supplied independently by ai-inperiod.mjs.
  if(report.coverage?.comparable){
    facts.previous_period='Предыдущий равный по длине период: '+previous_from+' — '+previous_to+
      ', сумма '+money(total(old))+', уникальных чеков '+count(old)+'.';
  }
  const months=new Map(),years=new Map();
  for(const row of now){
    const m=row.sold_on.slice(0,7),y=row.sold_on.slice(0,4);
    const ms=months.get(m)||{sum:0,ids:new Set(),days:new Set()};
    ms.sum+=row.amount_kopecks;ms.days.add(row.sold_on);
    if(row.status==='sale')ms.ids.add(row.sold_on+'\u0000'+row.source_id);
    months.set(m,ms);
    const ys=years.get(y)||{sum:0,days:new Set()};
    ys.sum+=row.amount_kopecks;ys.days.add(row.sold_on);years.set(y,ys);
  }
  let ix=0;
  for(const [month,stats] of [...months].sort(([a],[b])=>a.localeCompare(b))){
    // 36 month windows fit comfortably in grounded structured prompt.
    facts['month_'+(++ix)]='Месяц '+month+': '+money(stats.sum)+
      ', '+(report.operation_identity?.estimated?'условных групп записей ':'уникальных чеков ')+stats.ids.size+', дней с операциями '+stats.days.size+'.';
  }
  for(const [year,stats] of [...years].sort(([a],[b])=>a.localeCompare(b)))
    facts['year_'+year]='В '+year+' году в выбранном диапазоне: '+money(stats.sum)+
      ', дней с операциями '+stats.days.size+'. Неполный календарный год нельзя сравнивать с полным.';
  if(report.change_percent!==null)
    facts.period_change='Сопоставимое изменение суммы к предыдущему равному периоду: '+
      (report.change_percent>0?'+':'')+String(report.change_percent).replace('.',',')+'%.';
  facts.analysis_limits='Нет сведений о фактической прибыли, марже, расходах на рекламу, новых пациентах или клиентах; месяцы с неполной выгрузкой нельзя трактовать как доказанное снижение продаж.';
  return facts;
}
