import fs from 'node:fs/promises';
import path from 'node:path';

// Independent, dependency-free Telegram bridge for the Business Pulse prototype.
// Requires Node.js 20.6+, a separate BotFather bot and a running server process.
// NEVER put the bot token or subscriber storage into GitHub Pages.
const TOKEN = process.env.BP_BOT_TOKEN;
const EXPECTED_USERNAME = (process.env.BP_BOT_USERNAME || 'business_pulse_app_bot').replace(/^@/, '').toLowerCase();
const APP_URL = process.env.BP_APP_URL || 'https://balakhmatov.github.io/business-pulse/';
const TIMEZONE = process.env.BP_TIMEZONE || 'Europe/Moscow';
const SEND_HOUR = Number(process.env.BP_SEND_HOUR || 9);
const STORAGE_PATH = path.resolve(process.env.BP_SUBSCRIBERS_FILE || './data/subscribers.json');
const API = TOKEN ? 'https://api.telegram.org/bot' + TOKEN : '';
if (!TOKEN) throw new Error('Missing BP_BOT_TOKEN. Configure it in a local .env file.');
if (!/^https:\/\//.test(APP_URL)) throw new Error('BP_APP_URL must be HTTPS.');
if (!Number.isInteger(SEND_HOUR) || SEND_HOUR < 0 || SEND_HOUR > 23) throw new Error('Invalid BP_SEND_HOUR.');
new Intl.DateTimeFormat('en-US', {timeZone: TIMEZONE}); // validate time zone
const subscribers = new Map();
let sending = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(method, payload = {}) {
  const timeout = method === 'getUpdates' ? 40000 : 15000;
  const response = await fetch(API + '/' + method, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error('Telegram ' + method + ': ' + (result.description || response.status));
  }
  return result.result;
}

async function loadSubscribers() {
  try {
    const content = JSON.parse(await fs.readFile(STORAGE_PATH, 'utf8'));
    for (const [id, record] of Object.entries(content)) {
      if (/^\d+$/.test(id) && record && typeof record === 'object') {
        subscribers.set(id, {since: record.since || '', lastSent: record.lastSent || ''});
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function saveSubscribers() {
  await fs.mkdir(path.dirname(STORAGE_PATH), {recursive: true, mode: 0o700});
  const temporary = STORAGE_PATH + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(Object.fromEntries(subscribers), null, 2), {mode: 0o600});
  await fs.rename(temporary, STORAGE_PATH);
}

function launchButton() {
  return {
    inline_keyboard: [
      [{text: 'Открыть Бизнес Пульс', web_app: {url: APP_URL}}],
      [{text: 'Проверить уведомление', callback_data: 'bp:test'}]
    ]
  };
}

async function send(chatId, text) {
  return api('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: launchButton(),
    disable_web_page_preview: true
  });
}

function dailyText() {
  return 'Бизнес Пульс · утренний обзор\n\n' +
    'Демонстрационная панель доступна для просмотра: выручка, динамика и ключевые изменения.\n\n' +
    'Это тестовая рассылка с синтетическими данными. Реальные показатели и автоматическое обновление подключим после настройки источника данных.';
}

async function handle(update) {
  const callback = update.callback_query;
  if (callback) {
    const chat = callback.message?.chat;
    if (chat?.type !== 'private' || String(callback.from?.id) !== String(chat.id)) return;
    if (callback.data === 'bp:test') {
      await api('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Отправляю тестовое уведомление'
      });
      await send(String(chat.id), 'Проверка уведомлений:\n\n' + dailyText());
    } else {
      await api('answerCallbackQuery', {callback_query_id: callback.id});
    }
    return;
  }

  const message = update.message;
  if (!message || message.chat?.type !== 'private' || typeof message.text !== 'string') return;
  const chatId = String(message.chat.id);
  const cmd = message.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();

  switch (cmd) {
    case '/start':
      await send(chatId, 'Добро пожаловать в Бизнес Пульс.\n\n' +
        'Откройте демо на кнопке ниже. Чтобы каждое утро получать тестовое уведомление, отправьте /subscribe.\n\n' +
        'Пока в панели только демонстрационные данные.');
      break;
    case '/report':
      await send(chatId, dailyText());
      break;
    case '/test':
      await send(chatId, 'Проверка уведомлений:\n\n' + dailyText());
      break;
    case '/subscribe':
      if (!subscribers.has(chatId)) {
        subscribers.set(chatId, {since: new Date().toISOString(), lastSent: ''});
        await saveSubscribers();
      }
      await send(chatId, 'Тестовая утренняя рассылка включена: ежедневно в ' +
        String(SEND_HOUR).padStart(2, '0') + ':00 (' + TIMEZONE + ').\n' +
        'Отключение — /unsubscribe. Пока это напоминание открыть демо, а не отчёт по реальным продажам.');
      break;
    case '/unsubscribe':
    case '/stop':
      subscribers.delete(chatId);
      await saveSubscribers();
      await send(chatId, 'Ежедневные уведомления отключены. Возобновить — /subscribe.');
      break;
    case '/status':
      await send(chatId, subscribers.has(chatId) ?
        'Ежедневные тестовые уведомления включены. Отключение — /unsubscribe.' :
        'Ежедневные уведомления выключены. Подключить — /subscribe.');
      break;
    case '/help':
      await send(chatId, 'Команды:\n/start — открыть приложение\n/report — открыть обзор\n' +
        '/subscribe — включить утренние уведомления\n/unsubscribe — отключить\n' +
        '/status — проверить подписку\n/test — тестовое сообщение');
      break;
    default:
      // Do not respond to free-form user messages until conversational features exist.
      break;
  }
}

function localClock() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return {
    date: value.year + '-' + value.month + '-' + value.day,
    hour: Number(value.hour)
  };
}

async function morningTick() {
  if (sending || subscribers.size === 0) return;
  const now = localClock();
  if (now.hour !== SEND_HOUR) return;
  sending = true;
  try {
    for (const [chatId, record] of subscribers) {
      if (record.lastSent === now.date) continue;
      try {
        await send(chatId, dailyText());
        record.lastSent = now.date;
        await saveSubscribers();
      } catch (error) {
        // Telegram rejects messages when the recipient blocked the bot.
        if (/blocked|chat not found|user is deactivated|bot was blocked/i.test(String(error.message))) {
          subscribers.delete(chatId);
          await saveSubscribers();
        } else {
          console.error('Morning delivery failed for chat ' + chatId + ': ' + error.message);
        }
      }
    }
  } finally {
    sending = false;
  }
}

async function run() {
  await loadSubscribers();
  const bot = await api('getMe');
  if (String(bot.username || '').toLowerCase() !== EXPECTED_USERNAME) {
    throw new Error('Bot username mismatch: expected @' + EXPECTED_USERNAME + ', got @' + (bot.username || 'unknown') + '. Refusing to modify another bot.');
  }
  const hook = await api('getWebhookInfo');
  if (hook.url) throw new Error('This bot already uses a webhook. Use a dedicated bot, do not replace its webhook.');
  await api('setMyCommands', {commands: [
    {command: 'start', description: 'Открыть Бизнес Пульс'},
    {command: 'report', description: 'Посмотреть обзор'},
    {command: 'subscribe', description: 'Включить утренние уведомления'},
    {command: 'unsubscribe', description: 'Отключить уведомления'},
    {command: 'status', description: 'Статус уведомлений'},
    {command: 'test', description: 'Проверить сообщение'}
  ]});
  await api('setChatMenuButton', {
    menu_button: {type: 'web_app', text: 'Бизнес Пульс', web_app: {url: APP_URL}}
  });
  console.log('Business Pulse bot connected: @' + bot.username + '; subscriptions: ' + subscribers.size);
  setInterval(() => { morningTick().catch(e => console.error('Daily tick: ' + e.message)); }, 60000);
  morningTick().catch(e => console.error('Initial daily tick: ' + e.message));
  let offset = 0;
  while (true) {
    try {
      const updates = await api('getUpdates', {offset, timeout: 28, allowed_updates: ['message', 'callback_query']});
      for (const update of updates) {
        offset = update.update_id + 1;
        try { await handle(update); }
        catch (error) { console.error('Update ' + update.update_id + ': ' + error.message); }
      }
    } catch (error) {
      console.error('Polling: ' + error.message);
      await sleep(3500);
    }
  }
}

run().catch(error => {
  console.error('Bot startup failed: ' + error.message);
  process.exitCode = 1;
});
