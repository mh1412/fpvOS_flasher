#!/usr/bin/env python3
"""Give the complete deployed module graph and its assets revision-specific URLs."""
import argparse
from pathlib import Path
import re
import shutil


def version_site(site, revision):
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Expected the full Git commit SHA.')
    index = site / 'index.html'
    html = index.read_text()
    entry = '<script type="module" src="app.js"></script>'
    if html.count(entry) != 1:
        raise ValueError('Expected exactly one unversioned application entry point.')
    # Relative imports and import.meta.url asset paths stay within this revision.
    # Root assets remain available for HTML links and previously opened pages.
    prefix = f'releases/{revision}'
    destination = site / prefix
    destination.mkdir(parents=True)
    for source in site.glob('*.js'):
        shutil.copy2(source, destination / source.name)
    for name in ('devices', 'stages', 'transports', 'assets'):
        shutil.copytree(site / name, destination / name)
    index.write_text(html.replace(entry, f'<script type="module" src="{prefix}/app.js"></script>'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', type=Path)
    parser.add_argument('revision')
    args = parser.parse_args()
    version_site(args.site, args.revision)
