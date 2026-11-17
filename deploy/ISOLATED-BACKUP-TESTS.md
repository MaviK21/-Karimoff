# Повторная Linux-проверка: uploads без ротации

Пакет backup-linux-no-rotation.tar.gz содержит восемь обычных файлов:
SHA256SUMS, backup-no-rotation.diff, test-uploads-backup.sh,
deploy/uploads-backup.sh, deploy/run-isolated-backup-tests.sh,
deploy/BACKUP-ROLLOUT.md, deploy/ISOLATED-BACKUP-TESTS.md,
deploy/systemd/karimoff-backup.service.d/90-uploads.conf.
Архив предыдущей версии backup-linux-audit.tar.gz не заменяется.

Проверить внешний SHA256 по отдельному файлу и доверенному отчёту. Перед распаковкой
проверить точный список восьми имён и обычный тип каждого объекта (без ссылок,
абсолютных путей и ../). Распаковать с --no-same-owner --no-same-permissions
--keep-old-files только в новый каталог /tmp/karimoff-backup-audit.XXXXXXXXXX,
созданный mktemp обычным deployadmin, umask 077. Внутри выполнить sha256sum -c SHA256SUMS.
Drop-in только проверяется как текст; не устанавливается. Не применять diff,
не выполнять инструкции внедрения из BACKUP-ROLLOUT.md в ходе теста.

В Bash из этого каталога, AUDIT — его точный абсолютный путь:

```bash
if env -i PATH=/usr/bin:/bin HOME="$AUDIT" TMPDIR=/tmp LC_ALL=C \
    /bin/bash --noprofile --norc deploy/run-isolated-backup-tests.sh > run.log 2>&1; then
  rc=0
else
  rc=$?
fi
printf 'exit=%s\n' "$rc" > run-status.txt
cat run.log
cat run-status.txt
```

Критерий: фактический exit=0 и T1–T14 PASS. T14 выводится до T13, поскольку T13
выполняет runner после основного сценария. Код 77 — пропуск, не успех.
T1–T12: содержимое, права 750/640, симлинки, flock, коллизии, ошибки, зависимости;
T11 явно включает --rotate только для фиктивных снимков в /tmp и проверяет 14
оставшихся. T14 проверяет сохранение 16 старых uploads, 16 фиктивных SQLite и двух
новых снимков при настройке по умолчанию и при --no-rotation. T13 внедряет отказ
rsync=23 после частичной записи, проверяет очистку собственного TMP, отсутствие
публикации и сохранность 15 старых тестовых снимков. Код 23 ожидаемый, не сбой теста.

Все данные и журналы сохраняются в уникальных /tmp. Общей очистки нет. Sudo,
systemctl и production данные не используются. Отчёт о фактическом запуске
сохраняется отдельно после завершения: документы внутри неизменяемого архива
фиксируют сценарий, не заранее объявленный успех. При ошибке остановиться,
сохранить stdout/stderr, статусы и напечатанные каталоги для диагностики.
Root и процессы того же UID считаются доверенными. Режим --no-rotation не удаляет
старые копии; это не меняет штатную ротацию SQLite основного production unit.
