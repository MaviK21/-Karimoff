#!/usr/bin/env python3
"""Reviewed root coordinator. All writes are confined to its new /tmp directory."""
import hashlib
import json
import os
import pathlib
import shutil
import signal
import stat
import subprocess
import sys
import sysconfig
import tempfile
import time

def native_target(info):
    if info.get('platform') != 'linux' or info.get('arch') not in ('x64', 'arm64'):
        raise RuntimeError('Unsupported recovery platform: %r' % info)
    if 'glibc' not in info:
        raise RuntimeError('Missing libc probe result')
    if info['glibc'] is not None and not isinstance(info['glibc'], str):
        raise RuntimeError('Invalid libc probe result')
    return ('linux' if info['glibc'] else 'linuxmusl') + '-' + info['arch'] + '.node'

def selected_objects(objects, app, info):
    directory = app / 'node_modules/better-sqlite3/prebuilds'
    selected = directory / native_target(info)
    if not selected.is_file() or selected.is_symlink():
        raise RuntimeError('Required native binary missing: %s' % selected)
    known = {osname + '-' + arch + '.node'
             for osname in ('linux', 'linuxmusl', 'darwin', 'win32')
             for arch in ('x64', 'arm64')}
    included, skipped = [], []
    for obj in objects:
        if obj.parent == directory and obj != selected:
            if obj.name not in known:
                raise RuntimeError('Unknown better-sqlite3 prebuild: %s' % obj)
            skipped.append({'object': str(obj), 'reason': 'incompatible with ' + selected.name})
        else:
            included.append(obj)
    if selected not in included:
        raise RuntimeError('Required binary absent from dependency inventory')
    with selected.open('rb') as binary:
        if binary.read(4) != b'\x7fELF':
            raise RuntimeError('Selected Linux binary is not ELF')
    return included, skipped

def dependency_diagnostic(obj, command, result):
    missing = [line.strip().split('=>', 1)[0].strip()
               for line in result.stdout.splitlines() if '=> not found' in line]
    return {'command': command, 'object': str(obj), 'exit_code': result.returncode,
            'missing_sonames': missing, 'stdout': result.stdout, 'stderr': result.stderr}

def require_dependencies(diagnostic):
    if diagnostic['exit_code'] or diagnostic['missing_sonames']:
        raise RuntimeError('Runtime dependency check failed: %s; see runtime-dependencies.jsonl'
                           % json.dumps(diagnostic))

assert os.geteuid() == 0
def interrupted(signum, frame):
    raise InterruptedError('Coordinator interrupted')
for sig in (signal.SIGTERM, signal.SIGHUP):
    signal.signal(sig, interrupted)
os.umask(0o077)
os.chdir('/')
os.environ.clear()
os.environ.update(PATH='/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL='C')
tools = pathlib.Path(__file__).resolve().parent
assert tools.stat().st_uid == 0 and stat.S_IMODE(tools.stat().st_mode) == 0o700
for name in ['dr-privileged.py', 'dr-isolation-check.py', 'dr-audit.py', 'dr-smoke.py']:
    p = tools / name
    assert not p.is_symlink() and p.stat().st_uid == 0 and not (p.stat().st_mode & 0o022)
base = pathlib.Path(tempfile.mkdtemp(prefix='karimoff-dr-root.', dir='/tmp'))
print('EVIDENCE_DIRECTORY=' + str(base), flush=True)
root = base / 'rootfs'
work = base / 'work'
root.mkdir(mode=0o755)
work.mkdir(mode=0o700)
(base / 'identity.json').write_text(json.dumps({'device': base.stat().st_dev, 'inode': base.stat().st_ino}))
proc = None
phase = 'preflight'
start = time.monotonic()
result = {'status': 'FAIL'}

def run(args):
    return subprocess.check_output(args, text=True).strip()

def digest(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()

def regular_tree(p):
    for item in [p, *p.rglob('*')]:
        assert not item.is_symlink() and (item.is_file() or item.is_dir()), 'Unsafe source object'

def state(unit, keys):
    return run(['systemctl', 'show', unit, *['--property=' + key for key in keys]])

try:
    assert run(['systemctl', 'show', 'karimoff-backup.service', '-p', 'ExecMainStartTimestamp', '--value']) == 'Tue 2026-11-17 03:36:02 MSK', 'Backup selection is stale; review latest pair'
    assert run(['systemctl', 'show', 'karimoff-backup.service', '-p', 'Result', '--value']) == 'success'
    assert run(['systemctl', 'show', 'karimoff-backup.service', '-p', 'ActiveState', '--value']) == 'inactive'
    assert not run(['systemctl', 'show', 'karimoff-backup.service', '-p', 'Job', '--value'])
    before_site = state('karimoff.service', ['MainPID', 'ActiveState'])
    before_timer = state('karimoff-backup.timer', ['ActiveState', 'UnitFileState', 'NextElapseUSecRealtime'])
    (base / 'site-before.txt').write_text(before_site)
    (base / 'timer-before.txt').write_text(before_timer)
    src = pathlib.Path('/opt/karimoff')
    code_hashes = {
        'server.js': '891a34f95b94be4bcbbbf0f71a17d903fc497653b1c97fc8f7a1ab26a7f349b6',
        'lib/db.js': '4d72c041c2f3bf881a525b578fe8e798900240822ebf208873c59d344a98e351',
        'package.json': '0a42ee3452c532f54def7a7901ba87a04ab34c04c52c3bc5ad974f1dfe3dd61c',
        'package-lock.json': '9ebdc683b7b1498b47680e867f673d3cb56706559cfca60d367d644e0e94aa64'}
    assert all(digest(src / name) == h for name, h in code_hashes.items())
    app = work / 'app'
    app.mkdir()
    for name in ['server.js', 'package.json', 'package-lock.json', 'lib', 'public', 'node_modules']:
        p = src / name
        for item in [p, *(p.rglob('*') if p.is_dir() else [])]:
            if item.is_symlink():
                assert name == 'node_modules' and item.resolve(strict=True).is_relative_to(src / 'node_modules')
            assert item.is_file() or item.is_dir()
        if p.is_dir():
            shutil.copytree(p, app / name, symlinks=False)
        else:
            shutil.copy2(p, app / name)
    assert all(digest(app / name) == h for name, h in code_hashes.items())
    regular_tree(app)
    assert not list(app.rglob('.env'))
    # Minimal runtime copies; never bind /usr, /etc, /home or production into chroot.
    def runtime_file(source):
        source = pathlib.Path(source)
        target = root / str(source).lstrip('/')
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o755 if os.access(source, os.X_OK) else 0o644)
    executables = ['/usr/bin/python3', '/usr/bin/node', '/usr/bin/setpriv']
    for p in executables:
        runtime_file(p)
    stdlib = pathlib.Path(sysconfig.get_path('stdlib'))
    assert str(stdlib).startswith('/usr/lib/python3.')
    shutil.copytree(stdlib, root / str(stdlib).lstrip('/'), ignore=shutil.ignore_patterns('site-packages', 'dist-packages', '__pycache__'), symlinks=False)
    # ldd only on installed runtime/dependency ELF files, never backup data.
    objects = [pathlib.Path(p) for p in executables] + list(stdlib.rglob('*.so')) + list(app.rglob('*.node')) + list(app.rglob('*.so*'))
    probe = "const h=process.report.getReport().header; console.log(JSON.stringify({platform:process.platform,arch:process.arch,glibc:h.glibcVersionRuntime||null}))"
    platform_info = json.loads(run(['/usr/bin/node', '-e', probe]))
    objects, exclusions = selected_objects(objects, app, platform_info)
    (base / 'runtime-platform.json').write_text(json.dumps({'platform': platform_info, 'selected': native_target(platform_info), 'excluded': exclusions}, indent=2))
    for obj in objects:
        if not obj.is_file() or obj.open('rb').read(4) != b'\x7fELF':
            continue
        command = ['/usr/bin/ldd', str(obj)]
        dependency_result = subprocess.run(command, text=True, capture_output=True)
        output = dependency_result.stdout
        diagnostic = dependency_diagnostic(obj, command, dependency_result)
        with (base / 'runtime-dependencies.jsonl').open('a') as evidence:
            evidence.write(json.dumps(diagnostic) + '\n')
        require_dependencies(diagnostic)
        for line in output.splitlines():
            fields = line.strip().split()
            path = fields[2] if len(fields) > 2 and fields[1] == '=>' else fields[0]
            if path.startswith('/'):
                if pathlib.Path(path).is_relative_to(work):
                    continue
                assert path.startswith(('/lib/', '/lib64/', '/usr/lib/')), 'Unexpected runtime library'
                runtime_file(path)
    for directory in ['proc', 'dev', 'control', 'tmp/karimoff-dr.restore']:
        (root / directory).mkdir(parents=True, exist_ok=True)
    for name, minor in [('null', 3), ('urandom', 9)]:
        os.mknod(root / 'dev' / name, stat.S_IFCHR | 0o666, os.makedev(1, minor))
        (root / 'dev' / name).chmod(0o666)
    for name in ['dr-isolation-check.py', 'dr-audit.py', 'dr-smoke.py']:
        shutil.copyfile(tools / name, root / 'control' / name)
    (root / 'control/outer.json').write_text(json.dumps({n: os.readlink('/proc/self/ns/' + n) for n in ['mnt', 'net', 'pid', 'ipc', 'uts']}))
    for p in [root, *root.rglob('*')]:
        if p.is_dir(): p.chmod(0o755)
        elif p.is_file(): p.chmod(0o755 if os.access(p, os.X_OK) else 0o644)
    for p in [work, *work.rglob('*')]:
        os.chown(p, 65534, 65534)
    mount_script = '''set -eu
mount --make-rprivate /
mount --bind "$1" "$1"
mount -o remount,bind,ro,nosuid "$1"
mount --bind "$2" "$1/tmp/karimoff-dr.restore"
mount -o remount,bind,rw,nosuid,nodev "$1/tmp/karimoff-dr.restore"
mount -t proc -o ro,nosuid,nodev,noexec,hidepid=2 proc "$1/proc"
ip link set lo up
cd /
exec chroot "$1" /usr/bin/setpriv --reuid=65534 --regid=65534 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs /usr/bin/python3 /control/dr-isolation-check.py
'''
    phase = 'isolation'
    with (base / 'namespace.log').open('wb') as log:
        proc = subprocess.Popen(['unshare', '--mount', '--net', '--pid', '--fork', '--kill-child=SIGKILL', '--ipc', '--uts', '/bin/bash', '-ceu', mount_script, 'bash', str(root), str(work)], stdout=log, stderr=log)
        deadline = time.monotonic() + 30
        while not (work / 'isolation-ok').exists():
            assert proc.poll() is None, 'Isolation failed; see namespace.log'
            assert time.monotonic() < deadline, 'Isolation timeout'
            time.sleep(.2)
        print('ISOLATION_VERIFIED_BEFORE_RESTORE', flush=True)
        phase = 'restore'
        restore_start = time.monotonic()
        db = pathlib.Path('/var/backups/karimoff/karimoff-2026-11-17T00-36-02-643Z.db')
        up = pathlib.Path('/var/backups/karimoff/uploads-snap-2026-11-17T00-36-02-786Z')
        expected_db = 'ea33589869d5d734e9e12cf4a4bd00d7f1e98d6de4595b6ee2b5a80a829ca961'
        assert db.is_file() and not db.is_symlink() and digest(db) == expected_db
        regular_tree(up)
        manifest = pathlib.Path('/tmp/karimoff-stage3-4a13bf893b5c429e86ea2baf2d3d575d/new-uploads.sha256').read_text()
        expected = {}
        for line in manifest.splitlines():
            h, path = line.split('  ', 1)
            relative = pathlib.Path(path).relative_to(up)
            assert '..' not in relative.parts
            expected[str(relative)] = h
        assert {str(p.relative_to(up)): digest(p) for p in up.rglob('*') if p.is_file()} == expected
        shutil.copyfile(db, app / 'karimoff.db')
        shutil.copytree(up, app / 'uploads')
        assert digest(app / 'karimoff.db') == expected_db
        for p in [app / 'karimoff.db', app / 'uploads', *(app / 'uploads').rglob('*')]:
            os.chown(p, 65534, 65534)
            p.chmod(0o750 if p.is_dir() else (0o600 if p.name == 'karimoff.db' else 0o640))
        (root / 'control/expected-files.json').write_text(json.dumps(expected))
        (root / 'control/expected-files.json').chmod(0o644)
        (root / 'control/restore-ready').touch(mode=0o644)
        phase = 'audit_smoke'
        code = proc.wait(timeout=180)
        result['namespace_exit'] = code
        assert code == 0, 'Audit/smoke failed; see namespace.log'
        result.update(json.loads((work / 'result.json').read_text()))
        result['restore_through_smoke_seconds'] = time.monotonic() - restore_start
        phase = 'postchecks'
        assert digest(db) == expected_db
        assert {str(p.relative_to(up)): digest(p) for p in up.rglob('*') if p.is_file()} == expected
        assert before_site == state('karimoff.service', ['MainPID', 'ActiveState'])
        assert before_timer == state('karimoff-backup.timer', ['ActiveState', 'UnitFileState', 'NextElapseUSecRealtime'])
        assert run(['curl', '--fail', '--silent', '--show-error', '--max-time', '20', '-o', '/dev/null', '-w', '%{http_code}', 'https://karimoff.pro/']) == '200'
        storage = {str(p): run(['du', '-s', '-B1', str(p)]) for p in sorted(up.parent.glob('uploads-snap-*'))}
        (base / 'storage.json').write_text(json.dumps(storage, indent=2))
        (base / 'disk.txt').write_text(run(['df', '-B1', '/tmp', '/var/backups']))
        phase = 'complete'
        result['status'] = 'PASS'
except BaseException as error:
    result['status'] = 'FAIL'
    result['error_type'] = type(error).__name__
    print('STOP phase=' + phase + ' error=' + type(error).__name__, flush=True)
    raise
finally:
    if proc is not None and proc.poll() is None:
        # Only the unreaped child owned by this coordinator; never pkill/service operations.
        proc.terminate()
        try: proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    result.update(phase=phase, total_seconds=time.monotonic() - start)
    (base / 'status.json').write_text(json.dumps(result, indent=2))
    print('Evidence retained; cleanup only after download: ' + str(base), flush=True)
