#!/usr/bin/env bash
# Run only from the reviewed audit bundle extracted under /tmp.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin LC_ALL=C TMPDIR=/tmp
[[ "$(uname -s)" == Linux ]] || { echo 'SKIP: Linux required'; exit 77; }
[[ "$EUID" -ne 0 ]] || { echo 'Refusing root; use an ordinary test user' >&2; exit 1; }
[[ ! -L /tmp && -d /tmp ]] || { echo 'Require a real /tmp directory' >&2; exit 1; }
for cmd in bash rsync flock realpath stat mktemp find chmod mv rm sort date mkdir ln cmp cat wc seq grep env sha256sum dirname; do
  command -v "$cmd" >/dev/null || { echo "SKIP: missing $cmd" >&2; exit 77; }
done
AUDIT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
[[ "$AUDIT" =~ ^/tmp/karimoff-backup-audit\.[a-zA-Z0-9]+$ ]] || { echo 'Extract bundle directly under /tmp/karimoff-backup-audit.*' >&2; exit 1; }
[[ "$(stat -c '%u:%a' -- "$AUDIT")" == "$EUID:700" ]] || { echo 'Audit directory must be owned by test user with mode 700' >&2; exit 1; }
cd -- "$AUDIT"
[[ ! -L deploy && -d deploy ]]
for file in SHA256SUMS backup-no-rotation.diff test-uploads-backup.sh deploy/uploads-backup.sh deploy/BACKUP-ROLLOUT.md deploy/run-isolated-backup-tests.sh deploy/ISOLATED-BACKUP-TESTS.md deploy/systemd/karimoff-backup.service.d/90-uploads.conf; do
  [[ ! -L "$file" && -f "$file" ]] || { echo "Not a regular bundle file: $file" >&2; exit 1; }
done
sha256sum -c SHA256SUMS
grep -Fxq 'ExecStartPost=/bin/bash /opt/karimoff/deploy/uploads-backup.sh --no-rotation' deploy/systemd/karimoff-backup.service.d/90-uploads.conf
# One invocation per file: extra arguments to bash -n are NOT more scripts.
for script in deploy/uploads-backup.sh test-uploads-backup.sh deploy/run-isolated-backup-tests.sh; do
  /bin/bash -n "$script"
done
RESULTS="$(mktemp -d /tmp/karimoff-backup-results.XXXXXXXXXX)"
printf 'Runner logs: %s\n' "$RESULTS"
trap 'rc=$?; printf "runner_exit=%s\n" "$rc" > "$RESULTS/status.txt"' EXIT
if env -i PATH=/usr/bin:/bin HOME="$RESULTS" TMPDIR=/tmp LC_ALL=C \
    /bin/bash --noprofile --norc "$AUDIT/test-uploads-backup.sh" > "$RESULTS/integration.log" 2>&1; then
  rc=0
else
  rc=$?
fi
cat "$RESULTS/integration.log"
printf 'integration_exit=%s\n' "$rc" > "$RESULTS/integration-status.txt"
[[ "$rc" -eq 0 ]] || exit "$rc"

# Additional error-path test. Only this invocation uses an injected rsync failure.
# Main T1-T12 above use the installed rsync and flock.
ERR="$(mktemp -d /tmp/karimoff-backup-error.XXXXXXXXXX)"
printf 'Error-path fixtures: %s\n' "$ERR"
printf '%s\n' "$ERR" > "$RESULTS/error-fixtures.txt"
mkdir "$ERR/src" "$ERR/base" "$ERR/bin"
printf 'test data\n' > "$ERR/src/file"
# More than KEEP snapshots: a failed copy must not trigger retention.
for n in $(seq 1 15); do
  printf -v ts '2026-01-%02dT00-00-00-000Z' "$n"
  mkdir "$ERR/base/uploads-snap-$ts"
  printf 'preserve\n' > "$ERR/base/uploads-snap-$ts/sentinel"
done
cat > "$ERR/bin/rsync" <<'SH'
#!/bin/bash
set -eu
dest="${!#}"
printf 'partial test data\n' > "${dest%/}/partial"
echo 'INJECTED_RSYNC_FAILURE' >&2
exit 23
SH
chmod 700 "$ERR/bin/rsync"
if env -i PATH="$ERR/bin:/usr/bin:/bin" HOME="$ERR" TMPDIR=/tmp LC_ALL=C \
    UPLOADS_SRC="$ERR/src" UPLOADS_BACKUP_DIR="$ERR/base" \
    UPLOADS_TS=2026-02-01T00-00-00-000Z \
    /bin/bash --noprofile --norc "$AUDIT/deploy/uploads-backup.sh" --no-rotation > "$ERR/error.log" 2>&1; then
  rc=0
else
  rc=$?
fi
cat "$ERR/error.log"
printf 'injected_rsync_exit=%s\n' "$rc" > "$RESULTS/rsync-status.txt"
[[ "$rc" -eq 23 ]]
grep -q INJECTED_RSYNC_FAILURE "$ERR/error.log"
NEW="$ERR/base/uploads-snap-2026-02-01T00-00-00-000Z"
[[ ! -e "$NEW" && ! -L "$NEW" ]]
for n in $(seq 1 15); do
  printf -v ts '2026-01-%02dT00-00-00-000Z' "$n"
  [[ "$(cat "$ERR/base/uploads-snap-$ts/sentinel")" == preserve ]]
done
[[ -z "$(find "$ERR/base" -mindepth 1 -maxdepth 1 -name '.uploads-backup.*' -print -quit)" ]]
echo 'T13 PASS: rsync failure, no publication/rotation, own TMP cleaned'
echo 'All isolated tests passed. Temporary fixtures and logs retained.'
