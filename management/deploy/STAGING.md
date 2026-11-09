# Бизнес Пульс: production и stage

Всё находится в репозитории `Balakhmatov/business-pulse`. Старый `main` и сайт `pulse.cityai.site` не меняются.

| Среда | Ветка | Адрес | Обновление |
| --- | --- | --- | --- |
| Текущий управленческий кабинет | `production` | https://cityai.site/businesspulse/ | Только вручную |
| Разработка | `dev` | https://stage.cityai.site/businesspulse/ | Автоматически, примерно каждые 30 секунд |
| Старый Бизнес Пульс | `main` | https://pulse.cityai.site/ | Вне этой настройки |

`production` создана от проверенной версии `443abeb3a5f7ef3e3b1fb42ff2a20e9cf396a584`. Ветка `feature/management-workspace` оставлена на той же версии для совместимости; новые изменения в неё не отправляются. Пока серверная команда не выполнена, прежний таймер ещё может быть включён, но пуши в `dev` он не отслеживает.

## Однократная настройка на VPS

Нужен действующий управленческий кабинет, Node.js по `/usr/local/bin/node-business-pulse` и существующий HTTPS-vhost `stage.cityai.site` в `/etc/nginx/sites-enabled/cityai-staging`. Встреченные ранее конфигурация и адрес используются без изменения корневого сайта CityAI stage.

Выполнить от root:

```bash
curl -fsSL https://raw.githubusercontent.com/Balakhmatov/business-pulse/dev/management/deploy/install-stage.sh -o /tmp/install-business-pulse-stage.sh &&
bash /tmp/install-business-pulse-stage.sh &&
bash /opt/business-pulse-management-stage/management/deploy/create-stage-owner.sh
```

В конце ввести название тестовой компании, имя, email и пароль отдельного владельца stage. Пароль вводится скрыто; production-аккаунты не переносятся. При повторном запуске создание владельца пропускается, если он уже существует.

Что делает настройка:

1. Клонирует `dev` в отдельный каталог и проверяет код тестами под отдельным пользователем stage.
2. Выключает только `business-pulse-management-deploy.timer`, ждёт завершения возможного текущего развёртывания и переключает метаданные текущего checkout на `production` с тем же SHA. Приложение, его настройки и база не заменяются; текущий сервис не перезапускается. При несовпадении проверенной версии настройка останавливается без замены кода.
3. Создаёт отдельные systemd-сервис, базу и окружение stage. Не копирует production-базу, контакты, аккаунты или ключи.
4. Добавляет `/businesspulse/` только в HTTPS-блок `stage.cityai.site`. Конфигурация сохраняется в резервную копию, проверяется и при ошибке восстанавливается.
5. Включает stage-таймер для ветки `dev`.

Stage отмечен полосой **STAGE · Среда разработки · Отдельные данные**, заголовком страницы и `noindex`. Это отдельный hostname: вход и cookie production не переиспользуются, запросы stage к изменяющим API production отвергаются проверкой Origin. Демо доступно без копирования реальных данных.

## Изоляция

| Ресурс | Production | Stage |
| --- | --- | --- |
| Каталог | `/opt/business-pulse-management` | `/opt/business-pulse-management-stage` |
| Пользователь процесса | `business-pulse-management` | `business-pulse-stage` |
| Порт loopback | `3128` | `3129` |
| База | `/var/lib/business-pulse-management/management.db` | `/var/lib/business-pulse-management-stage/management.db` |
| Настройки | `/etc/business-pulse-management/app.env` | `/etc/business-pulse-management-stage/app.env` |
| Сервис | `business-pulse-management.service` | `business-pulse-management-stage.service` |
| Автодеплой | Отключён серверной настройкой | `business-pulse-management-stage-deploy.timer` |

Stage-процесс получает запись только в свой каталог данных. Его окружение не наследует production-ключи ИИ. При необходимости ключи для тестирования добавляются отдельно в stage `app.env`, затем перезапускается только stage-сервис.

Stage-обновление проверяет `dev`, запускает тесты, делает согласованную резервную копию stage-базы, обновляет только stage и проверяет локальный и HTTPS health. При ошибке возвращает stage-код и stage-базу к предыдущей версии. Текущую рабочую версию этот скрипт не выбирает.

## Дальнейшая работа

Все новые изменения отправляются в `dev`. После успешного автодеплоя они видны на stage. Текущий кабинет продолжает работать на `production`.

Для ручного выпуска:

1. Проверить нужную версию на stage.
2. В GitHub создать и вручную слить PR из проверенного `dev` в `production` (либо отдельно подготовить нужные коммиты). Автоматическое слияние не включается.
3. От root на VPS запустить ручной runner:

```bash
bash /opt/business-pulse-management-stage/management/deploy/release-production.sh
```

Runner принимает только checkout на `production`, проверяет опубликованную production-ветку и кандидата, сохраняет **собственную production-базу**, выпускает код и проверяет health. При неудаче возвращает предыдущие код и базу. Stage-база не переносится. Перезапуск production происходит только при таком явном выпуске, не при пуше в `dev`.

Первое переключение ветки без изменения работающего кода выполняется установщиком stage. Не запускайте старый `install-autodeploy.sh` для production: он предназначен для прежней схемы и ветки `feature/management-workspace`.

## Проверка и журналы

```bash
systemctl is-enabled business-pulse-management-deploy.timer
systemctl list-timers business-pulse-management-stage-deploy.timer --no-pager
journalctl -u business-pulse-management-stage-deploy.service -n 50 --no-pager
systemctl status business-pulse-management-stage.service --no-pager
```

Первый таймер должен быть `disabled`. Проверки сайта:

- Production: https://cityai.site/businesspulse/api/health
- Stage: https://stage.cityai.site/businesspulse/api/health

Создание веток в GitHub и публикация файлов сами по себе не выполняют настройку VPS. До успешного выполнения команды выше stage не считается установленным, а старый таймер — выключенным.
