// Deterministic, anonymized aggregates for AI interpretation.
// No raw receipt IDs, customers, line-level transactions or filenames leave the server.
const DAY = 86400000;
const shift = (day, offset) => new Date(Date.parse(day + 'T00:00:00Z') + offset * DAY).toISOString().slice(0, 10);
const fmtMoney = (kopecks) => Math.round(kopecks / 100).toLocaleString('ru-RU') + ' ₽';
const fmtPct = (n) => (n > 0 ? '+' : '') + n.toFixed(1).replace('.', ',') + '%';
const receiptKey = (row) => row.sold_on + '\u0000' + row.source_id;
const countReceipts = (rows) => new Set(rows.filter(x => x.status === 'sale').map(receiptKey)).size;
const sum = (rows) => rows.reduce((total, x) => total + x.amount_kopecks, 0);
const itemLabel = (raw) => {
  const name = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 80 || /[\n\r@]|(?:\+7|8)[\d() -]{10,}|\b\d{6,}\b/i.test(name)) return null;
  return name;
};
const pct = (current, previous) => previous > 0 ? fmtPct((current - previous) / previous * 100) : null;

export function buildInsightFacts(report, operations) {
  const facts = {};
  const end = report.as_of;
  const curStart = report.period.from;
  const prevStart = shift(curStart, -30);
  const current = operations.filter(x => x.sold_on >= curStart && x.sold_on <= end);
  const previous = operations.filter(x => x.sold_on >= prevStart && x.sold_on < curStart);
  const covered = rows => new Set(rows.map(x => x.sold_on)).size;
  const comparable = covered(current) >= 25 && covered(previous) >= 25;
  const currentSales = current.filter(x => x.status === 'sale');
  const previousSales = previous.filter(x => x.status === 'sale');

  // Six rolling 30-day windows capture a full ~180-day history without
  // pretending partial calendar months are comparable.
  for (let i = 0; i < 6; i++) {
    const from = shift(end, -(i * 30 + 29));
    const to = shift(end, -(i * 30));
    const rows = operations.filter(x => x.sold_on >= from && x.sold_on <= to);
    const days = covered(rows);
    if (days < 20) continue;
    const receipts = countReceipts(rows);
    const total = sum(rows);
    facts['window_' + (i + 1)] = 'Период ' + from + ' — ' + to +
      ': сумма ' + fmtMoney(total) + ', чеков ' + receipts +
      ', средний чек ' + (receipts ? fmtMoney(total * 1 / receipts) : 'не рассчитан') +
      ', дни с операциями ' + days + ' из 30.';
  }
  if (comparable) {
    const curCount = countReceipts(currentSales), prevCount = countReceipts(previousSales);
    if (prevCount > 0) {
      facts.receipts_driver = 'За последние 30 дней число чеков ' + curCount +
        ' против ' + prevCount + ' ранее (' + pct(curCount, prevCount) + ').';
      const curAvg = curCount ? sum(current) / curCount : 0;
      const prevAvg = sum(previous) / prevCount;
      if (prevAvg > 0 && curAvg > 0) {
        facts.average_driver = 'Средний чек ' + fmtMoney(curAvg) +
          ' против ' + fmtMoney(prevAvg) + ' за прошлые 30 дней (' + pct(curAvg, prevAvg) + ').';
      }
    }
  }
  // Aggregated product/service labels are useful for concrete recommendations.
  // Do not transmit any row-level records or untrusted PII-like labels.
  const amountByItem = rows => {
    const by = new Map();
    for (const row of rows) {
      const name = itemLabel(row.item);
      if (!name) continue;
      by.set(name, (by.get(name) || 0) + row.amount_kopecks);
    }
    return by;
  };
  const curItems = amountByItem(current);
  const prevItems = amountByItem(previous);
  const sorted = [...curItems].filter(([,value])=>value>0).sort((a,b)=>b[1]-a[1]);
  for (let i = 0; i < Math.min(5, sorted.length); i++) {
    const [name, value] = sorted[i], old = prevItems.get(name) || 0;
    const comparison = comparable && old > 0
      ? ' против ' + fmtMoney(old) + ' ранее (' + pct(value, old) + ')'
      : '; сравнение по позиции недоступно';
    facts['product_top_' + (i+1)] = 'Позиция «' + name + '»: ' +
      fmtMoney(value) + ' за 30 дней' + comparison + '.';
  }
  if (comparable) {
    const changed = [...new Set([...curItems.keys(), ...prevItems.keys()])]
      .map(name => ({name, before:prevItems.get(name)||0, after:curItems.get(name)||0}))
      .filter(x=>x.before>=1000000 && x.after>=0)
      .sort((a,b) => (a.after-a.before)-(b.after-b.before));
    for (let i=0; i<Math.min(3, changed.length); i++) {
      const x=changed[i];
      if (x.after >= x.before) break;
      facts['product_decline_' + (i+1)] = 'Снижение позиции «' + x.name + '»: ' +
        fmtMoney(x.after) + ' вместо ' + fmtMoney(x.before) +
        ' за предыдущие 30 дней (' + pct(x.after,x.before) + ').';
    }
  }
  const weekdayNames=['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
  const weekdayStats = Array.from({length:7},()=>({amount:0,days:new Set()}));
  for (const row of current) {
    const dow=new Date(row.sold_on+'T00:00:00Z').getUTCDay();
    weekdayStats[dow].amount+=row.amount_kopecks;
    weekdayStats[dow].days.add(row.sold_on);
  }
  const weekdays=weekdayStats.map((x,i)=>({name:weekdayNames[i],avg:x.days.size?x.amount/x.days.size:0,n:x.days.size}))
    .filter(x=>x.n>=3).sort((a,b)=>b.avg-a.avg);
  if(weekdays.length>=5){
    facts.weekday_peak='По последним 30 дням самые сильные дни по средней сумме за день: '+
      weekdays.slice(0,2).map(x=>x.name+' '+fmtMoney(x.avg)).join(', ')+'.';
    facts.weekday_weak='Самые слабые дни по средней сумме за день: '+
      weekdays.slice(-2).reverse().map(x=>x.name+' '+fmtMoney(x.avg)).join(', ')+'.';
  }
  facts.analysis_limits = 'В данных есть даты, номера чеков, позиции и суммы. '+
    'Отдельных подтверждённых данных о рекламных расходах, клиентских причинах, марже, прибыли, каналах продаж и времени заказов нет. '+
    'Не делайте выводов о причинах без проверки.';
  return facts;
}
