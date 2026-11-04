P1 browser recovery — stock 1.0.44
================================

Use desktop Chrome/Edge over HTTPS or localhost. Tested on Linux Chromium;
Windows/macOS and other stock firmware versions are not yet qualified.
Standard P1 Air only: not P1 AIO, Matrix, goggles or Ascent hardware.

1. Connect USB and external power and let stock firmware finish starting.
   Disconnect other Artosyn devices.
2. In the flasher's Device panel, expand the stock P1 instructions and confirm
   that the unit is a standard P1 Air running stock 1.0.44.
3. Click Restart stock P1 and select its Sirius serial port.
4. Wait for USB to reconnect. Click Load P1 recovery and select the same unit,
   now called USB download gadget. Already in this mode? Start at this step.
5. When recovery starts, click Connect and select the P1 Air serial port. Choose a
   valid fpvos-p1-air.fwu file and click Flash. Keep power connected until
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
Build: ./build.sh p1-air-source
Files: output/p1-air-source/images/kernel.img and betafpv-p1-air.dtb
The kernel embeds the independent fpvos-recovery root and P1 updater.

browser-v1/manifest.json pins exact sizes, SHA-256 hashes, RAM destinations and
supported bootloader fingerprints. The flasher pins the manifest hash too.
The 1.0.44 bootloader RAM layout is deliberately version-specific. A one-byte
protocol adaptation is necessary before readable bootloader identification;
all later callback/image writes require matching fingerprints and dispatch data.
No proprietary bootloader code is distributed or flashed by this page.

browser-v1/recovery-init is based on fpvos-recovery/src/init at the source commit
above, with NAND-root loading disabled so preparation always enters recovery.
Run python3 tools/package-p1-recovery.py to rebuild recovery-initrd.img, or add
--check to verify it. Its deterministic newc/gzip archive contains only /init
and overlays the embedded recovery root. The 64-byte uImage wrapper is generated
locally; it is not a stock firmware image. See COPYING for GPL-2.0.
