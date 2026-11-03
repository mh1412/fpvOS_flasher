#!/usr/bin/env python3
"""Prepare stock P1 1.0.44 for the browser flasher; no firmware is installed here.

Linux, Python 3 and OpenSSH are required. SSH uses the selected USB interface
exclusively and retains normal host-key verification and authentication.
"""
import argparse
import hashlib
import io
import ipaddress
import json
import os
from pathlib import Path
import select
import shlex
import socket
import subprocess
import sys
import tarfile

MANIFEST_SHA256 = 'fe8104d183027c99679c76c81e22a16d94f301a53e0198102e979ddde38cf0e4'
FILES = ('fpvos-update-p1-air', 'bootstrap.sh')
IDENTITY_COMMAND = "printf '%s\\0' \"$(uname -r)\" \"$(cat /proc/device-tree/model)\"; cat /usr/usrdata/sdk_version.json"
STOCK_GUARD = r'''
PATH=/usr/usrbin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
[ "$(id -u)" = 0 ] || { echo 'Root SSH access is required.' >&2; exit 1; }
[ "$(uname -r)" = 4.9.38 ] || exit 1
[ "$(cat /proc/device-tree/model)" = 'Artosyn, Proxima Development Board' ] || exit 1
[ -d /usrdata ] && [ ! -L /usrdata ] || exit 1
for name in /usrdata/fpvos-update /usrdata/fpvos-bootstrap.sh /usrdata/sirius-clean-system-flag /usrdata/.fpvos-p1-bootstrap.lock; do
    if [ -e "$name" ] || [ -L "$name" ]; then
        echo "Refusing to overwrite existing preparation state: $name" >&2; exit 1
    fi
done
for command in tar sha256sum mktemp ln chmod sync reboot; do
    command -v "$command" >/dev/null || { echo "Missing stock tool: $command" >&2; exit 1; }
done
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load_assets(directory):
    raw = (directory / 'manifest.json').read_bytes()
    if digest(raw) != MANIFEST_SHA256:
        raise ValueError('Bundled P1 manifest SHA-256 mismatch.')
    manifest = json.loads(raw)
    if (manifest['board'] != 'p1-air' or manifest['board_id'] != 1345409867
            or manifest['supported_stock_firmware'] != ['1.0.44.rel']):
        raise ValueError('Unsupported P1 bootstrap manifest.')
    files = {}
    for name in FILES:
        data = (directory / name).read_bytes()
        expected = manifest['files'][name]
        if len(data) != expected['size'] or digest(data) != expected['sha256']:
            raise ValueError(f'Bundled {name} size/SHA-256 mismatch.')
        files[name] = data
    return manifest, files


def stock_identity(raw):
    fields = raw.split(b'\0', 2)
    if len(fields) != 3:
        raise ValueError('Incomplete stock identity response.')
    kernel, model, version_bytes = fields
    version = json.loads(version_bytes)
    if (kernel != b'4.9.38' or model != b'Artosyn, Proxima Development Board'
            or version.get('product_version') != 'P1_SKY'
            or version.get('software_version') != '1.0.44.rel'
            or version.get('hardware_version') != 'v1.0'):
        raise ValueError('Requires a stock P1_SKY v1.0 running 1.0.44.rel / Linux 4.9.38.')
    return version, digest(version_bytes)


def usb_interfaces(root=Path('/sys/class/net')):
    result = {}
    for entry in root.iterdir():
        try:
            usb = (entry / 'device').resolve().parent
            if ((usb / 'idVendor').read_text().strip(), (usb / 'idProduct').read_text().strip()) == ('1d6b', '0101'):
                result[entry.name] = (usb / 'serial').read_text().strip()
        except (OSError, ValueError):
            continue
    return result


def select_interface(requested, candidates):
    if requested:
        if requested not in candidates:
            raise ValueError('Selected interface is not a stock Artosyn USB device (1d6b:0101).')
        return requested
    if len(candidates) != 1:
        raise ValueError('Connect one stock P1, or select its USB network interface with --interface NAME.')
    return next(iter(candidates))


def require_address(interface, host):
    addresses = json.loads(subprocess.check_output(['ip', '-j', '-4', 'address', 'show', 'dev', interface]))
    target = ipaddress.IPv4Address(host)
    for link in addresses:
        for address in link.get('addr_info', []):
            network = ipaddress.IPv4Interface(f"{address['local']}/{address['prefixlen']}")
            if target in network.network and target != network.ip:
                return
    raise ValueError(f'Set {interface} to 192.168.3.200/24 with no gateway, then retry. No host network settings were changed.')


def proxy(interface, host, port):
    """OpenSSH byte pipe pinned to one USB NIC, never a fallback network route."""
    if interface not in usb_interfaces():
        raise ValueError('The selected stock USB interface disappeared or changed.')
    require_address(interface, host)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as peer:
        peer.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, interface.encode() + b'\0')
        peer.settimeout(10)
        peer.connect((host, port))
        peer.settimeout(None)
        inputs = [peer, sys.stdin.buffer]
        while peer in inputs:
            ready, _, _ = select.select(inputs, [], [])
            for source in ready:
                if source is peer:
                    data = peer.recv(65536)
                    if not data:
                        return
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                else:
                    data = os.read(sys.stdin.fileno(), 65536)
                    if data:
                        peer.sendall(data)
                    else:
                        inputs.remove(source)
                        peer.shutdown(socket.SHUT_WR)


def ssh_args(args, interface):
    proxy_command = shlex.join([sys.executable, str(Path(__file__).resolve()), '--proxy',
                               interface, args.host, str(args.port)])
    command = ['ssh', '-T', '-p', str(args.port), '-o', 'ConnectTimeout=10',
               '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=6',
               '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
               '-o', 'StrictHostKeyChecking=ask',
               '-o', 'HostKeyAlgorithms=+ssh-rsa', '-o', f'ProxyCommand={proxy_command}']
    if args.known_hosts:
        command += ['-o', f'UserKnownHostsFile={Path(args.known_hosts).resolve()}']
    return command + [f'root@{args.host}']


def transfer_archive(files):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as archive:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode = len(data), 0o700
            archive.addfile(entry, io.BytesIO(data))
    return out.getvalue()


def preparation_script(files, version_hash):
    # Inputs are validated local bytes, never filenames or commands from a device.
    if len(version_hash) != 64 or any(c not in '0123456789abcdef' for c in version_hash):
        raise ValueError('Invalid stock version digest.')
    checks = '\n'.join(f"{digest(files[name])}  {name}" for name in FILES)
    return "set -eu\numask 077\n" + STOCK_GUARD + f'''
[ "$(sha256sum /usr/usrdata/sdk_version.json | cut -d ' ' -f 1)" = {version_hash} ] || exit 1
mkdir /usrdata/.fpvos-p1-bootstrap.lock
work=
binary_linked=0
launcher_linked=0
cleanup() {{
    # Once armed, retain the verified files even if SSH/reboot fails. Never
    # leave an existing clean flag pointing to files removed by this helper.
    if [ ! -e /usrdata/sirius-clean-system-flag ] && [ ! -L /usrdata/sirius-clean-system-flag ]; then
        [ "$binary_linked" = 0 ] || rm -f /usrdata/fpvos-update
        [ "$launcher_linked" = 0 ] || rm -f /usrdata/fpvos-bootstrap.sh
    fi
    [ -z "$work" ] || rm -rf "$work"
    rmdir /usrdata/.fpvos-p1-bootstrap.lock
}}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
work=$(mktemp -d /usrdata/.fpvos-p1.XXXXXX)
tar -xf - -C "$work"
cd "$work"
sha256sum -c - <<'FPVOS_HASHES'
{checks}
FPVOS_HASHES
chmod 700 fpvos-update-p1-air bootstrap.sh
printf 'web:/usrdata/fpvos-bootstrap.sh\\n' >flag
# Hard links create the final names exclusively, on the same filesystem.
ln -T fpvos-update-p1-air /usrdata/fpvos-update
binary_linked=1
ln -T bootstrap.sh /usrdata/fpvos-bootstrap.sh
launcher_linked=1
sync
ln -T flag /usrdata/sirius-clean-system-flag
sync
echo FPVOS_P1_BOOTSTRAP_ARMED
# Remove only our temporary directory/lock before reboot. Final files stay.
cd /
cleanup
trap - EXIT HUP INT TERM
reboot
'''


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true', help='verify kit, USB connection and stock identity without staging files')
    mode.add_argument('--execute', action='store_true', help='stage the verified installer and reboot into RAM recovery')
    parser.add_argument('--interface', help='Linux USB network interface; auto-selected when exactly one matches')
    parser.add_argument('--host', default='192.168.3.100', type=lambda s: str(ipaddress.IPv4Address(s)))
    parser.add_argument('--port', default=22, type=int)
    parser.add_argument('--known-hosts', help='optional existing OpenSSH known_hosts file')
    args = parser.parse_args(argv)
    if not sys.platform.startswith('linux'):
        raise ValueError('This preparation helper currently supports Linux. Browser flashing also supports Windows and macOS after preparation.')
    if not 1 <= args.port <= 65535:
        raise ValueError('SSH port must be between 1 and 65535.')
    here = Path(__file__).resolve().parent
    directory = here if (here / 'manifest.json').is_file() else here.parent / 'assets/p1-updater/v1'
    manifest, files = load_assets(directory)
    interface = select_interface(args.interface, usb_interfaces())
    require_address(interface, args.host)
    print(f'Using USB interface {interface}; installer source {manifest["source_commit"]}.', flush=True)
    ssh = ssh_args(args, interface)
    checked = subprocess.run(ssh + [IDENTITY_COMMAND], stdout=subprocess.PIPE, check=True)
    version, version_hash = stock_identity(checked.stdout)
    print(f'Verified stock {version["product_version"]} {version["software_version"]}.', flush=True)
    if args.check:
        subprocess.run(ssh + ['set -eu\n' + STOCK_GUARD], check=True)
        print('Preparation checks passed. Run again with --execute to stage the installer and reboot.')
        return
    result = subprocess.run(ssh + [preparation_script(files, version_hash)], input=transfer_archive(files), stdout=subprocess.PIPE)
    print(result.stdout.decode(errors='replace'), end='', flush=True)
    armed = b'FPVOS_P1_BOOTSTRAP_ARMED\n' in result.stdout.splitlines(keepends=True)
    if not armed or result.returncode not in (0, 255):
        raise RuntimeError('Preparation failed. Inspect the message above; no firmware installation was requested. Do not retry an armed clean flag blindly.')
    print('Installer staged and clean boot armed. The SSH connection may close during reboot.\n'
          'Wait for P1 Air recovery to enumerate. In the flasher, Connect to its fpvOS USB port,\n'
          'select fpvos-p1-air.fwu, and Flash. The device checks NAND layout before installation.\n'
          'Keep external power connected. This helper has not installed firmware.')


if __name__ == '__main__':
    try:
        if len(sys.argv) == 5 and sys.argv[1] == '--proxy':
            proxy(sys.argv[2], str(ipaddress.IPv4Address(sys.argv[3])), int(sys.argv[4]))
        else:
            main()
    except subprocess.CalledProcessError as error:
        print(f'SSH preparation check failed (exit {error.returncode}); see the device error above.', file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, RuntimeError) as error:
        print(f'P1 preparation: {error}', file=sys.stderr)
        sys.exit(1)
