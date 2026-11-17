# Внедрение uploads backup без ротации uploads — 17 ноября 2026

Новая версия требует отдельного разрешения и повторной Linux-проверки. Сегодня
подключения к VPS не было; ниже сохранены сведения предыдущего аудита.

## Проверенные факты, 16 ноября 2026

VPS: yaroslav.vyalov2110.fvds.ru, пользователь deployadmin. Чтение выполнено без
sudo. Production не изменялся. Действующий service: /etc/systemd/system/karimoff-backup.service,
root:root 644, drop-in отсутствуют, User/Group=karimoff, UMask=0077, Type=oneshot.
ExecStart делает SQLite backup; единственный ExecStartPost ротирует БД до 14.
BASE /var/backups/karimoff: karimoff:karimoff 750; все предки root:root 755.
Скрипт /opt/karimoff/deploy/uploads-backup.sh отсутствует; родитель karimoff:karimoff 755.
Таймер active/enabled, Persistent=true, 03:30 плюс случайная задержка до 600 секунд.
На момент чтения следующий запуск: 17 ноября 03:33:44 MSK.
Последний Result=success, ExecMainStatus=0. Журналы недоступны deployadmin:
journalctl сообщил недостаток прав; это не доказательство отсутствия событий.

Точные копии действующих service и timer сохранены локально в
backup-production-baseline-5d45403a09e8445e8f2dc87fef19a237, вместе с metadata.txt.
SHA256 service: 8793771acd3c52df773f2bf8f754525a776234ac60657c739a34653b16221d5d.
SHA256 нового скрипта и drop-in приведены в командах проверки ниже.
Root-owned резервная копия на VPS пока НЕ создана; её команды ниже.

ПРЕЖНЯЯ версия: Linux T1–T13 PASS, integration_exit=0, runner_exit=0. Архив тестов:
90593d9482985b1039162a823f4a49c46c6914ae6f519b58c99097f188b90561.
SSH-обёртка после тестов вернула 2 из-за CR в аргументе exit; успех тестов подтверждён
скачанными статусами. Команды ниже выполнять в интерактивном Bash, не передавать
многострочный текст через PowerShell pipeline с CRLF. Проверенный архив оставлен
неизменным как свидетельство тестирования. Не устанавливать из него старый скрипт!
Новая версия добавляет отключение ротации и T14: 16 старых uploads, 16 фиктивных
SQLite и два новых снимка должны сохраниться. T11 включает --rotate только для
тестовых данных. T13 проверяет ошибку rsync с --no-rotation. Изменённые Linux-тесты
пока НЕ ВЫПОЛНЕНЫ; прежний PASS к новой версии не относится. До production повторить
Linux-проверку актуальных файлов в /tmp по отдельному разрешению.

## Совместимость и ограничение активации

Устанавливается ТОЛЬКО drop-in 90-uploads.conf: добавляется ExecStartPost без
пустого сброса ExecStartPost=. Для существующего production полный unit не заменять.
Локальный шаблон исправлен: uploads теперь только в drop-in; новая установка
шаблона вместе с drop-in даёт один запуск.
SQLite, существующая ротация БД, UMask=0077 и hardening сохраняются побайтно.
Порядок: SQLite, исходный ExecStartPost ротации БД, добавленный ExecStartPost uploads
с --no-rotation. При ненулевом коде SQLite следующие шаги не запускаются; при
ненулевом коде первого ExecStartPost uploads не запускается. Префикса '-' нет.
Существующий pipeline ротации БД не использует pipefail: ошибки ls/tail могут
маскироваться его итоговым статусом; по требованию пользователя он не меняется.
Ошибка uploads помечает job failed, но не откатывает предыдущие шаги.
Скрипт использует umask 077 и явно ставит 750/640;
совместим с ProtectSystem=full, ReadWritePaths и PrivateTmp действующего unit.
Симлинки исключаются полностью. БД и uploads не образуют согласованную транзакцию;
при параллельной записи uploads не является снимком одного момента.
Root и процессы karimoff считаются доверенными: root-владелец файла внутри каталога
karimoff не защищает от замены через этот каталог. flock — только кооперативная
блокировка. Очистка касается собственного уникального TMP; чужие .tmp не удаляются.

Ротация uploads отключена по умолчанию и явно флагом --no-rotation в drop-in.
После публикации скрипт выходит до перечисления старых снимков. Единственное
удаление в этом режиме — собственный TMP после проверки типа и device/inode;
он не включает опубликованный снимок. Старые uploads и SQLite не удаляются
этим скриптом. Неверные/лишние аргументы дают отказ до записи. Переменные окружения
не могут включить ротацию: для этого нужен явный --rotate вместо --no-rotation
и отдельное разрешение на изменение команды. Накопление снимков требует контроля
свободного места; отсутствие места даст failure, автоматической очистки не будет.

ВАЖНО: сохранённая штатная ротация SQLite по-прежнему может удалять БД сверх 14.
Гарантия отсутствия удаления относится к новому скрипту uploads, а не ко всему
service. При абсолютном запрете даже штатного удаления SQLite нельзя возобновлять
общий timer. Сохранение его исходного поведения и запрет любого удаления SQLite
при запуске общего задания одновременно невозможны. План не меняет эту политику.
Не начинать установку без согласованного окна остановки backup.timer и решения,
разрешено ли его возобновление. Сейчас timer не трогали. Никаких команд ниже пока
не выполняли. Основной karimoff.service не останавливать и не перезапускать.

## 1. Проверки перед изменениями

В интерактивном Bash на VPS после отдельного разрешения:

```bash
set -euo pipefail
umask 077
STAGE=$(mktemp -d /tmp/karimoff-backup-preserve.XXXXXXXXXX)
mkdir -p "$STAGE/deploy/systemd/karimoff-backup.service.d"
printf 'STAGE=%s\n' "$STAGE"
```

Остановиться для передачи актуальных локальных deploy/uploads-backup.sh и
deploy/systemd/karimoff-backup.service.d/90-uploads.conf через SCP/SFTP в STAGE
с той же структурой. STAGE записать в протокол; после переподключения задать точный
путь, не создавать новый вместо уже заполненного. Продолжить в той же сессии:

```bash
UNIT=/etc/systemd/system/karimoff-backup.service
SCRIPT=/opt/karimoff/deploy/uploads-backup.sh
DROP=/etc/systemd/system/karimoff-backup.service.d/90-uploads.conf
printf '%s  %s\n' 7bfc2a446367b87b5db922ae2713f130937a072bcba6d14ca5f0d749253de0c9 "$STAGE/deploy/uploads-backup.sh" | sha256sum -c -
printf '%s  %s\n' ef0d60fa525e825cb3c51753d45964d070e2e8ba9544ade9c41e794fa7999cd8 "$STAGE/deploy/systemd/karimoff-backup.service.d/90-uploads.conf" | sha256sum -c -
printf '%s  %s\n' 8793771acd3c52df773f2bf8f754525a776234ac60657c739a34653b16221d5d "$UNIT" | sha256sum -c -
test "$(systemctl show karimoff-backup.service -p DropInPaths --value)" = ''
test "$(systemctl show karimoff-backup.service -p UMask --value)" = 0077
test "$(systemctl show karimoff-backup.service -p FragmentPath --value)" = "$UNIT"
test ! -L "$UNIT"
test ! -e "$SCRIPT" && test ! -L "$SCRIPT"
test ! -e /etc/systemd/system/karimoff-backup.service.d
test ! -L /etc/systemd/system/karimoff-backup.service.d
namei -l "$UNIT" /opt/karimoff/deploy /var/backups/karimoff
systemctl cat karimoff-backup.service karimoff-backup.timer
systemctl show karimoff-backup.timer -p ActiveState -p UnitFileState -p NextElapseUSecRealtime
```

При отличиях остановиться. Если STAGE исчез, повторно передать НОВЫЕ локальные
файлы в новый /tmp и проверить SHA256; старый архив использовать нельзя. Если каталог drop-in
уже существует, сначала разобрать его содержимое; не менять чужие настройки.

## 2. Серверная резервная копия и остановка только backup.timer

```bash
ROLLBACK=$(sudo mktemp -d /var/tmp/karimoff-backup-rollback.XXXXXXXXXX)
printf 'ROLLBACK=%s\n' "$ROLLBACK"  # сохранить точный путь в протоколе
sudo cp -a -- "$UNIT" "$ROLLBACK/karimoff-backup.service"
sudo cp -a -- /etc/systemd/system/karimoff-backup.timer "$ROLLBACK/karimoff-backup.timer"
sudo cmp -- "$UNIT" "$ROLLBACK/karimoff-backup.service"
sudo install -o root -g root -m 0600 "$STAGE/deploy/uploads-backup.sh" "$ROLLBACK/new-script"
sudo install -o root -g root -m 0600 "$STAGE/deploy/systemd/karimoff-backup.service.d/90-uploads.conf" "$ROLLBACK/new-drop-in"
sudo cmp -- "$STAGE/deploy/uploads-backup.sh" "$ROLLBACK/new-script"
sudo cmp -- "$STAGE/deploy/systemd/karimoff-backup.service.d/90-uploads.conf" "$ROLLBACK/new-drop-in"
systemctl show karimoff-backup.timer -p ActiveState -p UnitFileState | sudo tee "$ROLLBACK/timer-before.txt" >/dev/null
systemctl cat karimoff-backup.service | sudo tee "$ROLLBACK/effective-before.txt" >/dev/null
sudo systemctl stop karimoff-backup.timer
test "$(systemctl show karimoff-backup.timer -p ActiveState --value)" = inactive
systemctl show karimoff-backup.service -p ActiveState -p SubState -p Job
```

Если backup активен/есть Job, ждать естественного завершения, не убивать процесс.
Продолжить только после inactive и пустого Job:

```bash
test "$(systemctl show karimoff-backup.service -p ActiveState --value)" = inactive
test -z "$(systemctl show karimoff-backup.service -p Job --value)"
sudo cmp -- "$UNIT" "$ROLLBACK/karimoff-backup.service"
sudo -u karimoff test -r /opt/karimoff/uploads
sudo -u karimoff test -x /opt/karimoff/uploads
sudo -u karimoff test -w /var/backups/karimoff
sudo -u karimoff find -P /opt/karimoff/uploads -type l -print
```

Если найдены симлинки — до продолжения выяснить назначение. Последние команды
только читают состояние, не создают копии. Никакого рекурсивного chown/chmod.

## 3. Установка без замены основного unit

```bash
/bin/bash -n "$STAGE/deploy/uploads-backup.sh"
test ! -e "$SCRIPT" && test ! -L "$SCRIPT"
test ! -e /etc/systemd/system/karimoff-backup.service.d
test ! -L /etc/systemd/system/karimoff-backup.service.d
sudo install -d -o root -g root -m 0755 /etc/systemd/system/karimoff-backup.service.d
sudo install -o root -g root -m 0755 "$ROLLBACK/new-script" "$SCRIPT"
sudo install -o root -g root -m 0644 "$ROLLBACK/new-drop-in" "$DROP"
sudo stat -c '%U:%G %a %n' "$SCRIPT" "$DROP"
sudo cmp -- "$UNIT" "$ROLLBACK/karimoff-backup.service"
sudo systemd-analyze verify "$UNIT"
sudo systemctl daemon-reload
systemctl cat karimoff-backup.service
systemctl show karimoff-backup.service -p ExecStart -p ExecStartPost -p UMask -p User -p Group -p DropInPaths
sudo cmp -- "$SCRIPT" "$ROLLBACK/new-script"
sudo cmp -- "$DROP" "$ROLLBACK/new-drop-in"
systemctl show karimoff-backup.timer -p ActiveState -p UnitFileState
```

Ожидается один ExecStart SQLite, два ExecStartPost (ротация БД, uploads --no-rotation), UMask=0077,
неизменённый базовый unit, timer inactive/enabled. Ошибки verify или расхождения —
остановиться и откатить. Не запускать вручную backup.service для проверки.

## 4. Возобновление таймера и наблюдение

Блок ниже требует разрешения внедрения с сохранением существующей SQLite-ротации.
При абсолютном запрете удаления SQLite не выполнять. Uploads-ротация НЕ включается.
Если исходный timer-before.txt подтверждает active, вернуть исходное состояние:

```bash
sudo systemctl start karimoff-backup.timer
systemctl show karimoff-backup.timer -p ActiveState -p UnitFileState -p LastTriggerUSec -p NextElapseUSecRealtime
systemctl list-timers --all karimoff-backup.timer
```

Persistent=true может сразу запустить пропущенное задание. Enable/disable не нужны.
После следующего штатного запуска (не запускать backup.service вручную):

```bash
systemctl show karimoff-backup.service -p ActiveState -p Result -p ExecMainStatus -p ExecMainStartTimestamp -p ExecMainExitTimestamp
sudo journalctl -u karimoff-backup.service -n 100 --no-pager
sudo journalctl -u karimoff-backup.timer -n 30 --no-pager
```

Проверить новое время выполнения, Result=success, ExecMainStatus=0 и сообщение
uploads-backup: published. Старый Result=success не подтверждает новый запуск.
В сообщении uploads должно присутствовать `uploads rotation disabled`.
Контроль диска (только чтение): `df -h /var/backups/karimoff`.

## 5. Откат с восстановлением исходного unit

ROLLBACK — точный сохранённый путь из протокола. При частичной установке переносить
только созданные на её шагах файлы. При посторонних изменениях остановиться.
Ниже полный откат после завершённой установки; .disabled назначения должны
отсутствовать, чтобы не перезаписать результат прежнего отката:

```bash
sudo systemctl stop karimoff-backup.timer
test "$(systemctl show karimoff-backup.service -p ActiveState --value)" = inactive
test -z "$(systemctl show karimoff-backup.service -p Job --value)"
# Если backup активен — ждать, не останавливать его посреди копирования.
sudo test ! -e "$ROLLBACK/90-uploads.conf.disabled"
sudo test ! -e "$ROLLBACK/uploads-backup.sh.disabled"
sudo test -f "$DROP" && sudo test ! -L "$DROP"
sudo cmp -- "$DROP" "$ROLLBACK/new-drop-in"
sudo cmp -- "$UNIT" "$ROLLBACK/karimoff-backup.service"
sudo mv -T -- "$DROP" "$ROLLBACK/90-uploads.conf.disabled"
sudo test -f "$UNIT" && sudo test ! -L "$UNIT"
sudo cp -a -- "$ROLLBACK/karimoff-backup.service" "$UNIT"
sudo cmp -- "$UNIT" "$ROLLBACK/karimoff-backup.service"
# Скрипт раньше отсутствовал: сохранить его вне рабочего пути.
printf '%s  %s\n' 7bfc2a446367b87b5db922ae2713f130937a072bcba6d14ca5f0d749253de0c9 "$SCRIPT" | sudo sha256sum -c -
sudo test ! -L "$SCRIPT"
sudo mv -T -- "$SCRIPT" "$ROLLBACK/uploads-backup.sh.disabled"
sudo systemd-analyze verify "$UNIT"
sudo systemctl daemon-reload
systemctl cat karimoff-backup.service
systemctl show karimoff-backup.service -p DropInPaths -p ExecStartPost -p UMask
systemctl show karimoff-backup.timer -p ActiveState -p UnitFileState
```

Пустой каталог drop-in можно оставить. Timer unit не меняли, его копию сохраняем,
но не перезаписываем вслепую. После отката: DropInPaths пуст, только исходный
ExecStartPost ротации БД, UMask=0077. Возобновлять timer только при разрешённой
исходной удаляющей ротации. Основной сервис, SQLite, uploads и резервные копии
не изменяются и не удаляются ни на одном шаге отката. Копии конфигурации сохраняются.
