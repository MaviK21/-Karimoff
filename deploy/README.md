# Karimoff — Production Deployment (Ubuntu 24.04 VPS)

Пошаговая инструкция деплоя текущего приложения (Node.js монолит + SQLite) на VPS.

## Сервер

- Ubuntu 24.04, 2 CPU, 4 GB RAM, 60 GB NVMe, 1 IPv4
- Домен: **karimoff.pro** (REG.RU — регистратор, A-запись настраивается в его панели)
- Приложение: Node.js ES-module монолит (`server.js`), порт 3000, SQLite (better-sqlite3)
- Данные: `uploads/` и `backups/` внутри каталога приложения

## Архитектура после деплоя

```
Интернет ──> nginx :80/:443 (TLS, gzip, client_max_body_size 320m)
                └── proxy ──> 127.0.0.1:3000  Node.js (systemd: karimoff)
                                  ├── server.js (монолит; security headers, CSRF, rate limits)
                                  ├── karimoff.db + karimoff.db-wal/-shm (SQLite)
                                  ├── backups/  (авто-backup при старте + раз в 24 ч)
                                  └── uploads/  (фото товаров, документы)
Отдельно в 03:30: karimoff-backup.timer -> /var/backups/karimoff (WAL-снимки, 14 копий)
```

Приложение слушает `:3000` на всех интерфейсах — **снаружи порт закрыт ufw**
(default deny incoming; открыты только SSH/80/443), доступен только nginx.

## Что лежит в deploy/

| Файл | Назначение |
|---|---|
| `deploy.sh` | provision / tls / deploy / rollback / backup / status / healthcheck |
| `nginx/karimoff-http.conf` | начальный nginx (HTTP) — ставится provision'ом |
| `nginx/karimoff.conf` | финальный nginx (80→443, TLS 1.2/1.3, HSTS) — ставится командой `tls` |
| `systemd/karimoff.service` | unit приложения (автоперезапуск, hardening, ReadWritePaths) |
| `systemd/karimoff-backup.{service,timer}` | ежедневный WAL-safe backup БД в /var/backups/karimoff |
| `.env.production.example` | шаблон секретов (ровно те переменные, что читает server.js) |

## Шаг 0. Требования

- SSH-доступ к VPS по ключу (как root на момент provision).
- Домен **karimoff.pro** куплен (REG.RU). A-запись `@` → IP сервера настраивается
  в панели REG.RU — можно ПОСЛЕ provision, но ДО шага `tls`.
- www-домен не используется архитектурой и не настраивается.

## Шаг 1. Клонирование на сервер

```bash
ssh root@YOUR_VPS_IP
apt update && apt install -y git
git clone https://github.com/MaviK21/-Karimoff.git /opt/karimoff
cd /opt/karimoff
```

## Шаг 2. Provision (однократно, идемпотентно)

```bash
sudo bash deploy/deploy.sh provision karimoff.pro
```

Скрипт: установит nginx/certbot/Node 22/ufw/sqlite3, создаст системного
пользователя `karimoff`, поставит systemd-сервис (автоперезапуск + hardening)
и daily-backup таймер, настроит ufw (SSH/80/443 открыты, 3000 снаружи закрыт),
создаст swap 2G если swap отсутствует, сделает healthcheck.

При первом запуске он **остановится и попросит заполнить `.env`**:

```bash
nano /opt/karimoff/.env      # ADMIN_PASSWORD, SMTP_PASS, TRUST_PROXY=1
sudo bash deploy/deploy.sh provision karimoff.pro   # повторный запуск — дочистит
```

Повторный запуск provision безопасен: существующие `.env`, БД, `uploads/`,
`backups/` и правила ufw не дублируются и не перезаписываются.

## Шаг 3. DNS + TLS

```bash
# когда A-запись karimoff.pro указывает на VPS (проверка: dig +short karimoff.pro):
sudo bash deploy/deploy.sh tls
```

Выпустится Let's Encrypt (webroot, автопродление), nginx переключится на
HTTP→HTTPS редирект + TLS 1.2/1.3 + HSTS.

## Шаг 4. Проверка

```bash
sudo bash deploy/deploy.sh healthcheck
curl -I https://karimoff.pro/                 # 200 + security headers
curl -I https://karimoff.pro/admin            # 200 + Cache-Control: no-store
```

Публичные страницы: `/`, `/catalog`, `/product/:id`, `/services`, `/news`,
`/projects`, `/contacts`, `/cart`, `/favorites`, `/admin` — должны отвечать 200.

## Шаг 5. Обновления приложения

```bash
cd /opt/karimoff && sudo bash deploy/deploy.sh deploy
```

`git fetch` + `reset --hard origin/main`, `npm ci` при изменении lockfile,
restart + healthcheck. Откат: `sudo bash deploy/deploy.sh rollback <commit>`.

**Никогда не удаляются и не перезаписываются:** `.env`, `karimoff.db`,
`karimoff.db-wal`, `karimoff.db-shm`, `backups/`, `uploads/`
(untracked-файлы `git reset --hard` не трогает; `git clean` скрипт не выполняет).

## Шаг 6. Резервные копии

- Приложение само делает backup в `backups/` при старте и раз в 24 ч.
- systemd-таймер `karimoff-backup.timer` в 03:30 делает WAL-safe снимок
  (`better-sqlite3 .backup`, без остановки сервиса) в `/var/backups/karimoff/`,
  хранит 14 последних копий.
- Разово: `sudo bash deploy/deploy.sh backup`.
- Восстановление: остановить сервис → скопировать снимок в
  `/opt/karimoff/karimoff.db` → запустить сервис.
- Две локации (`backups/` и `/var/backups/karimoff/`) не конфликтуют:
  разные каталоги, разные механизмы ротации.

## Шаг 7. SSH-hardening — ВРУЧНУЮ, отдельным этапом

`provision` **намеренно не трогает** SSH-конфигурацию. Выполняйте только после
того, как создание пользователя подтверждено и вход проверен во втором сеансе:

```bash
# 1) На сервере: создайте deploy-пользователя и ключ
sudo adduser deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudo -u deploy bash -c 'echo "ssh-ed25519 AAAA...ВАШ_КЛЮЧ" > /home/deploy/.ssh/authorized_keys'
sudo chmod 600 /home/deploy/.ssh/authorized_keys

# 2) ВТОРОЙ SSH-сеанс: убедитесь, что вход deploy@ работает
#    (не закрывайте root-сеанс, пока вход не подтверждён!)

# 3) Только после подтверждения — ужесточение /etc/ssh/sshd_config:
#    PasswordAuthentication no
#    PermitRootLogin prohibit-password   # или no
#    systemctl restart ssh
```

## Безопасность (что уже настроено на уровне приложения — не дублировать на nginx)

- Security headers (CSP, nosniff, X-Frame, Referrer-Policy, Permissions-Policy) ставит Node.
- CSRF на всех мутациях (включая admin create/update); rate limits; honeypot;
  admin lockout (5/15 мин, timing-safe).
- `TRUST_PROXY=1` в `.env` — обязательно за nginx (иначе rate limits считают IP прокси).
- `client_max_body_size 320m` в nginx соответствует лимитам multipart в приложении (max 300 МБ).
- HSTS добавляет только nginx.
- Порт 3000 не открывается наружу.

## Переменные окружения (ровно те, что читает server.js)

| Переменная | Назначение |
|---|---|
| `PORT` | внутренний порт (3000) |
| `TRUST_PROXY` | `1` за nginx — обязательно |
| `ADMIN_PASSWORD` | пароль /admin |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | отправка заявок |
| `ORDERS_EMAIL` | информационная; фактический адрес заявок берётся из БД (Настройки заявок) |

## Мониторинг / эксплуатация

```bash
sudo bash deploy/deploy.sh status          # systemd status + таймер
journalctl -u karimoff -n 100 --no-pager   # логи приложения
journalctl -u karimoff -f                  # в реальном времени
df -h /opt/karimoff                        # диск: следить за uploads/ и backups/
```

- Логи приложения уходят в journald (ротация автоматическая).
- `backups/` в каталоге приложения копится без ротации — раз в месяц проверять диск.
- Рекомендуется внешний uptime-мониторинг на `https://karimoff.pro/`.
