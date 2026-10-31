# AR9311 RAM updater

`2026.10.31-ascent-vrx.1/` contains the matching updater and launcher from the
[fpvOS release](https://github.com/mh1412/fpvOS/releases/tag/2026.10.31-ascent-vrx.1),
built from public source commit `8cb13d6eed4e5b913625f79f675dfd957825cb18`.
The release includes corresponding source and license archives. Its manifest
retains the v2 schema. The updater embeds BusyBox and preparation helpers; the
launcher is only the stock clean-hook entry. No firmware image is bundled here.

`v1/` and `v2/` are historical artifacts and are excluded from the staging site.
The app only loads the pinned release assets. This exact release build has not
been flashed on hardware. The preceding `v2` build was hardware-tested through
the web UI from stock 18.21.10 with either bank selected, including stock
restoration. Updates remain experimental and shared
kernel/DTB writes are not power-loss atomic. Never
send vendor FileEnd for either staging file, including the executable (>1 MiB).

To update, copy a tested build into a new version directory, record its source
commit, sizes and SHA-256 hashes, and update the manifest pin in
`stages/ar9311-bootstrap.js`. Keep deployment and browser asset lists in sync.
The executable and embedded BusyBox are GPL-licensed; corresponding source is
identified by the pinned fpvOS repository commit (including its Buildroot pins).
Before publishing these binaries, make that corresponding source commit available
at the recorded repository URL. `COPYING` contains the GPLv2 license text.
