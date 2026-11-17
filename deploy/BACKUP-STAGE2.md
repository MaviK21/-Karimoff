# Этап 2 — загрузка конфигурации и проверка только uploads

План подготовлен 17 ноября 2026. Команды изменений НЕ выполнены. Нужны отдельное
разрешение и интерактивная SSH-сессия deployadmin@yaroslav.vyalov2110.fvds.ru.
sudo -l выполнить в терминале, пароль вводить только там.

## Подтверждённое чтением состояние, 00:38:46 MSK

- Скрипт и весь drop-in совпали с проверенными SHA256 ниже.
- Базовые service и timer совпали с исходными SHA256; SQLite-ротация не менялась.
- backup.service inactive/dead, MainPID=0, Job пуст; общая очередь jobs пуста.
- backup.timer active/enabled, следующий запуск 17 ноября 03:33:44 MSK,
  Persistent=yes, RandomizedDelaySec=600.
- На диске ExecStartPost uploads содержит --no-rotation. В работающем менеджере
  DropInPaths пуст, ExecStartPost только исходной ротации БД, NeedDaemonReload=yes.
- Основное приложение active/running, MainPID=38862.

systemctl cat читает текст дисковых файлов, но список новых drop-in до reload
может быть неполным — сам systemctl выдал соответствующее предупреждение.
Полный drop-in прочитан непосредственно и проверен SHA256. systemd-analyze verify
проверяет дисковую конфигурацию без запуска backup. systemctl show после reload
должен подтвердить конфигурацию, загруженную работающим менеджером.

## Граница безопасности

Сам daemon-reload не запускает service, но активный timer может запустить его
по расписанию. Поэтому сначала остановить ТОЛЬКО backup.timer, затем проверить,
что service не работает и Job пуст. Не останавливать запущенный backup посередине:
при обнаружении активного задания прекратить этот этап и сообщить его состояние.
Работы проводить вне ближайшего запуска (не менее 15 минут запаса по свежему
расписанию), согласовав отсутствие параллельных ручных запусков администратором.
Если задание уже началось, гарантировать отсутствие удаления его ротацией нельзя.

Ни один шаг функциональной проверки не запускает karimoff-backup.service:
вызывается только проверенный uploads-backup.sh с --no-rotation. SQLite не
открывается на запись; старые копии читаются для контрольных сумм. Создаётся один
новый production-снимок uploads; он остаётся даже при последующем откате.
Общий backup.timer остаётся inactive/enabled. Не включать его автоматически:
восстановление active допускается только отдельным разрешением штатной SQLite-ротации,
которая по-прежнему удаляет БД сверх 14. Persistent=true может вызвать немедленный
пропущенный запуск. Абсолютный запрет удаления SQLite несовместим с возобновлением
этого общего timer без изменения его политики. Эта проверка не изменяет политику.

Прямой запуск подтверждает реальную работу скрипта с production uploads и правами
karimoff. Он не проверяет выполнение внутри sandbox systemd и всю цепочку SQLite →
ротация БД → uploads. Проверку полной цепочки сейчас намеренно не выполняем.

## 1. Предварительная проверка

В интерактивном Bash после разрешения:

```bash
set -euo pipefail
umask 077
sudo -l
UNIT=/etc/systemd/system/karimoff-backup.service
TIMER=/etc/systemd/system/karimoff-backup.timer
SCRIPT=/opt/karimoff/deploy/uploads-backup.sh
DROP=/etc/systemd/system/karimoff-backup.service.d/90-uploads.conf
BASE=/var/backups/karimoff
ROLLBACK=/var/tmp/karimoff-backup-rollback.nknmYrPDEW
CHECK=$(mktemp -d /tmp/karimoff-stage2.XXXXXXXXXX)
printf 'CHECK=%s\n' "$CHECK"  # сохранить точный путь в протоколе
printf '%s  %s\n' 7bfc2a446367b87b5db922ae2713f130937a072bcba6d14ca5f0d749253de0c9 "$SCRIPT" | sha256sum -c -
printf '%s  %s\n' ef0d60fa525e825cb3c51753d45964d070e2e8ba9544ade9c41e794fa7999cd8 "$DROP" | sha256sum -c -
printf '%s  %s\n' 8793771acd3c52df773f2bf8f754525a776234ac60657c739a34653b16221d5d "$UNIT" | sha256sum -c -
printf '%s  %s\n' 34ecb1c357d674a9120bd3ed4d3c5e2d0dde0e0959eb2c21379b9f0a2ce85e3f "$TIMER" | sha256sum -c -
sudo -n cmp "$UNIT" "$ROLLBACK/karimoff-backup.service"
sudo -n cmp "$SCRIPT" "$ROLLBACK/new-script"
sudo -n cmp "$DROP" "$ROLLBACK/new-drop-in"
systemctl show karimoff-backup.timer -p ActiveState -p UnitFileState -p NextElapseUSecRealtime -p LastTriggerUSec | tee "$CHECK/timer-before.txt"
systemctl show karimoff.service -p ActiveState -p SubState -p MainPID > "$CHECK/site-before.txt"
systemctl show karimoff-backup.service -p ActiveState -p Job -p MainPID
test "$(systemctl show karimoff-backup.service -p ActiveState --value)" = inactive
test -z "$(systemctl show karimoff-backup.service -p Job --value)"
curl --fail --silent --show-error --max-time 20 -o /dev/null -w 'http_before=%{http_code}\n' https://karimoff.pro/
sudo -n -u karimoff df -h "$BASE"
```

Проверить запас времени и свободное место до продолжения. При несовпадениях,
неожиданном drop-in или активном job остановиться. Не изменять чужую конфигурацию.

## 2. Остановка только таймера и загрузка конфигурации

```bash
sudo -n systemctl stop karimoff-backup.timer
test "$(systemctl show karimoff-backup.timer -p ActiveState --value)" = inactive
test "$(systemctl show karimoff-backup.service -p ActiveState --value)" = inactive
test -z "$(systemctl show karimoff-backup.service -p Job --value)"
sudo -n systemd-analyze verify "$UNIT"
sudo -n systemctl daemon-reload
systemctl cat karimoff-backup.service | tee "$CHECK/unit-after.txt"
systemctl show karimoff-backup.service -p ExecStart -p ExecStartPost -p UMask -p DropInPaths -p ActiveState -p Job -p NeedDaemonReload | tee "$CHECK/loaded-after.txt"
test "$(systemctl show karimoff-backup.service -p DropInPaths --value)" = "$DROP"
test "$(systemctl show karimoff-backup.service -p UMask --value)" = 0077
test "$(systemctl show karimoff-backup.timer -p ActiveState --value)" = inactive
test "$(systemctl show karimoff-backup.service -p ActiveState --value)" = inactive
test -z "$(systemctl show karimoff-backup.service -p Job --value)"
```

Проверить весь loaded-after.txt: один SQLite ExecStart; два ExecStartPost в порядке
исходная ротация БД, uploads с --no-rotation. Пустого сброса ExecStartPost нет.
При расхождении — не запускать проверку, перейти к согласованному откату ниже.

## 3. Функциональная проверка uploads без запуска SQLite/её ротации

```bash
# Только чтение существующих копий. pipefail сохраняет ошибки find/sha256sum.
sudo -n -u karimoff find -P "$BASE" -maxdepth 1 -type f -name '*.db' -exec sha256sum -- {} + | LC_ALL=C sort > "$CHECK/sqlite-before.sha256"
sudo -n -u karimoff find -P "$BASE" -maxdepth 1 -name '*.db' -printf '%y %D:%i %p\n' | LC_ALL=C sort > "$CHECK/sqlite-objects-before.txt"
sudo -n -u karimoff find -P "$BASE" -mindepth 1 -maxdepth 1 -name 'uploads-snap-*' -printf '%y %D:%i %p\n' | LC_ALL=C sort > "$CHECK/uploads-before.txt"
TS=$(date -u '+%Y-%m-%dT%H-%M-%S-%3NZ')
SNAP="$BASE/uploads-snap-$TS"
printf '%s\n' "$SNAP" > "$CHECK/new-snapshot.txt"
if sudo -n -u karimoff env -i PATH=/usr/bin:/bin LC_ALL=C \
    UPLOADS_SRC=/opt/karimoff/uploads UPLOADS_BACKUP_DIR="$BASE" UPLOADS_TS="$TS" \
    /bin/bash "$SCRIPT" --no-rotation > "$CHECK/uploads.log" 2>&1; then
  rc=0
else
  rc=$?
fi
printf 'uploads_exit=%s\n' "$rc" > "$CHECK/uploads-status.txt"
cat "$CHECK/uploads.log" "$CHECK/uploads-status.txt"
test "$rc" -eq 0
grep -Fq 'uploads rotation disabled' "$CHECK/uploads.log"
sudo -n -u karimoff test -d "$SNAP"
sudo -n -u karimoff find -P "$SNAP" -type l -print > "$CHECK/unexpected-links.txt"
sudo -n -u karimoff find -P "$SNAP" -type d ! -perm 0750 -print > "$CHECK/bad-dir-modes.txt"
sudo -n -u karimoff find -P "$SNAP" -type f ! -perm 0640 -print > "$CHECK/bad-file-modes.txt"
test ! -s "$CHECK/unexpected-links.txt"
test ! -s "$CHECK/bad-dir-modes.txt"
test ! -s "$CHECK/bad-file-modes.txt"
sudo -n -u karimoff find -P "$BASE" -maxdepth 1 -type f -name '*.db' -exec sha256sum -- {} + | LC_ALL=C sort > "$CHECK/sqlite-after.sha256"
sudo -n -u karimoff find -P "$BASE" -maxdepth 1 -name '*.db' -printf '%y %D:%i %p\n' | LC_ALL=C sort > "$CHECK/sqlite-objects-after.txt"
cmp "$CHECK/sqlite-before.sha256" "$CHECK/sqlite-after.sha256"
cmp "$CHECK/sqlite-objects-before.txt" "$CHECK/sqlite-objects-after.txt"
sudo -n -u karimoff find -P "$BASE" -mindepth 1 -maxdepth 1 -name 'uploads-snap-*' -printf '%y %D:%i %p\n' | LC_ALL=C sort > "$CHECK/uploads-after.txt"
LC_ALL=C comm -23 "$CHECK/uploads-before.txt" "$CHECK/uploads-after.txt" > "$CHECK/missing-old-uploads.txt"
test ! -s "$CHECK/missing-old-uploads.txt"
systemctl show karimoff.service -p ActiveState -p SubState -p MainPID > "$CHECK/site-after.txt"
cmp "$CHECK/site-before.txt" "$CHECK/site-after.txt"
curl --fail --silent --show-error --max-time 20 -o /dev/null -w 'http_after=%{http_code}\n' https://karimoff.pro/
systemctl show karimoff-backup.timer -p ActiveState -p UnitFileState
systemctl show karimoff-backup.service -p ActiveState -p Job -p Result -p ExecMainStartTimestamp
test "$(systemctl show karimoff-backup.timer -p ActiveState --value)" = inactive
test "$(systemctl show karimoff-backup.service -p ActiveState --value)" = inactive
test -z "$(systemctl show karimoff-backup.service -p Job --value)"
```

Журнал прямого запуска — $CHECK/uploads.log, не журнал backup.service. Старый
Result=success общего service не доказывает функциональную проверку uploads.
При любой ошибке — остановиться, сохранить CHECK; не удалять созданный снимок.

## 4. Точный откат активации

Откат снимает drop-in с диска и перечитывает конфигурацию, оставляя проверенный
скрипт неиспользуемым. Базовый unit не переписываем, если он побайтно исходный.
Не восстанавливаем неизвестные параллельные изменения поверх файлов администратора.

```bash
# UNIT, SCRIPT, DROP, ROLLBACK — точные значения из раздела 1.
test "$(systemctl show karimoff-backup.timer -p ActiveState --value)" = inactive
test "$(systemctl show karimoff-backup.service -p ActiveState --value)" = inactive
test -z "$(systemctl show karimoff-backup.service -p Job --value)"
sudo -n cmp "$UNIT" "$ROLLBACK/karimoff-backup.service"
sudo -n cmp "$DROP" "$ROLLBACK/new-drop-in"
sudo -n test -f "$DROP"
sudo -n test ! -L "$DROP"
sudo -n test ! -e "$ROLLBACK/90-uploads.stage2-disabled"
sudo -n test ! -L "$ROLLBACK/90-uploads.stage2-disabled"
sudo -n mv -T -- "$DROP" "$ROLLBACK/90-uploads.stage2-disabled"
sudo -n systemd-analyze verify "$UNIT"
sudo -n systemctl daemon-reload
systemctl cat karimoff-backup.service
systemctl show karimoff-backup.service -p DropInPaths -p ExecStartPost -p UMask
test "$(systemctl show karimoff-backup.service -p DropInPaths --value)" = ''
systemctl show karimoff-backup.timer -p ActiveState -p UnitFileState
systemctl show karimoff.service -p ActiveState -p SubState -p MainPID
curl --fail --silent --show-error --max-time 20 -o /dev/null -w 'http_rollback=%{http_code}\n' https://karimoff.pro/
```

Если требуется также откат установки файла скрипта (отдельно согласовать):

```bash
sudo -n cmp "$SCRIPT" "$ROLLBACK/new-script"
sudo -n test ! -L "$SCRIPT"
sudo -n test ! -e "$ROLLBACK/uploads-backup.stage2-disabled"
sudo -n test ! -L "$ROLLBACK/uploads-backup.stage2-disabled"
sudo -n mv -T -- "$SCRIPT" "$ROLLBACK/uploads-backup.stage2-disabled"
```

Резервные копии и созданный проверкой снимок не удаляются. Timer unit и enabled
состояние сохраняются. Возврат active отложен до отдельного разрешения штатной
SQLite-ротации: полного возврата расписания с одновременной гарантией отсутствия
удалений SQLite этот unit не позволяет. Основной karimoff.service не перезапускается.
