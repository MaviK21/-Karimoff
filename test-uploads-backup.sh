#!/usr/bin/env bash
# Real Linux integration tests; no mocks of rsync/flock, no production data.
set -euo pipefail
export PATH=/usr/bin:/bin LC_ALL=C TMPDIR=/tmp
[[ "$(uname -s)" == Linux ]] || { echo 'SKIP: Linux required' >&2; exit 77; }
[[ "$EUID" -ne 0 ]] || { echo 'Refusing root' >&2; exit 1; }
[[ ! -L /tmp && -d /tmp ]] || { echo 'Require a real /tmp directory' >&2; exit 1; }
for cmd in rsync flock realpath stat mktemp find chmod mv rm sort date mkdir ln cmp cat wc seq grep env dirname; do
  command -v "$cmd" >/dev/null || { echo "SKIP: missing $cmd" >&2; exit 77; }
done
SCRIPT="$(cd -- "$(dirname -- "$0")" && pwd)/deploy/uploads-backup.sh"
BASH_BIN="$BASH"
umask 077
WORK="$(mktemp -d /tmp/karimoff-backup-test.XXXXXXXXXX)"
# The test never removes WORK: leave test evidence for inspection.
echo "Test data and logs: $WORK"
SRC="$WORK/src"; BASE="$WORK/base"
mkdir "$SRC" "$BASE"
printf 'test content\n' > "$SRC/file"
run() {
  [[ "$SRC" == "$WORK/"* && "$BASE" == "$WORK/"* ]] || return 99
  env -i PATH=/usr/bin:/bin LC_ALL=C HOME="$WORK" TMPDIR=/tmp \
    UPLOADS_SRC="$SRC" UPLOADS_BACKUP_DIR="$BASE" UPLOADS_TS="$1" "$BASH_BIN" "$SCRIPT" "${@:2}"
}
reject_number=0
reject() {
  local expected="$1" rc
  shift
  reject_number=$((reject_number+1))
  local log="$WORK/rejected-$reject_number.log"
  if "$@" > "$log" 2>&1; then
    echo 'FAIL: unexpected success' >&2; exit 1
  else
    rc=$?
  fi
  [[ "$rc" -eq 1 ]] && grep -Fq -- "$expected" "$log" || {
    cat "$log" >&2; echo "FAIL: wrong rejection (rc=$rc): $expected" >&2; exit 1;
  }
}
pass() { echo "$1 PASS"; }

# T1: check the exit status of EACH invocation, not only the final count.
for n in 1 2 3; do
  printf -v ts '2026-01-%02dT00-00-00-000Z' "$n"
  if run "$ts" > "$WORK/t1-$n.log" 2>&1; then :; else
    rc=$?; echo "FAIL T1 run $n: rc=$rc" >&2; exit 1
  fi
done
[[ "$(find "$BASE" -maxdepth 1 -type d -name 'uploads-snap-*' | wc -l)" == 3 ]]
pass T1

SNAP="$BASE/uploads-snap-2026-01-03T00-00-00-000Z"
cmp "$SRC/file" "$SNAP/file"
[[ "$(stat -c %a "$SNAP")" == 750 && "$(stat -c %a "$SNAP/file")" == 640 ]]
pass T2
reject 'snapshot already exists' run '2026-01-03T00-00-00-000Z'
cmp "$SRC/file" "$SNAP/file"
pass T3

# Unknown leftovers must survive, including a directory and a dangling link.
mkdir "$BASE/uploads-snap-foreign.tmp"
printf 'keep' > "$BASE/uploads-snap-foreign.tmp/sentinel"
ln -s "$WORK/absent" "$BASE/.uploads-backup.foreign"
run '2026-01-04T00-00-00-000Z' > "$WORK/t4.log" 2>&1
[[ -f "$BASE/uploads-snap-foreign.tmp/sentinel" && -L "$BASE/.uploads-backup.foreign" ]]
pass T4

# T5: -L detects dangling links too; all links must be absent in the copy.
mkdir "$SRC/sub" "$WORK/external"
printf 'outside' > "$WORK/external/sentinel"
ln -s file "$SRC/internal"
ln -s missing "$SRC/dangling"
ln -s "$WORK/external" "$SRC/external"
ln -s ../file "$SRC/sub/relative"
ln -s cycle "$SRC/cycle"
run '2026-01-05T00-00-00-000Z' > "$WORK/t5.log" 2>&1
SNAP="$BASE/uploads-snap-2026-01-05T00-00-00-000Z"
for name in internal dangling external sub/relative cycle; do
  [[ -L "$SRC/$name" ]]
  [[ ! -L "$SNAP/$name" && ! -e "$SNAP/$name" ]]
done
[[ "$(cat "$WORK/external/sentinel")" == outside ]]
[[ -z "$(find -P "$SNAP" -type l -print -quit)" ]]
[[ -z "$(find -P "$SNAP" -type d ! -perm 0750 -print -quit)" ]]
[[ -z "$(find -P "$SNAP" -type f ! -perm 0640 -print -quit)" ]]
pass T5

# Real lock on BASE, no timing-based concurrency assumption.
exec 8< "$BASE"
flock -n 8
reject 'another backup is running' run '2026-01-06T00-00-00-000Z'
[[ ! -e "$BASE/uploads-snap-2026-01-06T00-00-00-000Z" ]]
flock -u 8
exec 8<&-
run '2026-01-06T00-00-00-000Z' > "$WORK/t6-unlocked.log" 2>&1
pass T6

saved="$BASE"
ln -s "$BASE" "$WORK/base-link"
BASE="$WORK/base-link"; reject 'unsafe/missing directory' run '2026-01-07T00-00-00-000Z'
mkdir "$WORK/unsafe"; chmod 777 "$WORK/unsafe"
mkdir "$WORK/unsafe/base"
BASE="$WORK/unsafe/base"; reject 'writable by other users' run '2026-01-07T00-00-00-000Z'
BASE="$saved"
pass T7

ln -s "$WORK/missing-target" "$BASE/uploads-snap-2026-01-08T00-00-00-000Z"
reject 'snapshot already exists' run '2026-01-08T00-00-00-000Z'
[[ -L "$BASE/uploads-snap-2026-01-08T00-00-00-000Z" ]]
pass T8

for ts in '../outside' '2026-13-01T00-00-00-000Z' '' $'2026-01-09T00-00-00-000Z\n'; do reject 'invalid timestamp' run "$ts"; done
pass T9

saved="$SRC"; SRC="$WORK/missing-source"
reject 'SRC must be a real directory' run '2026-01-10T00-00-00-000Z'
SRC="$saved"
[[ -z "$(find "$BASE" -maxdepth 1 -type d -name '.uploads-backup.*' -print -quit)" ]]
pass T10

# T11: explicit two-digit days, all valid in January; each run checked.
printf 'dummy DB, never real data' > "$BASE/karimoff-test.db"
mkdir "$BASE/uploads-snap-not-a-date"
for n in $(seq 11 30); do
  printf -v ts '2026-01-%02dT00-00-00-000Z' "$n"
  if run "$ts" --rotate > "$WORK/t11-$n.log" 2>&1; then :; else
    rc=$?; echo "FAIL T11 run $n: rc=$rc" >&2; exit 1
  fi
done
count=0
for d in "$BASE"/uploads-snap-2026-*; do
  if [[ ! -L "$d" && -d "$d" ]]; then count=$((count+1)); fi
done
[[ "$count" == 14 && -f "$BASE/karimoff-test.db" && -d "$BASE/uploads-snap-not-a-date" ]]
for n in $(seq 11 30); do
  printf -v ts '2026-01-%02dT00-00-00-000Z' "$n"
  if (( n < 17 )); then
    [[ ! -e "$BASE/uploads-snap-$ts" && ! -L "$BASE/uploads-snap-$ts" ]]
  else
    [[ ! -L "$BASE/uploads-snap-$ts" && -d "$BASE/uploads-snap-$ts" ]]
    cmp "$SRC/file" "$BASE/uploads-snap-$ts/file"
  fi
done
[[ -L "$BASE/uploads-snap-2026-01-08T00-00-00-000Z" ]]
[[ -f "$BASE/uploads-snap-foreign.tmp/sentinel" && -L "$BASE/.uploads-backup.foreign" ]]
pass T11

# T12: an exclusive PATH really omits each dependency in turn. Invoke bash
# by absolute path; never append the host PATH or substitute a failing mock.
deps=(rsync flock realpath stat mktemp find chmod mv rm sort date mkdir)
for missing in "${deps[@]}"; do
  bin="$WORK/bin-$missing"; mkdir "$bin"
  for cmd in "${deps[@]}"; do
    [[ "$cmd" == "$missing" ]] || ln -s "$(command -v "$cmd")" "$bin/$cmd"
  done
  if env -i PATH="$bin" HOME="$WORK" LC_ALL=C UPLOADS_SRC="$SRC" UPLOADS_BACKUP_DIR="$BASE" UPLOADS_TS='2026-02-01T00-00-00-000Z' \
      "$BASH_BIN" "$SCRIPT" > "$WORK/t12-$missing.log" 2>&1; then
    echo "FAIL T12: $missing unexpectedly available" >&2; exit 1
  else
    rc=$?
  fi
  [[ "$rc" -eq 1 ]]
  grep -q "missing dependency: $missing" "$WORK/t12-$missing.log"
done
[[ ! -e "$BASE/uploads-snap-2026-02-01T00-00-00-000Z" ]]
pass T12
# T14: preservation is the default AND explicitly pinned production mode.
# Both must retain more than KEEP old snapshots and all dummy SQLite files.
BASE="$WORK/preserve"; mkdir "$BASE"
for n in $(seq 1 16); do
  printf -v ts '2025-01-%02dT00-00-00-000Z' "$n"
  mkdir "$BASE/uploads-snap-$ts"
  printf 'old snapshot %s\n' "$n" > "$BASE/uploads-snap-$ts/sentinel"
  printf 'dummy SQLite %s\n' "$n" > "$BASE/karimoff-$ts.db"
done
run '2026-03-01T00-00-00-000Z' > "$WORK/t14-default.log" 2>&1
run '2026-03-02T00-00-00-000Z' --no-rotation > "$WORK/t14-explicit.log" 2>&1
for n in $(seq 1 16); do
  printf -v ts '2025-01-%02dT00-00-00-000Z' "$n"
  [[ "$(cat "$BASE/uploads-snap-$ts/sentinel")" == "old snapshot $n" ]]
  [[ "$(cat "$BASE/karimoff-$ts.db")" == "dummy SQLite $n" ]]
done
for day in 01 02; do cmp "$SRC/file" "$BASE/uploads-snap-2026-03-${day}T00-00-00-000Z/file"; done
[[ "$(find "$BASE" -maxdepth 1 -type d -name 'uploads-snap-*' | wc -l)" -eq 18 ]]
grep -Fq 'uploads rotation disabled' "$WORK/t14-default.log"
grep -Fq 'uploads rotation disabled' "$WORK/t14-explicit.log"
reject 'usage:' run '2026-03-03T00-00-00-000Z' --typo
reject 'usage:' run '2026-03-03T00-00-00-000Z' --no-rotation --rotate
[[ ! -e "$BASE/uploads-snap-2026-03-03T00-00-00-000Z" ]]
pass T14
echo "All Linux tests executed successfully. Evidence: $WORK"
