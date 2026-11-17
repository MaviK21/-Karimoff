#!/usr/bin/env python3
"""Runs inside the chroot as uid 65534, before any backup data is copied."""
import errno
import json
import os
import pathlib
import socket
import subprocess
import time

work = pathlib.Path('/tmp/karimoff-dr.restore')
assert os.getuid() == os.geteuid() == os.getgid() == os.getegid() == 65534
assert not os.getgroups()
status = dict(line.split(':', 1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
for key in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']:
    assert int(status[key].strip(), 16) == 0, key
assert status['NoNewPrivs'].strip() == '1'
outer = json.loads(pathlib.Path('/control/outer.json').read_text())
for ns in ['mnt', 'net', 'pid', 'ipc', 'uts']:
    assert os.readlink('/proc/self/ns/' + ns) != outer[ns], ns
assert os.getpid() == 1, 'Expected isolated PID 1'
assert [p.name for p in pathlib.Path('/proc').iterdir() if p.name.isdigit()] == ['1']
mounts = {line.split()[4]: set(line.split()[5].split(',')) for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines()}
assert 'ro' in mounts['/']
assert 'ro' in mounts['/proc']
assert {'rw', 'nosuid', 'nodev'} <= mounts[str(work)]
assert set(mounts) == {'/', '/proc', str(work)}, 'Unexpected filesystem mount'
for path in ['/opt', '/var/backups', '/home', '/root', '/run', '/sys', '/etc/shadow', '/etc/environment']:
    assert not pathlib.Path(path).exists(), 'Unexpected host path: ' + path
assert not (work / 'app/karimoff.db').exists()
assert not (work / 'app/uploads').exists()
assert not list((work / 'app').rglob('.env'))
assert not any(p.is_symlink() for p in (work / 'app').rglob('*'))
assert set(os.listdir('/dev')) == {'null', 'urandom'}
try:
    pathlib.Path('/control/write-probe').write_text('must fail')
except OSError as error:
    assert error.errno in (errno.EROFS, errno.EACCES)
else:
    raise AssertionError('Root filesystem writable')
interfaces = {line.split(':')[0].strip() for line in pathlib.Path('/proc/net/dev').read_text().splitlines()[2:]}
assert interfaces == {'lo'}
assert len(pathlib.Path('/proc/net/route').read_text().splitlines()) == 1
with socket.socket() as connection:
    connection.settimeout(1)
    try:
        connection.connect(('1.1.1.1', 443))
    except OSError as error:
        assert error.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH)
    else:
        raise AssertionError('External network reachable')
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 18373))
print('ISOLATION_OK uid=65534 caps=0 no_new_privs=1 private_mnt_net_pid_ipc_uts', flush=True)
(work / 'isolation-ok').write_text('OK\n')
# Root coordinator copies and verifies data only after this marker.
deadline = time.monotonic() + 180
while not pathlib.Path('/control/restore-ready').exists():
    assert time.monotonic() < deadline, 'Restore preparation timeout'
    time.sleep(.2)
start = time.monotonic()
subprocess.run(['/usr/bin/python3', '/control/dr-audit.py', str(work)], check=True)
audit = json.loads((work / 'audit.json').read_text())
expected = json.loads(pathlib.Path('/control/expected-files.json').read_text())
assert audit['files'] == expected, 'Restored file inventory/checksums mismatch'
subprocess.run(['/usr/bin/python3', '/control/dr-smoke.py', str(work)], check=True)
(work / 'result.json').write_text(json.dumps({'status': 'PASS', 'audit_smoke_seconds': time.monotonic() - start, 'tables': len(audit['tables']), 'records': sum(t['rows'] for t in audit['tables'].values()), 'files': len(audit['files']), 'references': len(audit['references'])}))
print('RECOVERY_PASS', flush=True)
