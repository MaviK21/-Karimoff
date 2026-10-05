#!/usr/bin/env bash
# ============================================================
# Karimoff — deployment script для Ubuntu 24.04 VPS
#
# Использование (на сервере, из клона репозитория /opt/karimoff):
#   sudo bash deploy/deploy.sh provision [DOMAIN]   # первичная настройка сервера
#   sudo bash deploy/deploy.sh tls                  # выпуск Let's Encrypt (после DNS)
#   sudo bash deploy/deploy.sh deploy               # обновление приложения из git
#   sudo bash deploy/deploy.sh backup               # разовый backup БД
#   sudo bash deploy/deploy.sh status               # статус сервиса и таймера
#   sudo bash deploy/deploy.sh healthcheck          # проверка живости
#   sudo bash deploy/deploy.sh rollback [commit]    # откат к предыдущему коммиту
#
# Домен по умолчанию: karimoff.pro (переопределение: аргумент или env DOMAIN).
#
# Скрипт НИКОГДА не трогает: .env, karimoff.db*, backups/, uploads/.
# Скрипт НЕ изменяет SSH-настройки (root SSH / пароли) — SSH-hardening
# выполняется вручную отдельным этапом, см. deploy/README.md, шаг 7.
# ============================================================
set -euo pipefail

DOMAIN="${2:-${DOMAIN:-karimoff.pro}}"
CERT_EMAIL="karimoff.by@gmail.com"   # контакт Let's Encrypt (email, не домен)
APP_DIR="/opt/karimoff"
APP_USER="karimoff"
SERVICE="karimoff"
NODE_MAJOR="22"
REPO_URL="https://github.com/MaviK21/-Karimoff.git"

log()  { echo -e "\033[1;34m[deploy]\033[0m $*"; }
err()  { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; }
ok()   { echo -e "\033[1;32m[OK]\033[0m $*"; }

require_root() {
  if [[ ${EUID} -ne 0 ]]; then err "запускайте через sudo"; exit 1; fi
}

# PORT берётся из .env приложения (по умолчанию 3000)
app_port() {
  local p=""
  if [[ -f "${APP_DIR}/.env" ]]; then
    p="$(grep -oP '^PORT=\K\d+' "${APP_DIR}/.env" 2>/dev/null || true)"
  fi
  echo "${p:-3000}"
}

healthcheck() {
  local port
  port="$(app_port)"
  local tries=30
  for i in $(seq 1 "${tries}"); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${port}/"; then
      ok "healthcheck пройден (попытка ${i}, порт ${port})"
      return 0
    fi
    sleep 2
  done
  err "healthcheck не пройден за $((tries * 2)) с. Логи: journalctl -u ${SERVICE} -n 50"
  return 1
}

cmd_provision() {
  require_root

  . /etc/os-release
  if [[ "${VERSION_ID}" != "24.04" ]]; then
    err "скрипт рассчитан на Ubuntu 24.04, найдено: ${VERSION_ID} (можно продолжить вручную)"; exit 1
  fi

  log "1/11 apt: базовые пакеты"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl git nginx certbot \
    build-essential python3 ca-certificates sqlite3 ufw rsync

  log "2/11 Node.js ${NODE_MAJOR}.x (NodeSource)"
  if ! command -v node >/dev/null || ! node --version | grep -q "v${NODE_MAJOR}\."; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y -qq nodejs
  fi
  ok "node $(node --version)"

  log "3/11 пользователь ${APP_USER}"
  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
  fi

  log "4/11 каталог приложения ${APP_DIR}"
  if [[ ! -d "${APP_DIR}/.git" ]]; then
    if [[ -d "${APP_DIR}" ]] && [[ -f "${APP_DIR}/server.js" ]]; then
      log "  ${APP_DIR} уже содержит приложение (без .git) — оставляю как есть"
    else
      git clone "${REPO_URL}" "${APP_DIR}"
    fi
  fi
  # каталоги данных (переживают обновления; существующие не перезаписываются)
  install -d -o "${APP_USER}" -g "${APP_USER}" -m 750 "${APP_DIR}/uploads" "${APP_DIR}/backups" "/var/backups/karimoff"
  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

  log "5/11 .env"
  if [[ ! -f "${APP_DIR}/.env" ]]; then
    cp "${APP_DIR}/deploy/.env.production.example" "${APP_DIR}/.env"
    chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
    chmod 600 "${APP_DIR}/.env"
    err "ЗАПОЛНИТЕ ${APP_DIR}/.env (ADMIN_PASSWORD, SMTP_PASS, TRUST_PROXY=1) и запустите provision повторно"
    exit 1
  fi
  if grep -q "CHANGE_ME" "${APP_DIR}/.env"; then
    err "в .env остались CHANGE_ME значения"; exit 1
  fi

  log "6/11 зависимости (npm ci --omit=dev)"
  cd "${APP_DIR}"
  sudo -u "${APP_USER}" env npm ci --omit=dev --no-audit --no-fund

  log "7/11 swap 2G (идемпотентно: только если swap отсутствует полностью)"
  if ! swapon --show --noheadings | grep -q . && [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "swap 2G создан"
  else
    ok "swap уже настроен — пропускаю"
  fi

  log "8/11 systemd: ${SERVICE} + ежедневный backup (03:30, хранить 14 копий)"
  install -m 644 "${APP_DIR}/deploy/systemd/karimoff.service"        "/etc/systemd/system/${SERVICE}.service"
  install -m 644 "${APP_DIR}/deploy/systemd/karimoff-backup.service" /etc/systemd/system/karimoff-backup.service
  install -m 644 "${APP_DIR}/deploy/systemd/karimoff-backup.timer"   /etc/systemd/system/karimoff-backup.timer
  systemctl daemon-reload
  systemctl enable --now "${SERVICE}.service" karimoff-backup.timer

  log "9/11 firewall (ufw): правила идемпотентны, 3000 снаружи закрыт"
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable

  log "10/11 nginx: начальный HTTP-конфиг (если TLS уже выпущен — сразу финальный)"
  if [[ -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
    install -m 644 "${APP_DIR}/deploy/nginx/karimoff.conf" /etc/nginx/sites-available/karimoff
    ok "сертификаты найдены — установлен TLS-конфиг"
  else
    install -m 644 "${APP_DIR}/deploy/nginx/karimoff-http.conf" /etc/nginx/sites-available/karimoff
    ok "установлен HTTP-конфиг (TLS — команда tls после настройки DNS)"
  fi
  ln -sf /etc/nginx/sites-available/karimoff /etc/nginx/sites-enabled/karimoff
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx

  log "11/11 healthcheck приложения"
  healthcheck

  cat <<EOF

============================================================
provision завершён. Дальше:
  1) DNS: A-запись ${DOMAIN} -> IP этого VPS
  2) sudo bash deploy/deploy.sh tls     # выпуск Let's Encrypt
  3) SSH-hardening — ВРУЧНУЮ, после проверки входа (deploy/README.md, шаг 7)
Проверка: http://${DOMAIN}/  и  http://${DOMAIN}/admin
============================================================
EOF
}

cmd_tls() {
  require_root
  log "Let's Encrypt для ${DOMAIN} (certonly --webroot)"
  certbot certonly --webroot -w /var/www/html \
    -d "${DOMAIN}" \
    --non-interactive --agree-tos --email "${CERT_EMAIL}" --keep-until-expiring

  log "установка финального TLS-конфига nginx (80 -> 443, HSTS)"
  install -m 644 "${APP_DIR}/deploy/nginx/karimoff.conf" /etc/nginx/sites-available/karimoff
  nginx -t && systemctl reload nginx

  certbot renew --dry-run >/dev/null && ok "автопродление сертификата настроено"
  healthcheck
  ok "TLS готов: https://${DOMAIN}"
}

cmd_deploy() {
  require_root
  cd "${APP_DIR}"
  log "обновление из git (untracked-данные: .env, karimoff.db*, uploads/, backups/ — не затрагиваются)"
  sudo -u "${APP_USER}" git fetch origin
  local prev
  prev=$(git rev-parse HEAD)
  sudo -u "${APP_USER}" git reset --hard origin/main
  if [[ "$(git rev-parse HEAD)" == "${prev}" ]]; then
    ok "изменений нет"; return 0
  fi
  if git diff --name-only "${prev}" HEAD | grep -q "package-lock.json"; then
    log "package-lock.json изменился -> npm ci"
    sudo -u "${APP_USER}" env npm ci --omit=dev --no-audit --no-fund
  fi
  systemctl restart "${SERVICE}"
  healthcheck
  ok "задеплоено: $(git log -1 --oneline). Откат: sudo bash deploy/deploy.sh rollback ${prev}"
}

cmd_rollback() {
  require_root
  local commit="${2:-HEAD~1}"
  cd "${APP_DIR}"
  git reset --hard "${commit}"
  sudo -u "${APP_USER}" env npm ci --omit=dev --no-audit --no-fund
  systemctl restart "${SERVICE}"
  healthcheck
  ok "откат на $(git log -1 --oneline)"
}

cmd_backup() {
  systemctl start karimoff-backup.service
  ls -1t /var/backups/karimoff/ | head -3
  ok "backup готов (/var/backups/karimoff)"
}

cmd_status() {
  systemctl status "${SERVICE}" --no-pager -l || true
  systemctl list-timers karimoff-backup.timer --no-pager || true
}

cmd_healthcheck() { healthcheck; }

case "${1:-}" in
  provision)   shift; cmd_provision "$@" ;;
  tls)         cmd_tls ;;
  deploy)      cmd_deploy ;;
  rollback)    cmd_rollback "$@" ;;
  backup)      cmd_backup ;;
  status)      cmd_status ;;
  healthcheck) cmd_healthcheck ;;
  *) err "использование: deploy.sh {provision [DOMAIN] | tls | deploy | rollback [commit] | backup | status | healthcheck}"; exit 1 ;;
esac
