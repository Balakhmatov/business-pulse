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
  return ['Главный вывод ИИ', title, explanation, evidence, action ? 'Что проверить: ' + action : '']
    .filter(Boolean).join('\n');
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
      'SELECT c.id,c.name,i.source,i.imported_at,i.row_count FROM companies c ' +
      'INNER JOIN users u ON u.telegram_id=c.owner_id ' +
      'LEFT JOIN imports i ON i.company_id=c.id ' +
      'WHERE u.telegram_id=? ORDER BY c.created_at,c.id LIMIT 1'
    ).get(String(telegramId));
    const prelude = 'Бизнес Пульс · утренний обзор\n';
    if (!company || !company.imported_at) {
      return prelude + '\nОтчёт компании пока не загружен.\n' +
        'Откройте «Моя компания» и загрузите CSV — тогда здесь появятся ваши показатели.';
    }
    const ops = database.prepare(
      'SELECT sold_on,source_id,amount_kopecks,status FROM operations ' +
      'WHERE company_id=? AND sold_on>=? AND sold_on<=?'
    ).all(company.id, start, end);
    const latest = database.prepare(
      'SELECT MAX(sold_on) AS last_date FROM operations WHERE company_id=? AND sold_on<=?'
    ).get(company.id, end)?.last_date;
    const current = ops.filter(x => x.sold_on >= cut);
    const previous = ops.filter(x => x.sold_on < cut);
    const sum = rows => rows.reduce((value, row) => value + row.amount_kopecks, 0);
    const days = rows => new Set(rows.map(row => row.sold_on)).size;
    const currentCoverage = days(current), previousCoverage = days(previous);
    const currentRevenue = sum(current), previousRevenue = sum(previous);
    const yesterday = current.filter(row => row.sold_on === end);
    const salesCount = new Set(current.filter(row => row.status === 'sale').map(row => row.source_id)).size;
    const comparable = currentCoverage >= 25 && previousCoverage >= 25 && previousRevenue > 0;
    const source = /синтетич|тестов|demo|sample/i.test(company.source) ? ' (тестовые данные)' : '';
    const lines = [
      prelude,
      safeText(company.name, 100) + source,
      '',
      'Период: ' + displayDate(cut) + ' — ' + displayDate(end),
      'Выручка за 30 дней по загруженным операциям: ' + money(currentRevenue),
      'Чеков / визитов за 30 дней: ' + salesCount
    ];
    if (yesterday.length) {
      lines.push('Выручка за ' + displayDate(end) + ': ' + money(sum(yesterday)));
    } else {
      lines.push('За ' + displayDate(end) + ' операций в выгрузке нет (не считаем это нулевой выручкой).');
    }
    if (comparable) {
      lines.push('Изменение к предыдущим 30 дням: ' + signedPercent((currentRevenue - previousRevenue) / previousRevenue * 100));
    } else {
      lines.push('Сравнение с предыдущим периодом ненадёжно: данных недостаточно.');
    }
    if (currentCoverage < 30 || previousCoverage < 30) {
      lines.push('Покрытие выгрузки: ' + currentCoverage + '/30 дней сейчас, ' +
        previousCoverage + '/30 дней ранее.');
    }
    if (latest && latest < end) {
      lines.push('\nВнимание: последняя дата операции — ' + displayDate(latest) +
        '. Это не отчёт с подтверждёнными данными за вчера.');
    } else if (!latest) {
      lines.push('\nВнимание: в отчёте нет операций до ' + displayDate(end) + '.');
    }
    const importDate = String(company.imported_at).replace(' ', 'T') + 'Z';
    const parsedImport = new Date(importDate);
    const importLabel = Number.isNaN(parsedImport.getTime()) ? safeText(company.imported_at, 20) :
      parsedImport.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
    lines.push('Загружено: ' + importLabel + ' МСК.');
    const analysis = briefAI(database, company.id, company.imported_at);
    if (analysis) lines.push('', analysis);
    else lines.push('', 'ИИ-анализ пока не готов. Показаны расчётные показатели.');
    return lines.join('\n');
  } finally {
    database.close();
  }
}
