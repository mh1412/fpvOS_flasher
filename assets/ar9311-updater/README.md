# AR9311 RAM updater

`v2/` contains matching bank-aware outputs from the fpvOS source commit recorded in its
manifest. The updater embeds BusyBox and preparation helpers. The launcher is
only the stock clean-hook entry. No firmware image is bundled here.

`v1/` is retained as a historical artifact; the app only loads pinned `v2` assets.
`v2` was hardware-tested through the web UI from stock 18.21.10 with either bank
selected, including stock restoration. Updates remain experimental and shared
kernel/DTB writes are not power-loss atomic. Never
send vendor FileEnd for either staging file, including the executable (>1 MiB).

To update, copy a tested build into a new version directory, record its source
commit, sizes and SHA-256 hashes, and update the manifest pin in
`stages/ar9311-bootstrap.js`. Keep deployment and browser asset lists in sync.
The executable and embedded BusyBox are GPL-licensed; corresponding source is
identified by the pinned fpvOS repository commit (including its Buildroot pins).
Before publishing these binaries, make that corresponding source commit available
at the recorded repository URL. `COPYING` contains the GPLv2 license text.
