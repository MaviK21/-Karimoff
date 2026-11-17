import importlib.util
import pathlib
import sqlite3
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dr_audit', HERE/'dr-audit.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class BackupRegression(unittest.TestCase):
    def fixture(self, root, value):
        app = root/'app'; app.mkdir(); (app/'uploads').mkdir()
        (app/'uploads/a.jpg').write_bytes(b'synthetic image')
        db = sqlite3.connect(app/'karimoff.db')
        db.executescript('CREATE TABLE products(id INTEGER, image TEXT); CREATE TABLE categories(id INTEGER); CREATE TABLE orders(id INTEGER); CREATE TABLE order_items(id INTEGER); CREATE TABLE site_settings(value TEXT);')
        db.execute('INSERT INTO products VALUES(1, ?)', (value,))
        db.execute('INSERT INTO site_settings VALUES(?)', ('<img src="/uploads/a.jpg">',))
        db.commit(); db.close()

    def test_valid_references(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp); self.fixture(root,'/uploads/a.jpg')
            report=module.audit(root)
            self.assertEqual(report['references'], ['/uploads/a.jpg'])
            self.assertEqual(report['missing'], [])
            self.assertEqual(len(report['files']),1)

    def test_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp); self.fixture(root,'/uploads/missing.jpg')
            with self.assertRaisesRegex(AssertionError,'Missing DB-to-file'):
                module.audit(root)

    def test_invalid_paths(self):
        for value in ['/uploads/../secret', '/uploads/%2e%2e/secret', '/uploads/%2Fetc/passwd', '/uploads/a%5Cb.jpg', '../secret']:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as tmp:
                root=pathlib.Path(tmp); self.fixture(root,value)
                with self.assertRaises(AssertionError): module.audit(root)

    def test_effective_unit(self):
        # Static resolution of the concrete Service directives; no systemd execution.
        posts=[]; settings={}
        files=[HERE/'systemd/karimoff-backup.service', *sorted((HERE/'systemd/karimoff-backup.service.d').glob('*.conf'))]
        for file in files:
            section=''
            for raw in file.read_text(encoding='utf-8').splitlines():
                line=raw.strip()
                if line.startswith('['): section=line
                if section!='[Service]' or not line or line.startswith('#') or '=' not in line: continue
                key,value=line.split('=',1)
                if key=='ExecStartPost':
                    if not value: posts.clear()
                    else: posts.append(value)
                else: settings[key]=value
        self.assertEqual(len(posts),2)
        self.assertIn('tail -n +15', posts[0])
        self.assertEqual(posts[1],'/bin/bash /opt/karimoff/deploy/uploads-backup.sh --no-rotation')
        self.assertEqual(sum('uploads-backup.sh' in p for p in posts),1)
        self.assertEqual(settings['UMask'],'0077')
        self.assertIn('db.backup(',settings['ExecStart'])

if __name__=='__main__': unittest.main(verbosity=2)
