#!/usr/bin/env python3
"""Execute inside a fresh network namespace, with only its loopback enabled."""
import hashlib
import json
import os
import pathlib
import secrets
import subprocess
import sys
import time
import urllib.request

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
assert str(root).startswith('/tmp/karimoff-dr.')
assert not (root / 'app/.env').exists()
env = dict(PATH='/usr/bin:/bin', HOME=str(root), TMPDIR=str(root),
           HOST='127.0.0.1', PORT='18373', NODE_ENV='test',
           ADMIN_PASSWORD=secrets.token_hex(32), SMTP_HOST='127.0.0.1',
           SMTP_PORT='1', SMTP_USER='isolated', SMTP_PASS='isolated')
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
report = json.loads((root / 'audit.json').read_text())
with (root / 'app.log').open('wb') as log:
    proc = subprocess.Popen(['/usr/bin/node', 'server.js'], cwd=root / 'app', env=env, stdout=log, stderr=log, umask=0o077)
    try:
        for attempt in range(60):
            assert proc.poll() is None, 'Test application exited; see app.log'
            try:
                with opener.open('http://127.0.0.1:18373/', timeout=2) as response:
                    assert response.status == 200
                break
            except OSError:
                time.sleep(.5)
        else:
            raise AssertionError('Readiness timeout')
        for route in ['/', '/catalog', '/services', '/news', '/projects', '/contacts']:
            with opener.open('http://127.0.0.1:18373' + route, timeout=10) as response:
                assert response.status == 200 and b'<html' in response.read().lower(), route
            print('HTTP 200', route)
        from urllib.parse import quote
        for name, digest in report['files'].items():
            with opener.open('http://127.0.0.1:18373/uploads/' + quote(name), timeout=10) as response:
                assert response.status == 200
                assert hashlib.sha256(response.read()).hexdigest() == digest, 'Served file mismatch'
        assert proc.poll() is None
        print('SMOKE OK; all restored files served with matching SHA256')
    finally:
        proc.terminate()
        try:
            code = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            code = proc.wait()
        print('test_application_shutdown_code=%s (SIGTERM expected: -15)' % code)
