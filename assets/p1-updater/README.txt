P1 stock-to-fpvOS preparation kit v1

This one-time helper prepares a BETAFPV P1 Air on stock P1_SKY v1.0,
firmware 1.0.44.rel, for installation through fpvOS Flasher. It copies the
included installer and launcher, verifies their hashes on the device, and
reboots into clean RAM recovery. It does not install the firmware itself.

Requirements
- Linux with Python 3, OpenSSH client and iproute2. The helper uses no Python
  packages. Windows/macOS preparation is not implemented by this helper.
- External power and USB connected to the P1; verified device backups.
- Stock root SSH access. The standard 1.0.44 password is artosyn; if changed,
  use your password. SSH prompts normally; no password is saved by the helper.
- Set the P1 USB network interface to 192.168.3.200 with prefix 24, no gateway
  and no DNS server. The P1 uses 192.168.3.100. Use your Linux network settings;
  this helper does not change network configuration or routes.

Use
1. Extract this entire ZIP into one directory and open a terminal there.
2. Verify the connection and files without staging anything:
     python3 prepare-p1.py --check
3. Prepare and reboot the unit:
     python3 prepare-p1.py --execute
4. Keep power connected. When P1 Air recovery appears on USB, return to the
   flasher page, click Connect and select the fpvOS P1 port. Choose the full
   fpvos-p1-air.fwu from the p1-air-source firmware build, then click Flash.
   The browser verifies clean recovery, transfers the bundle, waits for NAND
   installation/readback, reboots and checks the running firmware hash.

If more than one matching USB network interface is present, specify the P1:
  python3 prepare-p1.py --interface enx0123456789ab --execute
The helper only uses that USB interface, with no fallback route to another
device at the same IP address. OpenSSH verifies its host key. Verify a new
fingerprint through your trusted device records before accepting it. Existing
known_hosts entries are respected; --known-hosts FILE selects another file.

Preparation refuses an existing /usrdata/fpvos-update,
/usrdata/fpvos-bootstrap.sh, /usrdata/sirius-clean-system-flag or helper lock.
Inspect earlier preparation before retrying; do not blindly delete these.
An interrupted transfer before arming cleans up this helper's staging files.
After the clean flag is armed, verified installer files are retained if reboot
or SSH fails. Do not run preparation a second time while that flag exists.
The source updater checks stock runtime and NAND geometry before installing.
The clean launcher consumes its flag and removes its staging files after
copying the installer to RAM. Normal fpvOS updates use built-in recovery.

Stock P1 USB serial only requests entry to the vendor USB bootloader. It does
not expose the Ascent VRX file-transfer protocol. This kit uses stock SSH over
USB networking; it does not replace bootloaders or use the vendor flash path.
Only the subsequent browser Flash action installs firmware. Factory data,
stock bank 1 and existing user settings are preserved by the P1 updater.

Source and maintenance
Installer and launcher source:
  https://github.com/mh1412/fpvOS/tree/e32ea69aac26fec989a8a7f48419356846702d41
The manifest records this revision and the exact executable/launcher hashes.
The executable includes BusyBox and P1 recovery helpers. GPL-2.0-or-later
applies to fpvos-update; BusyBox is GPL-2.0. See COPYING and the corresponding
source revision's Buildroot pins, package recipes and busybox fragments.
Build with ./build.sh p1-air-source in that source tree. For an existing
configured build, make -C output/p1-air-source fpvos-update-dirclean and then
make -C output/p1-air-source fpvos-update rebuild this standalone installer.
The complete firmware build currently needs the documented Kestrel source
override; the standalone installer does not contain Kestrel or camera blobs.

In fpvOS_flasher, tools/prepare-p1.py is the maintained helper. To refresh the
download after helper changes, run python3 tools/package-p1-bootstrap.py.
CI checks that the download exactly matches its source files. Changed binary
releases require a new version directory, manifest pin and available source.
