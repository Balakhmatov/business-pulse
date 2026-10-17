# Бизнес Пульс — API, этап 1

Отдельный Node.js API, работающий на **127.0.0.1:3117**, SQLite в `/var/lib/business-pulse/pulse.db`.
Требует Node.js 22+ с флагом `--experimental-sqlite`.
Сервис проверяет **подписанные Telegram Mini App initData**, не доверяет клиентскому user ID.
Единственный разрешённый владелец данных — тот, чей Telegram initData прошёл проверку.
Нет паролей и отдельных npm-зависимостей.

## Endpoints

- `GET /api/health` — открытая проверка процесса и базы.
- `GET /api/me` — создаёт профиль и одну личную компанию после проверки Telegram-подписи.
- `GET /api/report` — показатели за последние 30 полных дней и предыдущие 30, график 7 дней, топ-3, уникальные чеки.
- `POST /api/import` — атомарно **заменяет** операции личной компании после проверки входного JSON. До интеграции UI — **только синтетические тестовые данные**.

Для `/api/me`, `/api/report`, `/api/import` нужен HTTP-заголовок `X-Telegram-Init-Data` со строкой `Telegram.WebApp.initData`. Сервер проверяет HMAC Telegram и срок подписи (максимум 24 часа). Не отправляйте BotFather-токен клиенту!

Формат загрузки (суммы целыми копейками):

```json
{"source":"synthetic-demo.csv","rows":[{"date":"2026-10-16","id":"order-1","item":"Тестовая услуга","amount_kopecks":350000,"status":"sale"}]}
```

Дата, суммы, статусы и дубль каждой строки проверяются сервером. Максимум 10000 операций и 6 MiB JSON за запрос. Значение `receipt_count` считает уникальные ID оплаченных чеков, возвраты хранятся отдельно отрицательными суммами. При отсутствии прошлого периода `change_percent` равен `null`.

**Не загружайте сюда реальные личные, медицинские или конфиденциальные данные.** До коммерческого пилота нужны аудит безопасности, политика хранения/удаления, юридическая проверка и административный доступ.

## Deployment

1. `cd /opt/business-pulse && git pull origin main`
2. `install -m 644 /opt/business-pulse/deploy/business-pulse-api.service /etc/systemd/system/business-pulse-api.service`
3. `systemctl daemon-reload && systemctl enable --now business-pulse-api`
4. `curl -sS http://127.0.0.1:3117/api/health`
5. Отдельно сконфигурировать Nginx `location /api/` для `https://pulse.cityai.site` → `http://127.0.0.1:3117`. Не перенастраивать конфигурацию CityAI.

Существующий Telegram-бот продолжает работать в отдельном systemd-сервисе. Пока данные из Mini App в базу автоматически не попадают: это следующий этап. Никакой действующий код CityAI не затрагивается.
