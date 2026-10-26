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
  if(!ids.size)return {...base,caption:'За последние 30 дней нет записей для подсчёта.'};
  return {...base,value:ids.size,coverage:'complete',
    caption:industry==='auto'?'По уникальным номерам выполненных заказов.':
      industry==='cafe'?'По уникальным номерам оплаченных чеков.':
        'По уникальным номерам операций.'};
}
export function calculateFinancialSummary(entries,allTimeCounts,end,requestedBasis=null,industry='other'){
  const first=shift(end,-59),currentStart=shift(end,-29),chartStart=shift(end,-6);
  const books={};
  for(const basis of BOOKS){
    // One verified, simultaneously paid-and-fulfilled operation belongs to
    // both independent views, without inserting duplicate operations.
    const all=entries.filter(x=>((x.financial_basis||'unverified')===basis||
      (basis!=='unverified'&&x.financial_basis==='paid_fulfilled'))&&
      x.sold_on>=first&&x.sold_on<=end);
    const current=all.filter(x=>x.sold_on>=currentStart);
    const previous=all.filter(x=>x.sold_on<currentStart);
    const count=Number(allTimeCounts?.[basis]||0)+(basis==='unverified'?0:Number(allTimeCounts?.paid_fulfilled||0));
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
  const countRows=entries.filter(x=>x.sold_on>=currentStart&&x.sold_on<=end);
  const volume=volumeForIndustry(countRows,industry,books);
  return {
    primary_basis,financial_books:books,industry:normalizeIndustry(industry),volume,
    // Not calculable from independent cash/revenue aggregates or unlinked IDs.
    unpaid_customer_debt_kopecks:null,unpaid_customer_debt_available:false,
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
