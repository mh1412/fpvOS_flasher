#!/usr/bin/env python3
"""Build/check the deterministic P1 browser recovery initramfs override."""
import argparse
import gzip
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'assets/p1-updater/browser-v1'

def entry(name, data=b'', mode=0):
    name = name.encode() + b'\0'
    fields = [0, mode, 0, 0, 1, 0, len(data), 0, 0, 0, 0, len(name), 0]
    header = b'070701' + ''.join(f'{v:08x}' for v in fields).encode() + name
    header += bytes(-len(header) % 4)
    return header + data + bytes(-len(data) % 4)

def build():
    archive = entry('init', (BASE / 'recovery-init').read_bytes(), 0o100755) + entry('TRAILER!!!')
    archive += bytes(-len(archive) % 512)
    payload = gzip.compress(archive, mtime=0)
    # Normalize gzip OS byte across Python/zlib versions.
    payload = payload[:9] + b'\xff' + payload[10:]
    header = struct.pack('>7I4B32s', 0x27051956, 0, 0, len(payload), 0, 0,
                         zlib.crc32(payload), 5, 22, 3, 1, b'P1 browser RAM recovery')
    header = header[:4] + struct.pack('>I', zlib.crc32(header)) + header[8:]
    return header + payload

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    target = BASE / 'recovery-initrd.img'
    image = build()
    if args.check:
        if target.read_bytes() != image:
            raise SystemExit('P1 recovery initrd differs from its source; rebuild it.')
        print('P1 recovery initrd matches its source.')
    else:
        target.write_bytes(image)
