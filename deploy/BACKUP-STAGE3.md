# Этап 3: возобновление автоматических backup — только после разрешения

## Аудит 17 ноября 2026

В 01:14:50 MSK: timer inactive/enabled, Persistent=yes, RandomizedDelayUSec=10min,
AccuracyUSec=1min, NextElapseUSecRealtime пуст (таймер остановлен). Последняя отметка
и mtime /var/lib/systemd/timers/stamp-karimoff-backup.timer: 16 ноября 03:37:35 MSK.
Ближайшее календарное событие: 17 ноября 03:30 MSK; фактический запуск может быть
позже из-за задержки и точности. До этого события оснований для Persistent catch-up
не обнаружено. После пропуска события start может запустить backup почти сразу
(с учётом RandomizedDelaySec). Перепроверять время и stamp непосредственно перед start.
Stamp не изменять и не удалять; OnCalendar/Persistent не менять.

Загруженный service inactive, Job пуст, UMask=0077, NeedDaemonReload=no. Порядок:
SQLite backup → исходный ExecStartPost ротации SQLite → uploads --no-rotation.
DropInPaths=/etc/systemd/system/karimoff-backup.service.d/90-uploads.conf.
Если SQLite или предыдущий ExecStartPost вернёт ошибку, следующий шаг не запускается.
Исходный pipeline не имеет pipefail: ошибки его промежуточных команд могут маскироваться.
Этот план его не меняет; результат ротации дополнительно сверяется по именам и SHA256.

Правило ротации: `ls -1t /var/backups/karimoff/karimoff-*.db | tail -n +15 | xargs -r rm -f`.
Сортировка по mtime, а не по дате в имени. Сейчас 14 обычных файлов со стандартными
именами; при одной успешной новой копии, отсутствии параллельных изменений и более
новом mtime новой копии будет удалён ровно один файл:

`/var/backups/karimoff/karimoff-2026-10-31T00-34-21-225Z.db`

mtime: 31 октября 2026, 03:34:21.230414072 MSK; размер 221184 байта;
SHA256: 2f1a69b75aeaf4e229c159780c8d9df3baffdca7b6c49aa6de71dde1e6586ec6.
Остальные 13 при первом таком запуске сохраняются. Следующий ежедневный запуск
обычно удалит следующую старейшую копию: 2026-11-01T00-35-42-235Z.db.
Точный список всегда пересчитывается перед активацией. Не давать параллельных
ручных запусков backup-service или изменений каталога на время первого наблюдения.

13 старых SQLite-копий имеют 644, последняя — 600. Существующие права не исправляли.
Новая копия должна получить 600 благодаря UMask=0077. Uploads-снимок от этапа 2
сохранён, права корня 750. sqlite3 доступен: /usr/bin/sqlite3.
Журнал чтения: backup-stage3-review-06da70b0698e4ed7a6f69cc5c30d5804/inventory.log,
ssh_exit=0. Никаких production-изменений во время подготовки не выполнялось.

## Условие согласования

С неизменённой ротацией нельзя гарантировать сохранение всех исходных путей в
рабочем каталоге. Предлагается перед start сохранить ВСЕ 14 копий отдельно в
root-owned каталоге /var/backups/karimoff-stage3-preserved.*, вне glob ротации,
проверить SHA256 и SQLite integrity_check. Это сохраняет данные, но не запрещает
удаление старейшего рабочего файла штатной ротацией. Пользователь должен одобрить
именно этот ожидаемый эффект и последующую штатную ротацию. При запрете любого
удаления исходных файлов timer оставить остановленным. Никакие команды ниже пока
не выполнены. Не запускать backup.service вручную, не перезапускать приложение.

## 1. Предварительные проверки и защищённые копии

После разрешения, интерактивный SSH под deployadmin, пароль sudo только в терминале:

```bash
set -euo pipefail
umask 077
cd /
export LC_ALL=C
sudo -l
BASE=/var/backups/karimoff
UNIT=/etc/systemd/system/karimoff-backup.service
TIMER=/etc/systemd/system/karimoff-backup.timer
SCRIPT=/opt/karimoff/deploy/uploads-backup.sh
DROP=/etc/systemd/system/karimoff-backup.service.d/90-uploads.conf
CHECK=$(mktemp -d /tmp/karimoff-stage3.XXXXXXXXXX)
printf 'CHECK=%s\n' "$CHECK"
printf '%s  %s\n' \
  7bfc2a446367b87b5db922ae2713f130937a072bcba6d14ca5f0d749253de0c9 "$SCRIPT" \
  ef0d60fa525e825cb3c51753d45964d070e2e8ba9544ade9c41e794fa7999cd8 "$DROP" \
  8793771acd3c52df773f2bf8f754525a776234ac60657c739a34653b16221d5d "$UNIT" \
  34ecb1c357d674a9120bd3ed4d3c5e2d0dde0e0959eb2c21379b9f0a2ce85e3f "$TIMER" | sha256sum -c -
test "$(systemctl show karimoff-backup.timer -p ActiveState --value)" = inactive
test "$(systemctl show karimoff-backup.timer -p UnitFileState --value)" = enabled
test "$(systemctl show karimoff-backup.service -p ActiveState --value)" = inactive
test -z "$(systemctl show karimoff-backup.service -p Job --value)"
test "$(systemctl show karimoff-backup.service -p DropInPaths --value)" = "$DROP"
test "$(systemctl show karimoff-backup.service -p UMask --value)" = 0077
systemctl show karimoff-backup.service -p ExecStart -p ExecStartPost -p NeedDaemonReload
systemctl show karimoff-backup.timer -p Persistent -p LastTriggerUSec -p RandomizedDelayUSec -p AccuracyUSec
stat /var/lib/systemd/timers/stamp-karimoff-backup.timer
date -Is
systemd-analyze calendar --iterations=2 '*-*-* 03:30:00'
systemctl show karimoff.service -p ActiveState -p SubState -p MainPID > "$CHECK/site-before.txt"
systemctl show karimoff-backup.service -p ExecMainStartTimestampMonotonic --value > "$CHECK/run-before.txt"
HTTP=$(curl --fail --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' https://karimoff.pro/)
printf 'http_before=%s\n' "$HTTP"
test "$HTTP" = 200
```

Проверить два ExecStartPost и --no-rotation. Не продолжать при изменившейся
конфигурации, активном job или неясном риске catch-up. Если событие уже пропущено,
отдельно согласовать возможный немедленный запуск. Следующие команды только
копируют файлы, без удаления оригиналов:

```bash
sudo -n -u karimoff /bin/bash -c 'set -euo pipefail; shopt -s nullglob; f=(/var/backups/karimoff/karimoff-*.db); for p in "${f[@]}"; do [[ -f "$p" && ! -L "$p" && "$p" =~ ^/var/backups/karimoff/karimoff-[0-9TZ.-]+\.db$ ]] || exit 1; done; ((${#f[@]} == 14)); LC_ALL=C ls -1t -- "${f[@]}"' > "$CHECK/sqlite-order.txt"
sort "$CHECK/sqlite-order.txt" > "$CHECK/sqlite-before.paths"
tail -n +14 "$CHECK/sqlite-order.txt" | sort > "$CHECK/expected-deletions.txt"
printf '%s\n' "$BASE/karimoff-2026-10-31T00-34-21-225Z.db" > "$CHECK/approved-deletion.txt"
cmp "$CHECK/expected-deletions.txt" "$CHECK/approved-deletion.txt"
SAFE=$(sudo -n mktemp -d /var/backups/karimoff-stage3-preserved.XXXXXXXXXX)
printf 'SAFE=%s\n' "$SAFE" | tee "$CHECK/safe-path.txt"
: > "$CHECK/sqlite-before.sha256"
while IFS= read -r src; do
  name=${src##*/}
  sudo -n -u karimoff sha256sum -- "$src" >> "$CHECK/sqlite-before.sha256"
  sudo -n cp --preserve=timestamps -- "$src" "$SAFE/$name"
  sudo -n chown root:root "$SAFE/$name"
  sudo -n chmod 0600 "$SAFE/$name"
  sudo -n cmp -- "$src" "$SAFE/$name"
  test "$(sudo -n sqlite3 "file:$SAFE/$name?mode=ro&immutable=1" 'PRAGMA integrity_check;')" = ok
done < "$CHECK/sqlite-before.paths"
```

Проверку manifest выполнять root (karimoff не может читать CHECK=700):

```bash
sudo -n sha256sum -c "$CHECK/sqlite-before.sha256"
sudo -n install -o root -g root -m 0600 "$CHECK/sqlite-before.sha256" "$SAFE/original-paths.sha256"
sudo -n install -o root -g root -m 0600 "$CHECK/expected-deletions.txt" "$SAFE/expected-deletions.txt"
sudo -n -u karimoff find -P "$BASE" -mindepth 1 -maxdepth 1 -type d -name 'uploads-snap-*' -print | sort > "$CHECK/uploads-before.paths"
sudo -n -u karimoff find -P "$BASE" -mindepth 2 -path "$BASE/uploads-snap-*/*" -type f -exec sha256sum -- {} + | sort > "$CHECK/uploads-before.sha256"
sudo -n stat -c '%U:%G %a %n' "$SAFE"
```

Не передавать sha256sum от karimoff путь к закрытому CHECK. Все find выполняются
после cd /, чтобы не повторить ошибку этапа 2. SAFE и журналы не удалять.

## 2. Возобновить только timer и дождаться первого штатного запуска

При неизменном согласованном наборе кандидатов, проверенных сохранённых копиях
и повторной проверке отсутствия job:

```bash
test "$(systemctl show karimoff-backup.service -p ActiveState --value)" = inactive
test -z "$(systemctl show karimoff-backup.service -p Job --value)"
sudo -n sha256sum -c "$CHECK/sqlite-before.sha256"
sudo -n -u karimoff find -P "$BASE" -maxdepth 1 -name 'karimoff-*.db' -print | sort > "$CHECK/sqlite-pre-start.paths"
cmp "$CHECK/sqlite-before.paths" "$CHECK/sqlite-pre-start.paths"
SINCE=$(date -Is)
printf '%s\n' "$SINCE" > "$CHECK/activation-time.txt"
sudo -n systemctl start karimoff-backup.timer
systemctl show karimoff-backup.timer -p ActiveState -p UnitFileState -p NextElapseUSecRealtime -p LastTriggerUSec | tee "$CHECK/timer-started.txt"
systemctl list-timers --all karimoff-backup.timer
OLD=$(cat "$CHECK/run-before.txt")
DEADLINE=$(( $(date +%s) + 93600 ))
while :; do
  NEW=$(systemctl show karimoff-backup.service -p ExecMainStartTimestampMonotonic --value)
  STATE=$(systemctl show karimoff-backup.service -p ActiveState --value)
  if [[ "$NEW" != "$OLD" && ( "$STATE" == inactive || "$STATE" == failed ) ]]; then break; fi
  if (( $(date +%s) >= DEADLINE )); then echo 'Scheduled-run timeout'; exit 1; fi
  sleep 30
done
systemctl show karimoff-backup.service -p Result -p ExecMainStatus -p ExecStart -p ExecStartPost | tee "$CHECK/first-run-result.txt"
sudo -n journalctl -u karimoff-backup.service --since "$SINCE" --no-pager > "$CHECK/first-run.log"
cat "$CHECK/first-run.log"
test "$(systemctl show karimoff-backup.service -p Result --value)" = success
test "$(systemctl show karimoff-backup.service -p ExecMainStatus --value)" = 0
grep -Fq 'uploads rotation disabled' "$CHECK/first-run.log"
```

Не вызывать start/restart backup.service. Если ожидание/проверка завершились ошибкой,
не повторять backup: остановить только timer по процедуре отката, сохранить логи.

## 3. Проверить фактическую ротацию, новые копии и здоровье

```bash
sudo -n -u karimoff find -P "$BASE" -mindepth 1 -maxdepth 1 -type f -name 'karimoff-*.db' -print | sort > "$CHECK/sqlite-after.paths"
comm -23 "$CHECK/sqlite-before.paths" "$CHECK/sqlite-after.paths" > "$CHECK/actual-deletions.txt"
cmp "$CHECK/expected-deletions.txt" "$CHECK/actual-deletions.txt"
comm -13 "$CHECK/sqlite-before.paths" "$CHECK/sqlite-after.paths" > "$CHECK/new-db.paths"
test "$(wc -l < "$CHECK/new-db.paths")" -eq 1
test "$(wc -l < "$CHECK/sqlite-after.paths")" -eq 14
NEWDB=$(cat "$CHECK/new-db.paths")
test "$(sudo -n -u karimoff sqlite3 "file:$NEWDB?mode=ro&immutable=1" 'PRAGMA integrity_check;')" = ok
test "$(sudo -n stat -c '%U:%G:%a' "$NEWDB")" = karimoff:karimoff:600
while IFS= read -r src; do
  sudo -n test -f "$SAFE/${src##*/}"
  if sudo -n test -e "$src"; then sudo -n cmp -- "$src" "$SAFE/${src##*/}"; fi
done < "$CHECK/sqlite-before.paths"
sudo -n -u karimoff find -P "$BASE" -mindepth 1 -maxdepth 1 -type d -name 'uploads-snap-*' -print | sort > "$CHECK/uploads-after.paths"
comm -23 "$CHECK/uploads-before.paths" "$CHECK/uploads-after.paths" > "$CHECK/missing-uploads.txt"
test ! -s "$CHECK/missing-uploads.txt"
sudo -n sha256sum -c "$CHECK/uploads-before.sha256"
comm -13 "$CHECK/uploads-before.paths" "$CHECK/uploads-after.paths" > "$CHECK/new-uploads.paths"
test "$(wc -l < "$CHECK/new-uploads.paths")" -eq 1
NEWSNAP=$(cat "$CHECK/new-uploads.paths")
sudo -n -u karimoff find -P "$NEWSNAP" -type l -print > "$CHECK/links.txt"
sudo -n -u karimoff find -P "$NEWSNAP" -type d ! -perm 0750 -print > "$CHECK/dir-modes.txt"
sudo -n -u karimoff find -P "$NEWSNAP" -type f ! -perm 0640 -print > "$CHECK/file-modes.txt"
test ! -s "$CHECK/links.txt" && test ! -s "$CHECK/dir-modes.txt" && test ! -s "$CHECK/file-modes.txt"
systemctl show karimoff.service -p ActiveState -p SubState -p MainPID > "$CHECK/site-after.txt"
cmp "$CHECK/site-before.txt" "$CHECK/site-after.txt"
HTTP=$(curl --fail --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' https://karimoff.pro/)
printf 'http_after=%s\n' "$HTTP"
test "$HTTP" = 200
systemctl show karimoff-backup.timer -p ActiveState -p UnitFileState -p LastTriggerUSec -p NextElapseUSecRealtime
```

Успех: один новый целостный SQLite-файл 600, удалён только согласованный рабочий
файл, его копия сохранена в SAFE, один новый uploads-снимок 750/640 без симлинков,
прежний uploads цел, Result=success, HTTP 200 и прежний PID. После успеха таймер
остаётся active/enabled только в рамках разрешения штатной ежедневной SQLite-ротации.

## 4. Откат этапа 3

```bash
sudo -n systemctl stop karimoff-backup.timer
systemctl show karimoff-backup.timer -p ActiveState -p UnitFileState
systemctl show karimoff-backup.service -p ActiveState -p Job -p MainPID
sudo -n journalctl -u karimoff-backup.service --since "$SINCE" --no-pager
```

Timer должен быть inactive/enabled. Уже работающий backup не прерывать: дождаться
естественного завершения и проверить состояние. Сервис и приложение не рестартовать,
новые копии и SAFE не удалять. Файлы unit не менялись, daemon-reload не нужен.
Откат расписания не отменяет уже состоявшуюся ротацию. Старые данные находятся в SAFE.
Если отдельно согласовано восстановление удалённого рабочего файла, после остановки
таймера и отсутствия job (не затирая существующий объект):

```bash
test "$(systemctl show karimoff-backup.service -p ActiveState --value)" = inactive
test -z "$(systemctl show karimoff-backup.service -p Job --value)"
RESTORE="$BASE/karimoff-2026-10-31T00-34-21-225Z.db"
sudo -n test ! -e "$RESTORE" && sudo -n test ! -L "$RESTORE"
printf '%s  %s\n' 2f1a69b75aeaf4e229c159780c8d9df3baffdca7b6c49aa6de71dde1e6586ec6 "$SAFE/${RESTORE##*/}" | sudo -n sha256sum -c -
sudo -n cp --no-clobber --preserve=timestamps -- "$SAFE/${RESTORE##*/}" "$RESTORE"
sudo -n cmp -- "$SAFE/${RESTORE##*/}" "$RESTORE"
sudo -n chown karimoff:karimoff "$RESTORE"
sudo -n chmod 0644 "$RESTORE" # исходный режим именно этой копии
```

Восстановление выполняется только при согласованном отсутствии параллельных записей
администратора. Оно вернёт 15 рабочих копий; следующая ротация снова выберет старейшую.
До отдельного решения timer остаётся остановленным, SAFE сохраняется.
