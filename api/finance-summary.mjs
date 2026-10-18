// Arithmetic only: never derive recognized revenue from payments or vice versa.
// Historical rows are unverified until an explicit new import declares their basis.
export const BOOKS=['cash_receipts','recognized_revenue','unverified'];
export const BOOK_LABELS={
  cash_receipts:'Поступления',
  recognized_revenue:'Продажи (оказанные услуги и проданные товары)',
  unverified:'Суммы без уточнения'
};
const sum=rows=>rows.reduce((total,row)=>total+row.amount_kopecks,0);
const shift=(date,delta)=>{const day=new Date(date+'T00:00:00Z');day.setUTCDate(day.getUTCDate()+delta);return day.toISOString().slice(0,10)};
export function calculateFinancialSummary(entries,allTimeCounts,end,requestedBasis=null){
  const first=shift(end,-59),currentStart=shift(end,-29),chartStart=shift(end,-6);
  const books={};
  for(const basis of BOOKS){
    const all=entries.filter(x=>(x.financial_basis||'unverified')===basis&&x.sold_on>=first&&x.sold_on<=end);
    const current=all.filter(x=>x.sold_on>=currentStart);
    const previous=all.filter(x=>x.sold_on<currentStart);
    const count=Number(allTimeCounts?.[basis]||0);
    const currentDays=new Set(current.map(x=>x.sold_on)).size;
    const previousDays=new Set(previous.map(x=>x.sold_on)).size;
    const net=sum(current),previousNet=sum(previous);
    const ids=new Set(current.filter(x=>x.status==='sale').map(x=>x.sold_on+'\u0000'+x.source_id)).size;
    const comparable=currentDays>=25&&previousDays>=25&&previousNet>0;
    const totals=new Map();
    for(const row of current)totals.set(row.item,(totals.get(row.item)||0)+row.amount_kopecks);
    books[basis]={
      basis,label:BOOK_LABELS[basis],available:count>0,stored_rows:count,
      amount30_kopecks:net,previous30_kopecks:previousNet,
      yesterday_kopecks:sum(current.filter(x=>x.sold_on===end)),
      receipt_count:ids,average_receipt_kopecks:ids>0?Math.round(net/ids):null,
      change_percent:comparable?Math.round((net-previousNet)/previousNet*1000)/10:null,
      coverage:{current_days:currentDays,previous_days:previousDays,comparable},
      chart7:Array.from({length:7},(_,i)=>{
        const date=shift(chartStart,i);
        return {date,amount_kopecks:sum(current.filter(x=>x.sold_on===date))};
      }),
      top3:[...totals].sort((a,b)=>b[1]-a[1]).slice(0,3)
        .map(([item,amount_kopecks])=>({item,amount_kopecks}))
    };
  }
  const preferred=BOOKS.includes(requestedBasis)&&books[requestedBasis].available
    ?requestedBasis:null;
  // Prefer verified cash when available. Never combine cash and earned sales.
  const primary_basis=preferred ||
    (books.cash_receipts.available?'cash_receipts':
      books.recognized_revenue.available?'recognized_revenue':'unverified');
  const p=books[primary_basis];
  return {
    primary_basis,financial_books:books,
    period:{from:currentStart,to:end},as_of:end,
    revenue30_kopecks:p.amount30_kopecks,
    previous30_kopecks:p.previous30_kopecks,
    yesterday_kopecks:p.yesterday_kopecks,
    receipt_count:p.receipt_count,
    average_receipt_kopecks:p.average_receipt_kopecks,
    change_percent:p.change_percent,coverage:p.coverage,
    chart7:p.chart7,top3:p.top3
  };
}
