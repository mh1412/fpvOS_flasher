# AR9311 RAM updater

`v3/` contains the bank-aware updater and its launcher, built from the public
fpvOS source commit recorded in its manifest
(<https://github.com/gehee/fpvOS>, `ascentvrx_defconfig`). The updater embeds
BusyBox and preparation helpers. The launcher is only the stock clean-hook
entry. No firmware image is bundled here.

The app only loads the pinned `v3` assets. `v3` replaces the earlier `v2`,
whose source commit was never published. The launcher is byte-identical to
`v2`'s. The updater has the same protocol and identity, with the stock-bootstrap
logic now shared with the P1 Air and an added stock-return command. `v3` has
**not yet been flashed on a standard VRX**; `v2` was hardware-tested through the
web UI from stock 18.21.10 with either bank selected, including stock
restoration. Updates remain experimental and shared kernel/DTB writes are not
power-loss atomic. Never send vendor FileEnd for either staging file, including
the executable (>1 MiB).

To rebuild from that commit (Buildroot as pinned in `br-external/BUILDROOT_VERSION`):

```bash
./build.sh ascent-vrx
make -C output/ascent-vrx fpvos-update-rebuild
```

The second command matters: a single build embeds BusyBox before Buildroot
strips the target at its final step, giving a larger binary. The output is
`output/ascent-vrx/images/fpvos-update-ascent-vrx`, published here as
`fpvos-update-ar9311`; the launcher is `fpvos-ascent-vrx-bootstrap.sh`. BusyBox's
build timestamp is the only difference between two builds.

To update, copy a tested build into a new version directory, record its source
commit, sizes and SHA-256 hashes, and update the manifest pin in
`stages/ar9311-bootstrap.js`. Keep deployment and browser asset lists in sync.
The executable and embedded BusyBox are GPL-licensed; corresponding source is
the pinned fpvOS repository commit (including its Buildroot pins). `COPYING`
contains the GPLv2 license text.
