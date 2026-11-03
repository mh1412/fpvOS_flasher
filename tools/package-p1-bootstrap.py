#!/usr/bin/env python3
"""Build/check the deterministic, self-contained P1 preparation download."""
import argparse
import importlib.util
import io
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'assets/p1-updater/p1-stock-preparation-v1.zip'


def package():
    spec = importlib.util.spec_from_file_location('prepare_p1', ROOT / 'tools/prepare-p1.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    helper.load_assets(ROOT / 'assets/p1-updater/v1')
    sources = {name: ROOT / 'assets/p1-updater/v1' / name for name in ('manifest.json', *helper.FILES)}
    sources.update({'prepare-p1.py': ROOT / 'tools/prepare-p1.py',
                    'README.txt': ROOT / 'assets/p1-updater/README.txt',
                    'COPYING': ROOT / 'assets/p1-updater/COPYING'})
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as archive:
        for name, source in sorted(sources.items()):
            entry = zipfile.ZipInfo('p1-stock-preparation-v1/' + name, (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (0o100644 << 16)
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, source.read_bytes())
    return out.getvalue()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    data = package()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_bytes() != data:
            raise SystemExit('P1 preparation download is stale; run python3 tools/package-p1-bootstrap.py')
        print('P1 preparation download matches its pinned assets and helper.')
    else:
        OUTPUT.write_bytes(data)
        print(OUTPUT)
