# DR: privileged namespaces, непривилегированное приложение

Подготовлено 17.11.2026, новый вариант НЕ выполнялся. Требуется разрешение.
Предыдущая попытка остановилась до восстановления: unshare uid_map EPERM.
Здесь нет user namespace; sysctl/AppArmor не меняются. Нет операций с сервисами,
таймером, retention, существующими backup или Git.

## Изоляция и порядок

`dr-privileged.py` — root-координатор. Все записи — в его новом
`/tmp/karimoff-dr-root.*`, root:root 0700. Сначала копируются только проверенный
код и минимальный runtime: Node, Python/stdlib, setpriv, библиотеки ldd.
Host /usr, /etc, /opt, /home, /run и backup-каталоги в sandbox не монтируются.
Production .env, основная БД, uploads, backups не копируются вместе с кодом.

sudo → unshare создаёт mount/network/PID/IPC/UTS namespaces без --user.
Propagation private, chroot read-only; единственный каталог записи — отдельный
work, внутри `/tmp/karimoff-dr.restore`. Свежий /proc ro/hidepid=2 показывает
только тестовые процессы. /dev содержит только null/urandom; /sys и host sockets
отсутствуют. Сеть — собственный lo, без veth и внешних маршрутов.

После chroot setpriv устанавливает UID/GID=65534, пустые supplementary groups,
CapInh/Prm/Eff/Bnd/Amb=0 и no_new_privs=1. Пользователь не создаётся, nobody не
изменяется. App получает случайный тестовый ADMIN_PASSWORD и SMTP на закрытом
порту собственной loopback. Production-секреты не передаются.

**До копирования backup-данных** `dr-isolation-check.py` проверяет namespace IDs,
PID1/отсутствие host-процессов, UID/GID/groups/capabilities/no_new_privs,
отсутствие production-путей/.env/БД/uploads, отказ записи в корень, только lo,
отсутствие маршрутов и ENETUNREACH/EHOSTUNREACH для внешнего адреса.
Только после ISOLATION_OK координатор читает и копирует выбранные backups,
проверяет SHA256 и публикует restore-ready. Приложение источники не видит.
На любой ошибке — остановка; никакого обхода EPERM/AppArmor или запуска без изоляции.

Выбрана пара штатного запуска 17.11.2026 03:36:02 MSK:

- `/var/backups/karimoff/karimoff-2026-11-17T00-36-02-643Z.db`,
  SHA256 `ea33589869d5d734e9e12cf4a4bd00d7f1e98d6de4595b6ee2b5a80a829ca961`;
- `/var/backups/karimoff/uploads-snap-2026-11-17T00-36-02-786Z`, manifest
  `/tmp/karimoff-stage3-4a13bf893b5c429e86ea2baf2d3d575d/new-uploads.sha256`.

Если последний успешный запуск другой — остановка для пересмотра пары/manifest,
без автоматического выбора самого нового каталога. Хеши production-кода также
зафиксированы в координаторе: локальная версия отличается от установленной.
Последовательные SQLite/uploads не гарантируют общую транзакцию.

`dr-audit.py` проверяет integrity_check, foreign_key_check, схему, количество и
хеши записей всех таблиц, ссылки на uploads, пофайловые SHA256 и состав manifest.
Missing/unclassified media references — ошибка. `dr-smoke.py`: HTTP200+HTML шести
страниц и GET каждого upload с SHA256. POST/писем нет. Встроенный backup server.js
пишет только в work/app/backups. Производственные БД/uploads недоступны.

## Команды после разрешения

Локальный PowerShell из корня проекта:

```powershell
$names = @('dr-privileged.py','dr-isolation-check.py','dr-audit.py','dr-smoke.py')
$toolsDir = (& ssh -o StrictHostKeyChecking=yes deployadmin@yaroslav.vyalov2110.fvds.ru 'umask 077; mktemp -d /tmp/karimoff-dr-tools.XXXXXXXXXX').Trim()
if ($LASTEXITCODE -ne 0 -or $toolsDir -notmatch '^/tmp/karimoff-dr-tools\.[A-Za-z0-9]{10}$') { throw 'Invalid tools directory' }
$paths = $names | ForEach-Object { Join-Path 'deploy' $_ }
scp @paths "deployadmin@yaroslav.vyalov2110.fvds.ru:${toolsDir}/"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed' }
$names | ForEach-Object { '{0}  {1}' -f (Get-FileHash "deploy/$_" -Algorithm SHA256).Hash.ToLowerInvariant(),$_ }
Write-Output "TOOLS=$toolsDir"
ssh -tt deployadmin@yaroslav.vyalov2110.fvds.ru
```

Интерактивный SSH: подставить фактический TOOLS; сопоставить четыре SHA256 с локальными.
Создать защищённую root-owned копию команд, снова сопоставить хеши перед запуском:

```bash
set -euo pipefail
umask 077
cd /
TOOLS=/tmp/karimoff-dr-tools.REPLACE_WITH_ACTUAL
test -d "$TOOLS" && test ! -L "$TOOLS"
sha256sum "$TOOLS"/*.py
sudo -l  # пароль только в терминале; проверить полномочия
CONTROL=$(sudo -n mktemp -d /tmp/karimoff-dr-control.XXXXXXXXXX)
for name in dr-privileged.py dr-isolation-check.py dr-audit.py dr-smoke.py; do
  test -f "$TOOLS/$name" && test ! -L "$TOOLS/$name"
  sudo -n install -o root -g root -m 0600 "$TOOLS/$name" "$CONTROL/$name"
  sudo -n cmp "$TOOLS/$name" "$CONTROL/$name"
done
sudo -n /bin/sh -c 'cd "$1" && sha256sum ./*.py' sh "$CONTROL"
# Сопоставить хеши с локальными, затем:
set +e
sudo -n env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C \
  /usr/bin/python3 "$CONTROL/dr-privileged.py" 2>&1 | tee "$TOOLS/coordinator.log"
RC=${PIPESTATUS[0]}
set -e
printf 'coordinator_exit=%s\n' "$RC" | tee "$TOOLS/exit.txt"
# RC != 0: только диагностика и безопасная очистка; не повторять тест.
```

При успехе status.json: PASS, namespace_exit=0, длительности. RTO — от начала
копирования backups до завершения audit/smoke; total_seconds включает подготовку
runtime/изоляции, но не пароль. Postchecks: исходные backup SHA256 неизменны,
PID/состояние приложения и timer неизменны, HTTP200. Это только чтение.

## Хранение и сохранение доказательств

storage.json — фактический занятый объём каждого uploads-снимка (`du -B1`).
Размер нового полного снимка U — добавка конкретного запуска, а не прирост
исходных uploads. При одном запуске/день: +30U за месяц, +365U за год при постоянном
U; с ростом g/день за N дней: N*U+g*N*(N+1)/2. Это прогноз, не годовое измерение.

Координатор печатает EVIDENCE_DIRECTORY. Подставить точный BASE; экспортировать
только диагностику, без восстановленной БД и строк данных. Полные audit.json и
app.log остаются в root0700 до очистки; не выводить их в чат.

```bash
BASE=/tmp/karimoff-dr-root.REPLACE_WITH_ACTUAL
sudo -n test -f "$BASE/status.json"
mkdir -m 700 "$TOOLS/evidence"
for name in status.json namespace.log runtime-platform.json runtime-dependencies.jsonl storage.json disk.txt site-before.txt timer-before.txt; do
  if sudo -n test -f "$BASE/$name"; then
    sudo -n cat "$BASE/$name" > "$TOOLS/evidence/$name"
  fi
done
cp "$TOOLS/coordinator.log" "$TOOLS/exit.txt" "$TOOLS/evidence/"
(cd "$TOOLS/evidence" && sha256sum -- * > SHA256SUMS)
```

Локально: `scp -r deployadmin@yaroslav.vyalov2110.fvds.ru:ACTUAL_TOOLS/evidence LOCAL_PRIVATE_DIRECTORY`.
Сверить SHA256 перед очисткой. Не публиковать необработанный namespace.log.
При расследовании audit.json можно отдельно сохранить в защищённое хранилище.

## Остановка и очистка

Smoke завершает только собственный дочерний Node через terminate/wait. Координатор
всегда reap-ит свой unshare-child; при ошибке terminate, затем kill только этого
unreaped child. --kill-child=SIGKILL и завершение PID1 уничтожают остаточные процессы
тестового PID namespace. Private mounts/network исчезают вместе с процессами.
Нет host umount -R, pkill, операций с сервисами или удаления backup-каталогов.

После сохранения логов проверка ниже запрещает удаление при живых mount namespaces
или открытых ссылках на BASE. Удаляется только каталог с совпавшими device/inode:

```bash
cd /
sudo -n /usr/bin/python3 - "$BASE" <<'PY'
import json, os, pathlib, re, shutil, sys
p=pathlib.Path(sys.argv[1])
assert re.fullmatch(r'/tmp/karimoff-dr-root\.[A-Za-z0-9_\-]+', str(p))
assert not p.is_symlink() and p.resolve(strict=True)==p and p.stat().st_uid==0
saved=json.loads((p/'identity.json').read_text())
assert (p.stat().st_dev,p.stat().st_ino)==(saved['device'],saved['inode'])
assert (p/'status.json').is_file()
for proc in pathlib.Path('/proc').iterdir():
    if not proc.name.isdigit() or int(proc.name)==os.getpid(): continue
    try:
        assert str(p) not in (proc/'mountinfo').read_text(), 'Namespace still mounted'
        for item in [proc/'cwd', proc/'root', *(proc/'fd').iterdir()]:
            try: target=os.readlink(item)
            except FileNotFoundError: continue
            assert not (target==str(p) or target.startswith(str(p)+'/')), 'Test resource still in use'
    except (FileNotFoundError, ProcessLookupError): continue
assert shutil.rmtree.avoids_symlink_attacks
shutil.rmtree(p)
print('TEST_ROOT_REMOVED')
PY
```

На PermissionError/неясном результате очистки — остановка, не заменять проверки
rm -rf. CONTROL/TOOLS с кодом и диагностикой можно оставить root0700/user0700;
они не содержат работающего тестового процесса. Production backups и защищённые
копии этапа3 не затрагиваются.

Ограничения: общий kernel VPS (не VM), ещё не проверенная совместимость privileged
namespaces с AppArmor, отсутствие теста nginx/TLS/SMTP и общей транзакционной
согласованности SQLite/uploads. Новый вариант ни разу не запускался.

## Локальное исправление выбора runtime

Координатор опрашивает установленный Node (platform, arch, glibcVersionRuntime),
не импортируя приложение. Для better-sqlite3 выбирается linux[-musl]/x64|arm64
prebuild по тому же правилу libc, что binding.js. Из обязательной проверки
исключаются только известные несовместимые prebuilds этого пакета. Неизвестные
варианты, отсутствие выбранного ELF, missing SONAME и ненулевой ldd — ошибка.
Остальные ELF (включая sharp) не исключаются. runtime-platform.json фиксирует
выбор/исключения; runtime-dependencies.jsonl сохраняет полную диагностику.
Проверка локально: `py -3 deploy/test-dr-runtime.py`. Это unit-тесты с фикстурами,
не Linux DR. Перед следующей попыткой заново передать скрипты и сверить SHA256.
