// Comparable windows INSIDE the selected date range, not an assumed earlier
// reporting history. Only aggregated amounts, never rows, IDs or patient data
// are sent to the AI model.
const DAY=86400000;
const shift=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
const money=k=>Math.round(k/100).toLocaleString('ru-RU')+' ₽';
const pct=(a,b)=>((a-b)/b*100).toFixed(1).replace('.',',')+'%';
const sum=rows=>rows.reduce((total,row)=>total+row.amount_kopecks,0);
const coverage=rows=>new Set(rows.map(row=>row.sold_on)).size;
const receiptCount=rows=>new Set(rows.filter(row=>row.status==='sale')
  .map(row=>row.sold_on+'\u0000'+row.source_id)).size;
const safeItem=raw=>{
  const item=String(raw||'').replace(/\s+/g,' ').trim();
  return item&&item.length<=80&&!/[\n\r@]|(?:\+7|8)[\d() -]{10,}|\b\d{6,}\b/i.test(item)?item:null;
};
function itemTotals(rows){
  const totals=new Map();
  for(const row of rows){
    const item=safeItem(row.item);
    if(item)totals.set(item,(totals.get(item)||0)+row.amount_kopecks);
  }
  return totals;
}
function sliceStats(from,to,rows){
  const selected=rows.filter(row=>row.sold_on>=from&&row.sold_on<=to);
  return {from,to,rows:selected,sum:sum(selected),covered:coverage(selected),receipts:receiptCount(selected)};
}
function windowLength(days){
  if(days<14)return 0; // Too little history for meaningful trend slices
  if(days<=45)return 7;
  if(days<=120)return 30;
  if(days<=400)return 30;
  return 90;
}
export function buildInPeriodFacts(report,operations){
  const {from,to,days}=report.period,interval=windowLength(days);
  if(!interval)return {};
  const windows=[];
  const count=Math.min(12,Math.floor(days/interval));
  if(count<2)return {};
  const current=operations.filter(row=>row.sold_on>=from&&row.sold_on<=to);
  // Anchor all windows at the selected end, so all comparisons have exactly
  // the same length, even when calendar months are partially represented.
  for(let i=count-1;i>=0;i--){
    const start=shift(to,-((i+1)*interval-1)),end=shift(to,-i*interval);
    const part=sliceStats(start,end,current);
    part.reliable=part.covered>=Math.max(2,Math.ceil(interval*.55));
    windows.push(part);
  }
  const facts={};
  for(const [index,w] of windows.entries()){
    if(!w.reliable)continue;
    facts['selected_window_'+(index+1)]='Внутри выбранного периода, отрезок '+w.from+
      ' — '+w.to+': сумма '+money(w.sum)+', '+w.receipts+
      (report.operation_identity?.estimated?' условных групп операций':' уникальных чеков')+
      ', дней с операциями '+w.covered+' из '+interval+'.';
  }
  const recent=windows.at(-1),before=windows.at(-2),first=windows[0];
  if(recent.reliable&&before.reliable&&before.sum>0){
    facts.within_period_latest_change='Динамика ВНУТРИ выбранного периода: за '+recent.from+' — '+recent.to+
      ' сумма '+money(recent.sum)+', за равный предшествующий отрезок '+before.from+
      ' — '+before.to+' сумма '+money(before.sum)+', изменение '+
      (recent.sum>=before.sum?'+':'')+pct(recent.sum,before.sum)+'.';
    if(!report.operation_identity?.estimated&&before.receipts>0){
      facts.within_period_receipts='Количество уникальных чеков внутри выбранного периода: '+
        recent.receipts+' за '+recent.from+' — '+recent.to+
        ' против '+before.receipts+' за '+before.from+' — '+before.to+
        '; изменение '+(recent.receipts>=before.receipts?'+':'')+
        pct(recent.receipts,before.receipts)+'.';
    }
    const latestItems=itemTotals(recent.rows),earlierItems=itemTotals(before.rows);
    const changed=[...new Set([...latestItems.keys(),...earlierItems.keys()])]
      .map(name=>({name,old:earlierItems.get(name)||0,now:latestItems.get(name)||0}))
      .filter(x=>x.old>0&&Math.abs(x.now-x.old)>=Math.max(100000,Math.abs(x.old)*.10))
      .sort((a,b)=>(b.now-b.old)-(a.now-a.old));
    let gains=0,losses=0;
    for(const x of changed){
      if(x.now>x.old&&gains<2){
        facts['within_period_item_growth_'+(++gains)]='Рост услуги или товара «'+x.name+
          '» внутри выбранного периода: '+money(x.now)+' за '+recent.from+' — '+recent.to+
          ' против '+money(x.old)+' за '+before.from+' — '+before.to+
          ', изменение +'+pct(x.now,x.old)+'.';
      }else if(x.now<x.old&&losses<2){
        facts['within_period_item_decline_'+(++losses)]='Снижение услуги или товара «'+x.name+
          '» внутри выбранного периода: '+money(x.now)+' за '+recent.from+' — '+recent.to+
          ' против '+money(x.old)+' за '+before.from+' — '+before.to+
          ', изменение '+pct(x.now,x.old)+'.';
      }
      if(gains>=2&&losses>=2)break;
    }
  }
  if(windows.length>=3&&first.reliable&&recent.reliable&&first.sum>0){
    facts.within_period_first_last='Изменение от первого к последнему равному отрезку ВНУТРИ выбранного периода: '+
      money(first.sum)+' за '+first.from+' — '+first.to+', '+
      money(recent.sum)+' за '+recent.from+' — '+recent.to+', изменение '+
      (recent.sum>=first.sum?'+':'')+pct(recent.sum,first.sum)+'.';
  }
  return facts;
}
