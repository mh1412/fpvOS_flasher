import argparse
import importlib.util
import io
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch, MagicMock
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


p1 = module('prepare_p1', ROOT / 'tools/prepare-p1.py')
packager = module('package_p1', ROOT / 'tools/package-p1-bootstrap.py')
VERSION = {'product_version': 'P1_SKY', 'software_version': '1.0.44.rel', 'hardware_version': 'v1.0'}


class P1Preparation(unittest.TestCase):
    def test_stock_identity_requires_complete_exact_supported_release(self):
        def raw(version=VERSION, kernel=b'4.9.38', model=b'Artosyn, Proxima Development Board'):
            return kernel + b'\0' + model + b'\0' + json.dumps(version).encode()
        self.assertEqual(p1.stock_identity(raw())[0], VERSION)
        for data in [b'', raw(kernel=b'6.18.36'), raw(model=b'Ascent VRX'),
                     raw({**VERSION, 'product_version': 'Gnd485'}),
                     raw({**VERSION, 'software_version': '1.0.45.rel'}),
                     raw({**VERSION, 'hardware_version': 'v2.0'}), raw({})]:
            with self.assertRaises(ValueError):
                p1.stock_identity(data)

    def test_pinned_assets_and_download(self):
        base = ROOT / 'assets/p1-updater/v1'
        manifest, files = p1.load_assets(base)
        self.assertEqual(manifest['board_id'], 1345409867)
        self.assertTrue(files['fpvos-update-p1-air'].startswith(b'\x7fELF\x02\x01'))
        with zipfile.ZipFile(io.BytesIO(packager.package())) as archive:
            prefix = 'p1-stock-preparation-v1/'
            self.assertEqual(archive.read(prefix + 'prepare-p1.py'), (ROOT / 'tools/prepare-p1.py').read_bytes())
            for name, data in files.items():
                self.assertEqual(archive.read(prefix + name), data)
        for name in ['manifest.json', *p1.FILES]:
            with tempfile.TemporaryDirectory() as work:
                directory = Path(work) / 'assets'
                shutil.copytree(base, directory)
                path = directory / name
                data = bytearray(path.read_bytes()); data[0] ^= 1; path.write_bytes(data)
                with self.assertRaisesRegex(ValueError, 'mismatch'):
                    p1.load_assets(directory)

    def test_interface_selection_rejects_ambiguous_or_unrelated_devices(self):
        self.assertEqual(p1.select_interface(None, {'usb0': 'P1'}), 'usb0')
        self.assertEqual(p1.select_interface('usb1', {'usb0': 'A', 'usb1': 'B'}), 'usb1')
        for interface, candidates in [(None, {}), (None, {'usb0': 'A', 'usb1': 'B'}), ('eth0', {'usb0': 'A'})]:
            with self.assertRaises(ValueError):
                p1.select_interface(interface, candidates)

    def test_proxy_binds_usb_interface_before_connect_and_has_no_fallback(self):
        peer = MagicMock(); peer.recv.return_value = b''
        with patch.object(p1, 'usb_interfaces', return_value={'usb0': 'P1'}), \
                patch.object(p1, 'require_address'), patch.object(p1.socket, 'socket') as create, \
                patch.object(p1.select, 'select', return_value=([peer], [], [])):
            create.return_value.__enter__.return_value = peer
            p1.proxy('usb0', '192.168.3.100', 22)
            peer.setsockopt.assert_called_once_with(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, b'usb0\0')
            peer.connect.assert_called_once_with(('192.168.3.100', 22))
            names = [call[0] for call in peer.method_calls]
            self.assertLess(names.index('setsockopt'), names.index('connect'))
            peer.reset_mock()
            peer.setsockopt.side_effect = PermissionError('cannot bind')
            with self.assertRaises(PermissionError):
                p1.proxy('usb0', '192.168.3.100', 22)
            peer.connect.assert_not_called()

    def test_ssh_keeps_host_key_verification_and_disables_forwarding(self):
        args = argparse.Namespace(host='192.168.3.100', port=22, known_hosts=None)
        command = p1.ssh_args(args, 'usb0')
        self.assertIn('StrictHostKeyChecking=ask', command)
        self.assertIn('ForwardAgent=no', command)
        self.assertTrue(any(arg.startswith('ProxyCommand=') and '--proxy usb0 192.168.3.100 22' in arg for arg in command))


class StagingTransaction(unittest.TestCase):
    """Execute the staging shell against a private fake stock filesystem."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / 'usrdata'; self.data.mkdir()
        self.version = self.root / 'sdk_version.json'; self.version.write_text(json.dumps(VERSION))
        self.model = self.root / 'model'; self.model.write_text('Artosyn, Proxima Development Board')
        self.reboot = self.root / 'reboot'
        self.files = {'fpvos-update-p1-air': b'test installer', 'bootstrap.sh': b'test launcher'}
        self.user_file = self.data / 'settings.json'; self.user_file.write_text('keep these settings')

    def run_script(self, files=None, hooks='', version_hash=None, truncate=False):
        script = p1.preparation_script(self.files, version_hash or p1.digest(self.version.read_bytes()))
        script = script.replace('/usr/usrdata/sdk_version.json', str(self.version))
        script = script.replace('/proc/device-tree/model', str(self.model)).replace('/usrdata', str(self.data))
        # Shell functions affect only this subprocess. No privileged host
        # operations or paths outside this TemporaryDirectory are exercised.
        prelude = f'''id() {{ echo 0; }}
uname() {{ echo 4.9.38; }}
sync() {{ :; }}
reboot() {{ echo requested >{self.reboot}; }}
'''
        data = p1.transfer_archive(files or self.files)
        result = subprocess.run(['sh', '-c', prelude + hooks + script],
                                input=data[:515] if truncate else data, capture_output=True)
        self.assertEqual(self.user_file.read_text(), 'keep these settings')
        return result

    def test_success_arms_only_verified_files_and_removes_temporary_state(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b'FPVOS_P1_BOOTSTRAP_ARMED', result.stdout)
        self.assertEqual((self.data / 'fpvos-update').read_bytes(), self.files['fpvos-update-p1-air'])
        self.assertEqual((self.data / 'fpvos-bootstrap.sh').read_bytes(), self.files['bootstrap.sh'])
        self.assertEqual((self.data / 'sirius-clean-system-flag').read_text(), 'web:/usrdata/fpvos-bootstrap.sh\n'.replace('/usrdata', str(self.data)))
        self.assertTrue(self.reboot.exists())
        self.assertFalse(list(self.data.glob('.fpvos*')))

    def test_existing_files_directories_and_dangling_links_are_never_overwritten(self):
        for name in ['fpvos-update', 'fpvos-bootstrap.sh', 'sirius-clean-system-flag', '.fpvos-p1-bootstrap.lock']:
            for kind in ['file', 'directory', 'symlink']:
                with self.subTest(name=name, kind=kind):
                    path = self.data / name
                    if kind == 'file': path.write_bytes(b'existing')
                    elif kind == 'directory': path.mkdir()
                    else: path.symlink_to(self.root / 'missing')
                    result = self.run_script()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(b'Refusing to overwrite', result.stderr)
                    self.assertFalse(self.reboot.exists())
                    if kind == 'directory': path.rmdir()
                    else:
                        if kind == 'file': self.assertEqual(path.read_bytes(), b'existing')
                        else: self.assertTrue(path.is_symlink())
                        path.unlink()

    def test_bad_transfer_removes_staging_without_arming_reboot(self):
        result = self.run_script({**self.files, 'fpvos-update-p1-air': b'damaged'})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sorted(p.name for p in self.data.iterdir()), ['settings.json'])
        self.assertFalse(self.reboot.exists())

    def test_changed_stock_identity_never_stages(self):
        result = self.run_script(version_hash='0' * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.data.iterdir()), [self.user_file])

    def test_interrupted_archive_never_arms_and_releases_our_lock(self):
        result = self.run_script(truncate=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.data.iterdir()), [self.user_file])
        self.assertFalse(self.reboot.exists())

    def test_failed_second_link_cleans_up_only_our_first_link(self):
        hooks = '''ln() {
    case "$2" in bootstrap.sh) return 1;; esac
    command ln "$@"
}
'''
        result = self.run_script(hooks=hooks)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.data.iterdir()), [self.user_file])
        self.assertFalse(self.reboot.exists())

    def test_reboot_failure_preserves_armed_flag_and_verified_installer(self):
        result = self.run_script(hooks='reboot() { return 1; }\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'FPVOS_P1_BOOTSTRAP_ARMED', result.stdout)
        self.assertTrue((self.data / 'sirius-clean-system-flag').exists())
        self.assertEqual((self.data / 'fpvos-update').read_bytes(), self.files['fpvos-update-p1-air'])
        self.assertEqual((self.data / 'fpvos-bootstrap.sh').read_bytes(), self.files['bootstrap.sh'])


if __name__ == '__main__':
    unittest.main()
