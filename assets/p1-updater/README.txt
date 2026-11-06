P1 browser recovery — supported stock firmware
================================

Use desktop Chrome/Edge over HTTPS or localhost. Tested on Linux Chromium;
Windows/macOS are not yet qualified. Supported stock versions: 1.0.44, 2.0.5,
2.0.6 and 2.1.2. Unknown/future 2.x versions are not implicitly supported.
End-to-end hardware tests cover 1.0.44 and 2.1.2; 2.0.5/2.0.6 have offline
bootloader checks only. The newly rebuilt recovery still needs a repeat
hardware test after incorporating upstream installer fixes. Automatic detection
and units with mismatched stock/U-Boot versions remain unresolved.
Standard P1 Air only: not P1 AIO, Matrix, goggles or Ascent hardware.

1. Connect USB and external power and let stock firmware finish starting.
   Disconnect other Artosyn devices.
2. In the flasher's Device panel, expand the stock P1 instructions and confirm
   the standard P1 Air model and select its exact installed stock version.
   Do not guess: stock 1.x and 2.x use different bootloader RAM addresses.
3. Click Restart stock P1 and select its Sirius serial port.
4. Wait for USB to reconnect. Click Load P1 recovery and select the same unit,
   now called USB download gadget. Already in this mode? Start at this step.
5. When recovery starts, click Connect and select the P1 Air serial port. Choose a
   valid fpvos-p1-air.fwu file and click Flash. Stock 2.x requires a firmware
   build including the source patch below, not an older P1 bundle. Keep power connected until
   installation and the reboot verification finish.

These are different USB identities of ONE physical P1. Browser permissions are
separate for its stock serial port, bootloader HID and fpvOS recovery serial port.
No SSH, USB networking, Python program or local preparation helper is needed.
Preparation only writes RAM. Firmware is installed by the existing P1 updater,
which preserves stock bank 1, factory calibration and user settings.

Linux USB permissions
---------------------
If the browser lists the bootloader but cannot open it, close other updaters.
Linux may also require a local HID access rule. An administrator can put this
line in /etc/udev/rules.d/70-fpvos-p1.rules:

SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1d6b", ATTRS{idProduct}=="0100", TAG+="uaccess"

Reload udev rules, then reconnect the USB device. This grants the active local
user access to matching Artosyn bootloader HID devices; it does not identify a
particular board. Serial ports also need the usual local serial permissions.
This is an operating-system access setting, not a firmware preparation helper.

Recovery after interruption
---------------------------
Before Flash: retry Load P1 recovery if USB download gadget is still present.
Power-cycle to discard temporary RAM changes and return to installed firmware.
An unknown bootloader/fingerprint must not be forced through the checks.
During Flash: keep power connected and allow the updater to finish. If an
installation fails, save the log and inspect the selected boot mode; do not
repeatedly flash unverified images. This does not recover damaged SPL/U-Boot.

Source and assets
-----------------
Kernel and DTB: https://github.com/gehee/fpvOS
Commit: 5c55cfb039d30568a56726d96a917ceb1ed36546
Source changes: apply browser-v1/source.patch to that commit first.
The patch SHA-256 and size are recorded in manifest.json. It permits either
valid environment/U-Boot bank selection without changing those selections.
Build: ./build.sh p1-air-source
Files: output/p1-air-source/images/kernel.img and betafpv-p1-air.dtb
The kernel embeds the independent fpvos-recovery root and P1 updater.

browser-v1/manifest.json pins exact sizes, SHA-256 hashes, RAM destinations and
supported bootloader fingerprints. The flasher pins the manifest hash too.
Bootloader RAM layouts are deliberately version-specific (v1 and v2). A one-byte
protocol adaptation is necessary before readable bootloader identification;
all later callback/image writes require matching fingerprints and dispatch data.
No proprietary bootloader code is distributed or flashed by this page.

browser-v1/recovery-init is based on fpvos-recovery/src/init at the source commit
above, with NAND-root loading disabled so preparation always enters recovery.
Run python3 tools/package-p1-recovery.py to rebuild recovery-initrd.img, or add
--check to verify it. Its deterministic newc/gzip archive contains only /init
and overlays the embedded recovery root. The 64-byte uImage wrapper is generated
locally; it is not a stock firmware image. See COPYING for GPL-2.0.
