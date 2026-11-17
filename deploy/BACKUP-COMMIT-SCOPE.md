# Состав будущего backup-коммита

Ничего не staged/committed. Не использовать git add .; unrelated изменения сохранены.

Полные файлы после финального review:

```text
.gitignore
.gitattributes
deploy/uploads-backup.sh
deploy/systemd/karimoff-backup.service
deploy/systemd/karimoff-backup.service.d/90-uploads.conf
deploy/run-isolated-backup-tests.sh
test-uploads-backup.sh
deploy/dr-audit.py
deploy/dr-isolation-check.py
deploy/dr-privileged.py
deploy/dr-smoke.py
deploy/test-dr-runtime.py
deploy/test-backup-regression.py
deploy/BACKUP-ROLLOUT.md
deploy/BACKUP-STAGE2.md
deploy/BACKUP-STAGE3.md
deploy/BACKUP-DR-TEST.md
deploy/BACKUP-DR-DEPENDENCY-REVIEW.md
deploy/BACKUP-FINAL-ACCEPTANCE.md
deploy/BACKUP-COMMIT-SCOPE.md
deploy/ISOLATED-BACKUP-TESTS.md
```

Из deploy/deploy.sh включить ТОЛЬКО новый hunk установки каталога drop-in и
90-uploads.conf рядом с установкой backup.service. Предшествующий hunk
«4.5/11 права на БД и бэкапы» изменяет существующие файлы и подавляет ошибки:
оставить для отдельного review. Смешанный файл целиком не включать.

Исключить server.js, lib/db.js, public/css/style.css, deploy/systemd/karimoff.service:
там отдельные изменения приложения/UI/миграций/hardening, не часть этого коммита.
Не откатывать их и не переносить автоматически в другую ветку.

Также исключить БД, uploads, env/ключи, backup-*/архивы/журналы/транскрипты,
deploy/dr-runtime-review и Python __pycache__. .gitignore защищает обычное добавление;
не применять -f. Приватные evidence не нужны для воспроизведения synthetic unit-тестов.

Шаблон основного backup unit содержит только SQLite и исходную ротацию.
Единственный uploads ExecStartPost находится в drop-in. Новая установка через
deploy.sh должна ставить оба файла; production использует уже работающий drop-in,
его менять/перезапускать для этого исправления не требуется.

Статическая локальная проверка собирает Service directives шаблона и всех repo
drop-ins: ровно два ExecStartPost (SQLite rotation, uploads --no-rotation), UMask0077.
Это не вывод живого systemctl show: live-конфигурация в этой задаче не проверялась.
Для следующего разрешённого Linux review нужны systemd-analyze verify и проверка
фактического loaded ExecStartPost; никакого ручного запуска backup.service.
