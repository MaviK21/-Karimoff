#!/usr/bin/env python3
"""Run only against a restored copy. Does not print customer records."""
import hashlib
import json
import pathlib
import re
import sqlite3
import sys
from urllib.parse import unquote

def audit(root):
    root = pathlib.Path(root).resolve(strict=True)
    dbpath = root / 'app/karimoff.db'
    db = sqlite3.connect(dbpath.as_uri() + '?mode=ro&immutable=1', uri=True)
    try:
        assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
        assert not db.execute('PRAGMA foreign_key_check').fetchall(), 'Foreign key violations'
        schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        assert {'products', 'categories', 'orders', 'order_items', 'site_settings'} <= set(tables)
        summary, refs, missing = {}, set(), []
        media = {'image', 'video', 'document'}
        for table in tables:
            quoted = '"' + table.replace('"', '""') + '"'
            cursor = db.execute('SELECT * FROM ' + quoted)
            columns = [x[0] for x in cursor.description]
            digests = []
            for row in cursor:
                serial = repr(row).encode()
                digests.append(hashlib.sha256(serial).hexdigest())
                for column, value in zip(columns, row):
                    if not isinstance(value, str):
                        continue
                    found = re.findall(r'/uploads/[^\s\"\'<>),;]+', value)
                    if column in media and value.strip() and not found and not value.startswith(('https://', 'http://')):
                        raise AssertionError('Unclassified media path: ' + table + '.' + column)
                    refs.update(found)
            summary[table] = {'rows': len(digests), 'records_sha256': hashlib.sha256(''.join(sorted(digests)).encode()).hexdigest()}
        files = {}
        uploads = root / 'app/uploads'
        for p in uploads.rglob('*'):
            assert not p.is_symlink(), 'Symlink in restored uploads'
            if p.is_file():
                files[p.relative_to(uploads).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
        for ref in sorted(refs):
            relative = unquote(ref.split('?', 1)[0].split('#', 1)[0])[len('/uploads/'):]
            assert relative and not relative.startswith('/') and '\\' not in relative, 'Invalid upload path'
            assert not any(part in ('.', '..', '') for part in relative.split('/')), 'Invalid upload path'
            p = (uploads / relative).resolve()
            assert p.is_relative_to(uploads.resolve()), 'Escaping upload reference'
            if not p.is_file():
                missing.append(ref)
        report = {'integrity': 'ok', 'schema': schema, 'tables': summary, 'files': files, 'references': sorted(refs), 'missing': missing}
        (root / 'audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        assert not missing, 'Missing DB-to-file references; see private audit.json'
        print('AUDIT OK; tables=%d files=%d references=%d' % (len(tables), len(files), len(refs)))

        return report
    finally:
        db.close()

if __name__ == '__main__':
    root = pathlib.Path(sys.argv[1]).resolve(strict=True)
    assert str(root).startswith('/tmp/karimoff-dr.')
    audit(root)
