# Architecture

The app is static ES modules. Browser and Linux entry points share image
preparation, device policy and a sequential stage runner; only serial I/O differs.

```text
app.js / test/flash-node.mjs
  ├─ transports/web-serial.js / transports/node-serial.mjs
  └─ flasher.js
       ├─ devices/           identity, image validation and profiles
       ├─ stages/            ordered flash operations
       └─ transports/ascent.js   framing, sessions and transfer primitives

archive.js → xz.js / checksum.js
firmware.js → container and version helpers
```

## Device profiles

Each module in `devices/` exports a profile with three sections:

```js
{
  meta: {
    id, name, models, usb,
    identity: { matches, normalMatches, updateMatches },
    image: { prefix, pattern, detect, parse, checks, columns },
    deviceVersion,
    unlock: { supported, label, notice }, // optional
    notices: { flash, network },
  },
  transport: { protocol, serial, maxChunk, timeouts, allowZeroDataAckLength, strictReplies },
  stages: {
    preflash: [PREPARE_UPDATE_MODE, VERIFY_UPDATE_MODE],
    flash: [START_FIRMWARE, SEND_FIRMWARE, FINALIZE_FIRMWARE, WAIT_INSTALL],
    postflash: [RECONNECT, VERIFY_INSTALLED_FIRMWARE],
  },
}
```

Stage arrays contain function references and run in order. The VRX preparation
function selects ordinary or unlocked entry internally, using the fixed plan.
Device modules own image layouts and identity rules; the registry in
`devices/index.js` only resolves supported profiles. Shared ASW helpers and
transport defaults live in `devices/common.js` and `transports/ascent.js`.

## Preparation and execution

- `prepareFirmware()` extracts a matching archive entry, identifies its profile
  from contents, validates it and computes transfer MD5. Mixed-device archives
  require a target. Its normalized `view` supplies facts, columns and rows to the UI.
- `evaluateSelection()` is pure: it returns compatibility issues, readiness,
  chunk size and automatic/manual unlock selection. Rendering does not mutate
  the selection. A profile choice cannot override hardware identity.
- The UI snapshots the connection, image and effective plan at confirmation,
  and checks that they still match before starting.
- `flashFirmware()` awaits preflash → flash → postflash. A failed step stops
  execution and closes the link. An installation with no post-reboot reply is
  reported as unverified, rather than a verified success.

Each stage receives `{session, profile, image, originalDevice, plan, signal,
options, report, runtime, step, checkCancelled}`. Original identity and plan are
fixed snapshots; working state belongs in `runtime`.

## Invariants

- Validate the image and connected identity before preparation; verify update
  mode before firmware upload, then factory identity and installed version after reboot.
  `identity.updateMatches` checks the complete update-mode identity, including
  any model-name or factory-field changes; normal-mode matching remains separate.
- Never resend FILE_DATA. Check acknowledged status and cumulative/total byte
  counts. Air firmware transfers accept the updater's zero `Length` field via
  `allowZeroDataAckLength`; other nonmatching lengths are rejected. Staging
  requires exact chunk lengths and valid reply CRCs, and never sends FILE_END.
  Ordinary firmware replies retain vendor-compatible CRC warning/acceptance.
- Complete unlock selector arming and reboot without a cancellation gap.
- Once firmware FILE_END begins, continue installation monitoring and postflash
  checks even if cancellation is requested.
- Serial adapters own port/stream lifetime and receive settings and device
  filters from the caller; they do not import the device registry.

## Adding hardware support

1. Add a module in `devices/` with positive normal/update identities and an
   image validator. Define its transport settings and sequential stage arrays.
2. Register the profile in `devices/index.js` and reuse shared stages where applicable.
3. Add fixtures and tests for malformed images, mismatches, update-mode identity,
   failures and postflash verification. Extend the simulator/browser cases.
4. Add browser-imported modules to `PUBLIC_ASSETS` in `test/browser-harness.mjs`.

The browser harness supplies the localhost server, Chromium/CDP lifecycle and
UI helpers. Only `test/browser-check.mjs` installs fake serial; the explicit
hardware runner keeps native Web Serial.
Its disposable Chromium profile uses a basic password store to avoid interactive
desktop-keyring waits. For fpvOS tests, `--fpvos` selects the initial backend;
`--usb-path` checks its physical connection. Stock bootstrap tests use
`--updater-usb-path` and `--xvfb-chooser` inside `xvfb-run` with
`FPVOS_XVFB_CHOOSER=1` (requires xdotool and Python Pillow). This operates the real
Serial chooser; CDP DeviceAccess does not expose it. Exactly one updater is allowed.
Restoration tests additionally require `--restore-stock` and explicit expected
stock USB serial, device serial, hardware and firmware. All transfers run through
the unmodified UI and native Web Serial; no serial API is substituted.

The air clean updater can report `Ascent` with `FPV-Edu-Sky-V0.0-0.0` and a blank
serial. This is accepted only during preflash after a supported normal-mode air
connection, with unchanged H_Sky firmware and healthy status. It is not a normal
device identity, and postflash still requires the original factory fields.
Normal-mode checks also accept the observed `Ascent_H_Sky`/`Ascent_lite`
presentation change: a `1_` serial prefix and trailing hardware report `1.0`/`1.1`.
The serial identifier, board number and main hardware revision must still match;
other serial prefixes or hardware changes are not normalized.

## VRX preparation

Unlock requires healthy normal-mode board-485 identity and a canonical G_Gnd
version with unsigned 32-bit components. It is selected automatically for valid
matching downgrades; manual choice resets on file/profile/connection changes and
successful flash. Eligibility does not guarantee compatibility with future updaters.

The stock updater caches `/etc/app.version` at startup and compares candidate
filename versions lexicographically, rejecting older tuples with status -6.
Unlock stages a one-shot script and `/factory/sirius-clean-system-flag` selector,
then sends `REBOOT normal` (`clean` would overwrite the selector). The script
execs from RAM, removes its staged copy, overlays only `APP_VERSION=0.0.0`, and
starts the vendor clean updater. Firmware bytes and signature checks stay unchanged.

Normal clean mode uses a blank serial and `485-V0.0-0.0` hardware revisions;
unlocked mode additionally requires SDK `0.0.0` and `Ascent_G_Gnd_0_0_0`.
Both require the original model/board lineage and healthy status before upload.
Full factory identity and the requested real version are required after reboot.

If preparation fails, the script attempts to remove the overlay and reboot.
An ordinary restart restores the real version after the one-shot selector is
consumed; an armed selector may require a second restart. The clean daemon may
acknowledge a serial reboot without restarting, so manual recovery can be needed.

## AR9311 fpvOS recovery service

`devices/fpvos-bundle.js` validates the shared `FPVOSUP1` envelope using each
board's manifest policy. `devices/fpvos-p1-air.js` uses board ID 1345409867,
hardware `P1_SKY`, serial `fpvos-p1-air`, and the ordered components `kernel.img`,
`betafpv-p1-air.dtb`, `rootfs.cpio.gz`. Only full kind-0 installs are accepted.
Its limits follow the P1 firmware backend; VRX kind-1 restoration is excluded.
The existing fpvOS stage sequence handles clean recovery, install status and
postboot SHA verification for both boards.

USB `1d6b:0104` selects the shared strict fpvOS transport, not a hardware profile.
Its initial connection window is 30 seconds because the USB gadget can
enumerate before the updater is ready during cold boot.
`profileForDevice` combines USB membership with the complete updater identity.
Reconnection prefers the original browser port and requires selection when
several alternative ports match. The fpvOS stages supply an `acceptDevice`
probe so another board is rejected before any mutating command is sent.
The Linux adapter also keeps the original physical USB path across reboots.
Filename matching is only an archive filter; ambiguous `.fwu` filenames have
no board profile until their header is read.

`devices/fpvos-ar9311.js` validates the full `FPVOSUP1` bundle manifest,
component policy, lengths, header CRC and component SHA-256 hashes. Kind 0
contains kernel/DTB/root; kind 1 contains full original kernel/DTB partitions.
Root-only bundles are rejected even though they share board ID 485. The device
remains responsible for nested image validation and NAND/layout protections.
Neither signatures nor version ordering are required by this service.

`stages/fpvos.js` handles its distinct protocol semantics: clean may complete
without reboot, FileEnd ACK text is not `OK`, state 2 means verification only,
and only state 4 at 100% permits an explicit reboot. A missing finalization ACK
is followed by status monitoring, never retransmission. Replies require valid
CRC and response type. Postboot verification requires the whole bundle SHA-256;
original-stock restoration instead requires a healthy standard-VRX boot identity.
Its constant USB serial identifies the backend, not a unique physical unit.

Stock restoration allows USB re-enumeration to the vendor VID/PID. A full kind-0
bundle can also select the stock-to-fpvOS bootstrap operation on a healthy,
explicitly supported stock identity. The plan retains the source profile for
connection validation and selects the fpvOS execution profile for its stage arrays.
`FPVOS_PREPARE` runs `AR9311_BOOTSTRAP` internally when that fixed plan requests it;
there is no alternate workflow language or independent unlock configuration.

`assets/ar9311-updater/v2/` contains the embedded-tools updater and matching tiny
launcher, with source provenance and file hashes. `stages/ar9311-bootstrap.js`
pins the manifest SHA-256 and checks all assets before any upload. A dedicated
bounded binary-staging primitive permits this ELF up to 2 MiB; ordinary text
staging retains its 64 KiB limit. Neither staging path sends FileEnd. After the
selector is armed, ordinary reboot/reconnect finishes even if cancellation was
requested; cancellation is honored before uploading firmware to the new service.

The bootstrap explicitly prompts for a new USB port and never automatically
chooses an already-authorized generic fpvOS updater. Only its expected VID/PID,
board/backend identity and `clean RAM mode` readiness are accepted before the
firmware upload. The backend serial is constant, not unique factory identity:
the user must select this VRX and disconnect other VRXs. Target-side runtime,
geometry and GPT checks remain authoritative. The stock updater alternates banks;
the bank-aware kernel and updater share a strict GPT decoder, preserving the active
stock root read-only and storing fpvOS in the other bank without changing GPT.
Legacy fixed-bank fpvOS bundles are refused when stock uses `userapp1`.
The initial fixed-bank preflight and chroot PATH failures are fixed in `v2`.
Hardware UI installation from official 18.21.10 passed with either stock bank
selected, including postboot bundle SHA-256, read-only active-stock mapping,
and unchanged stock-root/GPT checks. UI kernel/DTB restoration returned to
stock 18.21.10 with verified factory identity; the restored image payloads match
the official release. The official vendor `.img` stock-to-stock route also passed.
No backup export is performed. Arbitrary vendor-image
installation and the stock-kernel firmware profile remain unsupported.
