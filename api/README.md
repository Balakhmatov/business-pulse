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

AI analysis cache (2026-10-26): analyses now live in `ai_analysis_cache`, separately for company, transactionally maintained dataset revision, resolved inclusive dates, financial basis and industry. Refreshing, reopening on another device, switching periods and returning reuse the same completed payload. Imports are not precomputed speculatively: the first dashboard request claims a DB lease and generates from a consistent snapshot. Identical reimports do not advance the revision. Inserts, amount/quantity corrections, deletes and undo advance it atomically. Old single-company cache entries are retained but no longer read; imported operations are not rewritten.

The durable pending lease lasts two minutes (model timeout one minute); errors have a ten-minute retry backoff. Claim tokens fence late completions. An interrupted process may require one replacement call after the lease expires; exactly-once upstream billing across a crash cannot be guaranteed. No completed result is regenerated for an unchanged key. Company-data clearing also removes the new cache.

Clinic imports: the combination of `дата оказания`, `наименование услуги` and a generic `стоимость`/`сумма` identifies completed services, without equating them to payments. The quantity column maps explicitly; service volume uses quantities with refunds, never visit count or payment rows. Ambiguous billing/debt/unit-price columns remain unverified. Import the “Оказанные услуги” and “Оплаты” sheets separately with their respective amount columns and stable IDs.

Existing uploads are not reclassified or backfilled automatically. If a service sheet was previously imported as unverified or without quantity, the owner may reimport the original sheet with the corrected mapping. Confirm the preview and financial basis first: a corrected basis has its own ledger identity, so historic unverified rows remain visible separately. The original customer workbook was unavailable in the referenced chat; regressions reproduce its stated columns using synthetic rows, including backend import, quantity persistence and repeated upload.
