"""Local unit tests: extract pure helpers without executing root coordinator."""
import ast
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

source = pathlib.Path(__file__).with_name('dr-privileged.py')
tree = ast.parse(source.read_text(encoding='utf-8'))
names = {'native_target', 'selected_objects', 'dependency_diagnostic', 'require_dependencies'}
scope = dict(os=os, json=json)
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names], type_ignores=[]), str(source), 'exec'), scope)

class RuntimeTests(unittest.TestCase):
    def test_platform_matrix(self):
        for arch in ['x64', 'arm64']:
            for libc, prefix in [('2.39', 'linux'), (None, 'linuxmusl')]:
                with self.subTest(arch=arch, libc=libc):
                    self.assertEqual(scope['native_target'](dict(platform='linux', arch=arch, glibc=libc)), prefix+'-'+arch+'.node')

    def test_invalid_platform(self):
        for info in [dict(platform='win32',arch='x64',glibc=None), dict(platform='linux',arch='s390x',glibc='2.39'), dict(platform='linux',arch='x64'), dict(platform='linux',arch='x64',glibc=123)]:
            with self.subTest(info=info), self.assertRaises(RuntimeError):
                scope['native_target'](info)

    def test_selection_and_missing_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = pathlib.Path(tmp)
            pre = app/'node_modules/better-sqlite3/prebuilds'
            pre.mkdir(parents=True)
            paths = []
            for name in ['linux-x64.node','linuxmusl-x64.node','linux-arm64.node','linuxmusl-arm64.node','win32-x64.node','darwin-arm64.node']:
                p=pre/name; p.write_bytes(b'\x7fELFfixture'); paths.append(p)
            sharp=app/'sharp.node'; sharp.write_bytes(b'\x7fELFfixture'); paths.append(sharp)
            info=dict(platform='linux',arch='x64',glibc='2.39')
            selected, skipped=scope['selected_objects'](paths,app,info)
            self.assertEqual(selected,[pre/'linux-x64.node',sharp])
            self.assertEqual(len(skipped),5)
            unknown=pre/'unknown.node'; unknown.write_bytes(b'\x7fELFfixture')
            with self.assertRaises(RuntimeError): scope['selected_objects'](paths+[unknown],app,info)
            (pre/'linux-x64.node').unlink()
            with self.assertRaises(RuntimeError): scope['selected_objects'](paths,app,info)

    def test_dependency_results(self):
        for code, output, should_fail in [(0,'libc.so.6 => /lib/libc.so.6 (0x1)',False),(0,'libc.musl-x86_64.so.1 => not found',True),(1,'',True)]:
            with self.subTest(code=code,output=output):
                result=subprocess.CompletedProcess(['ldd','chosen.node'],code,output,'diagnostic')
                diagnostic=scope['dependency_diagnostic']('chosen.node',result.args,result)
                self.assertEqual(diagnostic['stderr'],'diagnostic')
                self.assertEqual(diagnostic['command'],result.args)
                if should_fail:
                    with self.assertRaises(RuntimeError): scope['require_dependencies'](diagnostic)
                else: scope['require_dependencies'](diagnostic)
                if 'not found' in output:
                    self.assertEqual(diagnostic['missing_sonames'],['libc.musl-x86_64.so.1'])

if __name__ == '__main__': unittest.main(verbosity=2)
