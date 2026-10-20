import { calculateFinancialSummary } from './api/finance-summary.mjs';

// Demo and personal workspaces use the same financial arithmetic.
export function demoSummary(dataset,industry,end,basis=null){
  const rows=dataset.rows.map(row=>({
    sold_on:row.date,source_id:row.id,item:row.item,status:row.status,
    amount_kopecks:Math.round(row.amount*100),quantity_milli:row.quantity_milli??null,
    financial_basis:row.financial_basis||'unverified'
  }));
  const counts={};for(const row of rows)counts[row.financial_basis]=(counts[row.financial_basis]||0)+1;
  return calculateFinancialSummary(rows,counts,end,basis,industry);
}

export function withDemoBooks(rows){
  return rows.flatMap((row,i)=>{
    const quantity_milli=row.quantity_milli||1000;
    const done={...row,quantity_milli,financial_basis:'recognized_revenue'};
    // Cash is a separate synthetic stream: partial payments and advances do
    // not imply an outstanding customer debt or an additional completed sale.
    const paid={...row,id:'P-'+row.id,amount:Math.round(row.amount*(i%11===0?0.6:i%17===0?1.2:1)),quantity_milli,financial_basis:'cash_receipts'};
    return [done,paid];
  });
}

// Illustrative narratives are derived from visible demo figures. They are
// labelled as examples, never as a live response from the production AI.
export function demoAnalysis(dataset,report){
 const basis=report.primary_basis;
 const money=k=>Math.round(k/100).toLocaleString('ru-RU')+' ₽';
 const pct=n=>(n>0?'+':'')+n.toFixed(1).replace('.',',')+'%';
 const label=basis==='cash_receipts'?'Поступления':'Продажи';
 const rows=dataset.rows.filter(x=>x.financial_basis===basis);
 const current=rows.filter(x=>x.date>=report.period.from&&x.date<=report.as_of);
 const previous=rows.filter(x=>x.date<report.period.from&&x.date>=new Date(Date.parse(report.period.from+'T12:00:00Z')-30*86400000).toISOString().slice(0,10));
 const count=items=>new Set(items.filter(x=>x.status==='sale').map(x=>x.date+'|'+x.id)).size;
 const cards=[];
 if(basis==='unverified')return {summary:'Сначала нужно уточнить смысл сумм: для анализа оплат и продаж требуются подтверждённые данные.',cards};
 if(report.coverage.comparable&&report.change_percent!==null){
  const change=report.change_percent;
  const prevCount=count(previous),currentCount=count(current);
  const countChange=prevCount>0?(currentCount-prevCount)/prevCount*100:null;
  const previousAverage=prevCount>0?report.previous30_kopecks/prevCount:0;
  const averageChange=previousAverage>0&&report.average_receipt_kopecks!==null?(report.average_receipt_kopecks-previousAverage)/previousAverage*100:null;
  const explanation=countChange!==null&&averageChange!==null
   ?'Число операций изменилось на '+pct(countChange)+', средний чек — на '+pct(averageChange)+'. Это помогает отделить изменение потока от изменения суммы одной операции.'
   :'Сравнение охватывает два периода по 30 завершённых дней.';
  cards.push({title:label+(change>0?' растут':change<0?' снизились':' без изменения'),evidence:money(report.revenue30_kopecks)+' · '+pct(change)+' к прошлым 30 дням',explanation,
   action:change<0?'Сопоставьте загрузку и средний чек с прошлым периодом: начните с показателя, который снизился сильнее.':'Проверьте, какие направления поддерживают результат, и сохраните их загрузку.'});
 }else cards.push({title:'Для оценки динамики нужна история',evidence:'Сейчас '+report.coverage.current_days+' из 30 дней · ранее '+report.coverage.previous_days+' из 30',explanation:'Неполный отчёт может создать видимость роста или снижения.',action:'Соберите данные за оба периода перед оценкой изменений.'});
 const top=report.top3.filter(x=>x.amount_kopecks>0);
 const topSum=top.reduce((n,x)=>n+x.amount_kopecks,0);
 const share=report.revenue30_kopecks>0?topSum/report.revenue30_kopecks*100:null;
 if(top.length&&share!==null&&share>=0&&share<=100)cards.push({title:'Что формирует основной результат',evidence:'Топ-3 позиции · '+share.toFixed(1).replace('.',',')+'% от суммы',explanation:'Три крупнейшие позиции дают '+money(topSum)+'. Такая концентрация показывает, где изменения спроса заметнее всего отразятся на результате.',action:'Проверьте доступность и загрузку ведущих позиций. Приоритет по прибыли потребует данных о расходах.'});
 const refunds=current.filter(x=>x.status==='refund'),refundAmount=refunds.reduce((n,x)=>n+Math.abs(Math.round(x.amount*100)),0);
 if(refunds.length)cards.push({title:'Возвраты требуют отдельного внимания',evidence:refunds.length+' строк возврата · '+money(refundAmount),explanation:'Возвраты уже уменьшили выбранный показатель. Их наличие само по себе не объясняет причину изменения.',action:'Проверьте причины возвратов и повторяющиеся позиции, прежде чем менять ассортимент или процесс обслуживания.'});
 else{
  const days=report.chart7,peak=days.reduce((a,b)=>b.amount_kopecks>a.amount_kopecks?b:a,days[0]);
  if(peak&&peak.amount_kopecks>0)cards.push({title:'Где проверить нагрузку',evidence:money(peak.amount_kopecks)+' · '+new Date(peak.date+'T12:00:00Z').toLocaleDateString('ru-RU',{day:'numeric',month:'long',timeZone:'Europe/Moscow'}),explanation:'Это максимальная сумма за последние семь завершённых дней. Один пик ещё не доказывает устойчивую закономерность.',action:'Сопоставьте пиковый день с расписанием, рекламой и доступностью команды; проверьте повторение на более длинной истории.'});
 }
 const summary=label+' за 30 дней — '+money(report.revenue30_kopecks)+'. '+(report.change_percent!==null?'Изменение к прошлому периоду: '+pct(report.change_percent)+'. ':'Для сравнения пока недостаточно истории. ')+'Разбор связывает динамику, структуру операций и концентрацию результата, чтобы выбрать следующий шаг.';
 return {summary,cards};
}
