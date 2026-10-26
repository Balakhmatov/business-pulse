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
export const INDUSTRIES={
  clinic:{name:'Клиника',volume_label:'Оказано услуг',volume_unit:'шт.',volume_basis:'recognized_revenue',volume_method:'quantity'},
  store:{name:'Магазин',volume_label:'Продано товаров',volume_unit:'шт.',volume_basis:'recognized_revenue',volume_method:'quantity'},
  auto:{name:'Автосервис',volume_label:'Выполнено заказов',volume_unit:'',volume_basis:'recognized_revenue',volume_method:'unique_id'},
  cafe:{name:'Кафе',volume_label:'Количество чеков',volume_unit:'',volume_basis:'cash_receipts',volume_method:'unique_id'},
  other:{name:'Универсальный',volume_label:'Количество операций',volume_unit:'',volume_basis:null,volume_method:'unique_id'}
};
export const normalizeIndustry=value=>Object.hasOwn(INDUSTRIES,value)?value:'other';
function volumeForIndustry(rows,industry,books){
  const config=INDUSTRIES[normalizeIndustry(industry)];
  const basis=config.volume_basis||(books.cash_receipts.available?'cash_receipts':'recognized_revenue');
  const book=books[basis],periodRows=rows.filter(x=>
    (x.financial_basis===basis||x.financial_basis==='paid_fulfilled')&&x.status==='sale');
  const refunded=rows.filter(x=>
    (x.financial_basis===basis||x.financial_basis==='paid_fulfilled')&&x.status==='refund');
  const base={label:config.volume_label,unit:config.volume_unit,basis,
    method:config.volume_method,value:null,coverage:'missing',
    caption:'Для подсчёта нужны данные из отчёта.'};
  if(!book?.available)return base;
  if(config.volume_method==='quantity'){
    const all=[...periodRows,...refunded];
    if(!all.length)return {...base,caption:'За выбранный период нет строк с количеством.'};
    if(all.some(x=>!Number.isSafeInteger(x.quantity_milli)||x.quantity_milli<=0))
      return {...base,coverage:'incomplete',
        caption:'В отчёте не у всех строк есть количество. Выберите столбец «Количество» при загрузке.'};
    const count=periodRows.reduce((n,x)=>n+x.quantity_milli,0)-
      refunded.reduce((n,x)=>n+x.quantity_milli,0);
    return {...base,value:count/1000,coverage:'complete',
      caption:config.volume_unit==='шт.'?'По столбцу «Количество», с учётом возвратов.':'По данным о количестве.'};
  }
  // "auto" recognizes one completed job ID once in a period, regardless of
  // how many service lines belong to that job. Cafe receipt IDs are normally
  // day-scoped: use day+ID to avoid conflating check numbers on different days.
  const ids=new Set(periodRows.map(x=>industry==='auto'?x.source_id:x.sold_on+'\u0000'+x.source_id));
  if(!ids.size)return {...base,caption:'За выбранный период нет записей для подсчёта.'};
  return {...base,value:ids.size,coverage:'complete',
    caption:industry==='auto'?'По уникальным номерам выполненных заказов.':
      industry==='cafe'?'По уникальным номерам оплаченных чеков.':
        'По уникальным номерам операций.'};
}
export function calculateFinancialSummary(entries,allTimeCounts,end,requestedBasis=null,industry='other',range=null){
  const from=range?.from||shift(end,-29);
  const selectedEnd=range?.to||end;
  const days=Math.round((Date.parse(selectedEnd+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000)+1;
  if(days<1||days>1095)throw Error('Период вне допустимого диапазона.');
  const previousEnd=shift(from,-1),previousStart=shift(from,-days);
  const earliest=previousStart;
  const bucketSize=days<=45?1:days<=120?7:0; // month buckets for longer periods
  const dates=[];
  if(bucketSize){
    for(let d=from;d<=selectedEnd;d=shift(d,bucketSize)){
      dates.push({date:d,from:d,to:shift(d,Math.min(bucketSize-1,Math.round((Date.parse(selectedEnd)-Date.parse(d))/86400000)))});
    }
  }else{
    for(let d=from;d<=selectedEnd;){
      const monthLast=shift(new Date(Date.UTC(+d.slice(0,4),+d.slice(5,7),0)).toISOString().slice(0,10),0);
      const to=monthLast<selectedEnd?monthLast:selectedEnd;
      dates.push({date:d.slice(0,7)+'-01',from:d,to});
      d=shift(to,1);
    }
  }
  const books={};
  for(const basis of BOOKS){
    const all=entries.filter(x=>((x.financial_basis||'unverified')===basis||
      (basis!=='unverified'&&x.financial_basis==='paid_fulfilled'))&&
      x.sold_on>=earliest&&x.sold_on<=selectedEnd);
    const current=all.filter(x=>x.sold_on>=from);
    const previous=all.filter(x=>x.sold_on>=previousStart&&x.sold_on<=previousEnd);
    const count=Number(allTimeCounts?.[basis]||0)+(basis==='unverified'?0:Number(allTimeCounts?.paid_fulfilled||0));
    const currentDays=new Set(current.map(x=>x.sold_on)).size;
    const previousDays=new Set(previous.map(x=>x.sold_on)).size;
    const net=sum(current),previousNet=sum(previous);
    const ids=new Set(current.filter(x=>x.status==='sale').map(x=>x.sold_on+'\u0000'+x.source_id)).size;
    const threshold=Math.max(1,Math.min(25,Math.floor(days*.75)));
    const comparable=currentDays>=threshold&&previousDays>=threshold&&previousNet>0;
    const totals=new Map(),byDay=new Map();
    for(const row of current){
      totals.set(row.item,(totals.get(row.item)||0)+row.amount_kopecks);
      byDay.set(row.sold_on,(byDay.get(row.sold_on)||0)+row.amount_kopecks);
    }
    const chart=dates.map(bucket=>{
      let amount_kopecks=0;
      for(let d=bucket.from;d<=bucket.to;d=shift(d,1))
        amount_kopecks+=byDay.get(d)||0;
      return {date:bucket.date,amount_kopecks};
    });
    books[basis]={
      basis,label:BOOK_LABELS[basis],available:count>0,stored_rows:count,
      amount30_kopecks:net,previous30_kopecks:previousNet,
      yesterday_kopecks:sum(current.filter(x=>x.sold_on===selectedEnd)),
      receipt_count:ids,average_receipt_kopecks:ids>0?Math.round(net/ids):null,
      change_percent:comparable?Math.round((net-previousNet)/previousNet*1000)/10:null,
      coverage:{current_days:currentDays,previous_days:previousDays,comparable},
      chart7:chart,
      top3:[...totals].sort((a,b)=>b[1]-a[1]).slice(0,3)
        .map(([item,amount_kopecks])=>({item,amount_kopecks}))
    };
  }
  const preferred=BOOKS.includes(requestedBasis)&&books[requestedBasis].available
    ?requestedBasis:null;
  const primary_basis=preferred ||
    (books.cash_receipts.available?'cash_receipts':
      books.recognized_revenue.available?'recognized_revenue':'unverified');
  const p=books[primary_basis];
  const countRows=entries.filter(x=>x.sold_on>=from&&x.sold_on<=selectedEnd);
  const volume=volumeForIndustry(countRows,industry,books);
  return {
    primary_basis,financial_books:books,industry:normalizeIndustry(industry),volume,
    unpaid_customer_debt_kopecks:null,unpaid_customer_debt_available:false,
    period:{from,to:selectedEnd,days,previous_from:previousStart,previous_to:previousEnd},
    as_of:selectedEnd,chart_granularity:bucketSize===1?'day':bucketSize===7?'week':'month',
    revenue30_kopecks:p.amount30_kopecks,previous30_kopecks:p.previous30_kopecks,
    yesterday_kopecks:p.yesterday_kopecks,receipt_count:p.receipt_count,
    average_receipt_kopecks:p.average_receipt_kopecks,
    change_percent:p.change_percent,coverage:p.coverage,chart7:p.chart7,top3:p.top3
  };
}
