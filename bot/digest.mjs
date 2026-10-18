import { DatabaseSync } from 'node:sqlite';

// Read-only reader for the subscriber's OWN Telegram-linked company.
// The API owns imports and all financial calculations; the bot never writes to SQLite.
const DEFAULT_DB = '/var/lib/business-pulse/pulse.db';
const money = kopecks => Math.round(kopecks / 100).toLocaleString('ru-RU') + ' ₽';
const signedPercent = percent => (percent > 0 ? '+' : '') + percent.toFixed(1).replace('.', ',') + '%';

function mskDay(now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return [v.year, v.month, v.day].join('-');
}
function shift(day, numberOfDays) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + numberOfDays);
  return d.toISOString().slice(0, 10);
}
function displayDate(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  });
}
function safeText(v, max = 360) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}
function escapeHTML(value) {
  // All source/company/model strings must be escaped before Telegram HTML formatting.
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}
function briefAI(database, companyId, importTime) {
  // The table may be absent on an older backend. Never break a financial digest.
  let record;
  try {
    record = database.prepare(
      "SELECT status,payload,updated_ms FROM ai_analyses WHERE company_id=?"
    ).get(companyId);
  } catch (err) {
    if (/no such table/i.test(String(err.message))) return '';
    throw err;
  }
  if (record?.status !== 'ready' || !record.payload) return '';
  // Do not show AI conclusions from a previous import.
  const importedMs = Date.parse(String(importTime).replace(' ', 'T') + 'Z');
  if (Number.isFinite(importedMs) && record.updated_ms < importedMs) return '';
  let parsed;
  try { parsed = JSON.parse(record.payload); } catch { return ''; }
  const finding = parsed?.issues?.[0] || parsed?.positives?.[0];
  if (!finding || typeof finding !== 'object') return '';
  const title = safeText(finding.title, 115);
  const explanation = safeText(finding.explanation, 280);
  const evidence = safeText(finding.evidence?.[0], 250);
  const action = safeText(finding.recommendation, 240);
  if (!title || !explanation) return '';
  return [
    '📌 <b>Ключевой аналитический вывод</b>',
    '<b>1. ' + escapeHTML(title) + '</b>',
    escapeHTML(explanation),
    evidence ? '<i>Основание:</i> ' + escapeHTML(evidence) : '',
    action ? '<b>Рекомендация:</b>\n' + escapeHTML(action) : ''
  ].filter(Boolean).join('\n\n');
}

export function dailyDigestFor(telegramId, {
  now = new Date(), dbPath = process.env.BP_DB_FILE || DEFAULT_DB
} = {}) {
  if (!/^[1-9]\d{0,19}$/.test(String(telegramId))) throw new Error('Invalid private Telegram chat ID');
  const end = shift(mskDay(now), -1);
  const cut = shift(end, -29), start = shift(end, -59);
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const company = database.prepare(
      'SELECT c.id,c.name,i.source,i.imported_at,i.last_change_at,i.row_count FROM companies c ' +
      'INNER JOIN users u ON u.telegram_id=c.owner_id ' +
      'LEFT JOIN imports i ON i.company_id=c.id ' +
      'WHERE u.telegram_id=? ORDER BY c.created_at,c.id LIMIT 1'
    ).get(String(telegramId));
    const prelude = '📊 <b>Бизнес Пульс · утренний обзор</b>';
    if (!company || !company.imported_at) {
      return prelude + '\n\n<b>Нет загруженного отчёта</b>\n\n' +
        'Откройте «Моя компания» и загрузите CSV — тогда здесь появятся ваши показатели.';
    }
    const hasBasis=database.prepare('PRAGMA table_info(operations)').all()
      .some(col=>col.name==='financial_basis');
    const books=['cash_receipts','recognized_revenue','unverified'];
    const basisCounts=hasBasis?database.prepare(
      'SELECT financial_basis,COUNT(*) AS n FROM operations WHERE company_id=? GROUP BY financial_basis'
    ).all(company.id):[{financial_basis:'unverified',n:1}];
    const available=new Set(basisCounts.filter(x=>x.n>0).map(x=>x.financial_basis));
    const basis=available.has('cash_receipts')?'cash_receipts':
      available.has('recognized_revenue')?'recognized_revenue':'unverified';
    const metric=basis==='cash_receipts'?'Денежные поступления':
      basis==='recognized_revenue'?'Выручка по выполненным продажам':
        'Сумма операций (тип не подтверждён)';
    const ops = hasBasis?database.prepare(
      'SELECT sold_on,source_id,amount_kopecks,status FROM operations '+
      'WHERE company_id=? AND financial_basis=? AND sold_on>=? AND sold_on<=?'
    ).all(company.id,basis,start,end):
      database.prepare(
        'SELECT sold_on,source_id,amount_kopecks,status FROM operations '+
        'WHERE company_id=? AND sold_on>=? AND sold_on<=?'
      ).all(company.id,start,end);
    const latest = hasBasis?database.prepare(
      'SELECT MAX(sold_on) AS last_date FROM operations WHERE company_id=? AND financial_basis=? AND sold_on<=?'
    ).get(company.id,basis,end)?.last_date:
      database.prepare(
        'SELECT MAX(sold_on) AS last_date FROM operations WHERE company_id=? AND sold_on<=?'
      ).get(company.id,end)?.last_date;
    const current = ops.filter(x => x.sold_on >= cut);
    const previous = ops.filter(x => x.sold_on < cut);
    const sum = rows => rows.reduce((value, row) => value + row.amount_kopecks, 0);
    const days = rows => new Set(rows.map(row => row.sold_on)).size;
    const currentCoverage = days(current), previousCoverage = days(previous);
    const currentRevenue = sum(current), previousRevenue = sum(previous);
    const yesterday = current.filter(row => row.sold_on === end);
    const salesCount = new Set(current.filter(row => row.status === 'sale').map(row => row.sold_on + '\u0000' + row.source_id)).size;
    const comparable = currentCoverage >= 25 && previousCoverage >= 25 && previousRevenue > 0;
    const source = /синтетич|тестов|demo|sample/i.test(company.source) ? ' (тестовые данные)' : '';
    const lines = [
      prelude,
      '',
      '<b>' + escapeHTML(safeText(company.name, 100)) + '</b>' + source,
      'Период: ' + displayDate(cut) + ' — ' + displayDate(end),
      '',
      '<b>Основные показатели</b>',
      '1. '+metric+' за 30 дней: <b>' + money(currentRevenue) + '</b>',
      '2. Чеков / визитов за 30 дней: <b>' + salesCount + '</b>'
    ];
    if (yesterday.length) {
      lines.push('3. '+metric+' за ' + displayDate(end) + ': <b>' + money(sum(yesterday)) + '</b>');
    } else {
      lines.push('3. За ' + displayDate(end) + ' <b>нет операций в выгрузке</b> (это не подтверждённая нулевая выручка).');
    }
    if (comparable) {
      lines.push('4. Изменение к предыдущим 30 дням: <b>' + signedPercent((currentRevenue - previousRevenue) / previousRevenue * 100) + '</b>');
    } else {
      lines.push('4. <b>Сравнение с предыдущим периодом ограничено:</b> данных недостаточно.');
    }
    if (currentCoverage < 30 || previousCoverage < 30) {
      lines.push('', '<i>Полнота данных:</i> ' + currentCoverage + '/30 дней в текущем периоде, ' +
        previousCoverage + '/30 дней в предыдущем.');
    }
    if (latest && latest < end) {
      lines.push('', '<b>Обратите внимание:</b> последняя дата операции — ' + displayDate(latest) +
        '. Данные за вчера не подтверждены.');
    } else if (!latest) {
      lines.push('', '<b>Обратите внимание:</b> в отчёте нет операций до ' + displayDate(end) + '.');
    }
    if(hasBasis){
      const labels={cash_receipts:'Денежные поступления',recognized_revenue:'Выручка по выполненным продажам',
        unverified:'Операции без подтверждённого типа'};
      for(const other of books){
        if(other===basis||!available.has(other))continue;
        const rows=database.prepare(
          'SELECT COALESCE(SUM(amount_kopecks),0) AS total FROM operations '+
          'WHERE company_id=? AND financial_basis=? AND sold_on>=? AND sold_on<=?'
        ).get(company.id,other,cut,end);
        lines.push(labels[other]+' за 30 дней: <b>'+money(rows.total)+'</b> (отдельный показатель).');
      }
      if(available.has('unverified'))
        lines.push('', '<i>Данные с неподтверждённым финансовым типом не входят в проверенные поступления или выручку.</i>');
    }
    const importDate = String(company.imported_at).replace(' ', 'T') + 'Z';
    const parsedImport = new Date(importDate);
    const importLabel = Number.isNaN(parsedImport.getTime()) ? safeText(company.imported_at, 20) :
      parsedImport.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
    lines.push('', '<i>Отчёт загружен: ' + escapeHTML(importLabel) + ' МСК.</i>');
    const analysis = briefAI(database, company.id, company.last_change_at || company.imported_at);
    if (analysis) lines.push('', analysis);
    else lines.push('', '<b>Аналитическое заключение</b>', '', 'Заключение пока формируется. Выше представлены расчётные показатели.');
    return lines.join('\n');
  } finally {
    database.close();
  }
}
