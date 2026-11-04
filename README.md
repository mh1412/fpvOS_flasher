# fpvOS Flasher

**<https://gehee.github.io/fpvOS_flasher/>**

> **Experimental: use it at your own risk.** The flasher is new and not yet
> tested on every device and firmware. Flashing can leave a device that has to
> be recovered by hand.

**Flashing the fpvOS air image?** The step-by-step guide, with what to expect
and how to go back to stock, is in
[fpvOS's install guide](https://github.com/gehee/fpvOS/blob/main/docs/INSTALL.md#flash-the-air-unit-optional).

A web page that flashes FPV devices over USB. It runs in Chrome or Edge on a
desktop computer (Linux, Windows, macOS) through the Web Serial API. There is
nothing to install.

For each device, the page talks to the updater that already runs on it, with
the same messages the vendor's PC tool uses. It checks the image before
anything is sent, and the device does the flashing itself. The page therefore
cannot do anything the vendor tool could not.

## Supported devices

| Device | Images | Status |
| --- | --- | --- |
| Ascent Lite air unit | `Ascent_H_Sky_*.img`, stock or fpvOS | **flashed on real hardware** (the fpvOS beta3 air image, 2026-10-08); also tested against a simulated unit, in Node and in headless Chrome |
| Ascent Lite+ air unit | `Ascent_H_Sky_*.img`, stock or fpvOS | as the Lite: the same image and updater; **not yet on a Lite+** |

A new device needs these changes:
- an entry in `DEVICES` in `app.js`, which gives its USB vendor id, the image
  names it takes and the models shown in the list (a new model of a supported
  kind only needs its name added there);
- a module for its protocol and image checks, like `ascent.js`.

## Use

Open the page above. A local copy also works: Web Serial needs a secure page,
which `http://localhost` is.

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Then open <http://localhost:8000>:

1. Plug in the device and click **Connect**, then pick its port in the
   browser's list. A device the page was allowed before connects as soon as it
   is plugged in.
2. Drop a firmware image on the page, and read the checks it shows. An archive
   holding one works too, so the vendor's `.zip` download can be dropped as it
   is. See [Archives](#archives) for the formats.
3. Click **Flash**.

To use the page from another computer on the LAN, either open it through an
ssh tunnel to `localhost`, or enable "Insecure origins treated as secure" for
its address in `chrome://flags`.

Close the vendor's PC tool and any serial terminal first, because only one
program can open the port. On Linux, your user needs access to
`/dev/ttyACM*` (the `dialout` group).

## Archives

The page takes an image as is, or an archive holding one:

- `.zip`, stored or deflate, with zip64. The vendor's download is a zip of
  this kind.
- `.xz` and `.gz`.
- `.tar`, alone or inside `.gz` or `.xz`.
- Any nesting of these, for example an `.img.xz` inside a zip.

From a zip, only the chosen entry is read, so a 400 MB download costs the size
of one image. The page picks the image that a supported device takes, by its
file name (for the Ascent air unit, `Ascent_H_Sky_<version>.img`). If there are
several, it takes the newest and says so. If there are none, it lists what the
archive holds.

zip and gzip are unpacked by the browser itself. xz is unpacked by our own
decoder in `xz.js`, which handles LZMA2 and the CRC-32, CRC-64 and SHA-256
checks. The CRC-32 or check of every format is verified.

## Ascent air unit

The unit restarts twice during a flash: once into its update system, and once
into the new firmware. If Chrome loses the port across a restart, the page asks
you to select the device again. The unit writes its other flash bank and then
switches to it, so a failed or interrupted transfer leaves the running bank as
it was.

| Check | Done by |
| --- | --- |
| ASW magic, board 3 (air unit), size, CRC-32 of the payload, sections inside the file and within their NAND partitions | page, before sending |
| The device is an air unit; image older than the device (warning) | page |
| CRC-32 of every frame | unit |
| MD5 of the whole file, then version and rollback rules | unit |
| Each data chunk acknowledged before the next; a chunk is never sent twice | page |

The file is sent as `Ascent_H_Sky_<major>_<minor>_<patch>.img`, built from the
version in the header, because the unit takes the version from the file name.
Ground images (goggles and VRX, boards 5 and 1) use another layout, and the
page refuses them.

The **Advanced** section can also switch the unit's USB to network (RNDIS)
mode. It is the same command `enable_rndis*.py` sends.

The protocol is described at the top of [`ascent.js`](ascent.js). It was read
from a decompile of the vendor PC tool's Windows build (v2.0.40, .NET). Every
message is a 36-byte "OTRA" header with a CRC-32, followed by the payload. The
flash sequence is:

1. `FIND_DEVICE` (60).
2. `REBOOT` (3) with the payload `clean`. The unit then reappears in update
   mode.
3. `REMOTE_UPGRADE` (114).
4. `FILE_START` (115).
5. `FILE_DATA` (116), in 1 MiB chunks.
6. `FILE_END` (117).
7. `UPGRADE_STATUS` (118), polled until the reply passes 99 %.

The vendor tool's other features (BB frequency config, gimbals, RC modes) are
not covered.

## Files

- `index.html`, `app.js`: the page, the device list, and the Web Serial link
  with its reconnect after a reboot. The page is styled after the goggle's own
  web page: the HUD's KESTREL theme, with Chakra Petch from `fonts/` under the
  OFL.
- `ascent.js`: the Ascent air unit's protocol, image checks, MD5 and flash
  sequence. It uses no browser APIs, so the tests share it.
- `archive.js`, `xz.js`, `checksum.js`: opening archives, the xz decoder, and
  CRC-32 / CRC-64.
- `test/test.mjs`: unit tests, plus full flashes against a simulated unit
  (`test/sim.mjs`). The simulated unit loses replies, sends junk bytes, splits
  reads and rejects an MD5.
- `test/archive.test.mjs`: xz, gzip, tar and zip archives made by the real
  tools, then damaged, nested and empty archives. Setting
  `VENDOR_ZIP=path/to/the/download.zip` also opens the vendor's own zip.

  ```bash
  node --test test/test.mjs test/archive.test.mjs
  ```

- `test/browser-check.mjs`: runs the real page in headless Chrome against a
  fake `navigator.serial` (`test/fake-serial.js`). It flashes through the UI
  four times: from the image with the port permission kept across the
  reboots, from a zip, from an `.img.xz`, and with the permission lost. It
  saves screenshots.

  ```bash
  node test/browser-check.mjs IMG [OUTDIR]
  ```

- `test/flash-node.mjs`: drives `ascent.js` on a real unit from Linux, without
  a browser.

  ```bash
  node test/flash-node.mjs info
  node test/flash-node.mjs flash IMG
  ```

- `.github/workflows/pages.yml`: runs the tests on every push to `main` and
  every pull request. It publishes the commit the `live` tag points to
  (without `test/`) to GitHub Pages, so `main` can move on without changing
  the page:

  ```bash
  git tag -f live COMMIT && git push -f origin live
  ```

  A commit whose workflow has no `live` trigger (an older one, a fork's pull
  request) is published by hand after moving the tag:

  ```bash
  gh workflow run pages.yml --ref main
  ```

Firefox and Safari have no Web Serial, so the page does not work in them.

## License

GPLv3, as fpvOS ([LICENSE](LICENSE)). The Chakra Petch fonts in `fonts/` are
under the SIL Open Font License ([fonts/OFL.txt](fonts/OFL.txt)).
