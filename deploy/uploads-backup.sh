#!/usr/bin/env bash
# Linux/GNU tools. Publishes a directory atomically, not a point-in-time
# filesystem snapshot. DB and uploads copied sequentially are NOT a transaction.
# Trust boundary: root and this UID must be trusted; no hostile same-UID writers
# or privileged mount/ACL changes. flock coordinates cooperating backup runs only.
set -euo pipefail
umask 077
fail() { echo "uploads-backup: $*" >&2; exit 1; }
# Fail closed: retention is off by default and cannot be enabled by environment.
# Production drop-in pins --no-rotation. --rotate requires a separate approval
# and an explicit command-line change; it is used only by retention tests now.
ROTATE=0
case "$#:$*" in
  0:|1:--no-rotation) ;;
  1:--rotate) ROTATE=1 ;;
  *) fail 'usage: uploads-backup.sh [--no-rotation|--rotate]' ;;
esac
for cmd in rsync flock realpath stat mktemp find chmod mv rm sort date mkdir; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing dependency: $cmd"
done
SRC="${UPLOADS_SRC:-/opt/karimoff/uploads}"
BASE="${UPLOADS_BACKUP_DIR:-/var/backups/karimoff}"
KEEP=14
TS_RE='^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3])-[0-5][0-9]-[0-5][0-9]-[0-9]{3}Z$'
TS="${UPLOADS_TS-$(date -u '+%Y-%m-%dT%H-%M-%S-%3NZ')}"
[[ "$TS" =~ $TS_RE ]] || fail 'invalid timestamp'

# Require an already provisioned absolute BASE. Reject symlinks in every
# component instead of silently accepting them via realpath. Ancestors must
# be owned by root/this UID and not writable by group/others. Root-owned sticky
# ancestors (e.g. /tmp) are allowed only above BASE, for isolated tests.
[[ "$BASE" == /* && "$BASE" != / ]] || fail 'BASE must be absolute and not /'
[[ "$(realpath -ms -- "$BASE")" == "$BASE" ]] || fail 'BASE must be normalized'
p="$BASE"
while :; do
  [[ ! -L "$p" && -d "$p" ]] || fail "unsafe/missing directory: $p"
  read -r owner mode <<< "$(stat -c '%u %a' -- "$p")"
  [[ "$owner" == 0 || "$owner" == "$EUID" ]] || fail "untrusted owner: $p"
  if (( (8#$mode & 0022) != 0 )); then
    [[ "$p" != "$BASE" && "$owner" == 0 ]] && (( (8#$mode & 01000) != 0 )) \
      || fail "writable by other users: $p"
  fi
  [[ "$p" == / ]] && break
  p="${p%/*}"; p="${p:-/}"
done
[[ ! -L "$SRC" && -d "$SRC" ]] || fail 'SRC must be a real directory'
SRC="$(realpath -e -- "$SRC")"
[[ "$SRC" != / && "$BASE/" != "$SRC/"* && "$SRC/" != "$BASE/"* ]] \
  || fail 'SRC and BASE must be disjoint'
base_id="$(stat -c '%d:%i' -- "$BASE")"
cd -P -- "$BASE"
[[ "$(stat -c '%d:%i' .)" == "$base_id" ]] || fail 'BASE changed'
# Pin the working directory; all destination operations below are relative.
# Lock the directory itself: no lock-file symlink or truncation hazard.
exec 9< .
flock -n 9 || fail 'another backup is running'

TMP=''; tmp_id=''
cleanup() {
  local rc=$?
  trap - EXIT
  if [[ -n "$TMP" ]]; then
    if [[ ! -L "$TMP" && -d "$TMP" && "$(stat -c '%d:%i' -- "$TMP")" == "$tmp_id" ]]; then
      rm -rf --one-file-system -- "$TMP" || rc=1
    else
      echo 'uploads-backup: temporary object changed; left untouched' >&2
      rc=1
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
SNAP="uploads-snap-$TS"
[[ ! -e "$SNAP" && ! -L "$SNAP" ]] || fail 'snapshot already exists'
# Never sweep stale files/directories. Only this invocation owns TMP.
TMP="$(mktemp -d './.uploads-backup.XXXXXXXXXX')"
tmp_id="$(stat -c '%d:%i' -- "$TMP")"
mkdir -- "$TMP/data"
# App creates regular files; exclude ALL symlinks, devices and special files.
# Do not use -L/--copy-links. Source changes may still produce a mixed-time copy.
rsync -rt --no-links --no-devices --no-specials -- "$SRC/" "$TMP/data/"
find -P "$TMP/data" -type d -exec chmod 750 {} +
find -P "$TMP/data" -type f -exec chmod 640 {} +
[[ ! -e "$SNAP" && ! -L "$SNAP" ]] || fail 'snapshot appeared during copy'
# GNU mv -T prevents nesting; -n prevents replacement, including dangling links.
mv -Tn -- "$TMP/data" "$SNAP"
[[ ! -e "$TMP/data" ]] || fail 'publication refused (collision)'

# Do not even enumerate old snapshots in preservation mode. EXIT only removes
# this invocation's private TMP, whose data directory has already been moved.
if (( ROTATE == 0 )); then
  echo "uploads-backup: published $BASE/$SNAP (uploads rotation disabled)"
  exit 0
fi

# Only completed, strictly named, real directories participate in retention.
# Existing unknown .tmp and service files are never swept.
find -P . -mindepth 1 -maxdepth 1 -type d -name 'uploads-snap-*' -print0 > "$TMP/list"
LC_ALL=C sort -z -o "$TMP/list" "$TMP/list"
snaps=()
while IFS= read -r -d '' d; do
  name="${d#./uploads-snap-}"
  if [[ "$name" =~ $TS_RE ]]; then snaps+=("$d"); fi
done < "$TMP/list"
for ((i=0; i<${#snaps[@]}-KEEP; i++)); do
  [[ ! -L "${snaps[i]}" && -d "${snaps[i]}" ]] || fail 'rotation candidate changed'
  rm -rf --one-file-system -- "${snaps[i]}"
done
echo "uploads-backup: published $BASE/$SNAP"
