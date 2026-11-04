import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CMD, md5hex } from '../transports/ascent.js';
import { getProfile } from '../devices/index.js';
import { flashFirmware } from '../flasher.js';
import { buildVrxUnlock } from '../stages/vrx-unlock.js';
import { parseVrx, canUnlockVrx, matchesVrxUnlocked } from '../devices/ascent-vrx.js';
import { vrxImage, TEST_VRX_KEY } from './fixtures.mjs';
import { openSimulatedDevice } from './sim.mjs';

const profile = getProfile('ascent-vrx');
async function receiver(opts = {}) {
  const receiver = await openSimulatedDevice(profile, { name: 'Ascent_VRX', firmware: 'Ascent_G_Gnd_18_21_10',
    hardware: 'FPV-Ascent-Gnd-485-V1.2-1.0', serial: 'UNLOCK001', sdk: '18.21.10',
    allowNormalPrepare: true, enforceRollback: true, ...opts });
  const bytes = vrxImage(), parsed = await parseVrx(bytes, '', { publicKey: TEST_VRX_KEY });
  parsed.profileId = profile.meta.id;
  return { ...receiver, image: { bytes, parsed, md5: md5hex(bytes) } };
}

test('VRX preflash unlock permits a signed-image downgrade without changing image bytes or final identity', async () => {
  const { unit, session, info, image } = await receiver();
  const stages = [];
  const after = await flashFirmware(session, profile, image, { info, unlock: true, progress: (p) => stages.push(p.stage) });
  assert.equal(after.firmware, 'Ascent_G_Gnd_17_5_8');
  assert.equal(after.serial, info.serial);
  assert.equal(after.hardware, info.hardware);
  assert.deepEqual(unit.file.data, Buffer.from(image.bytes));
  assert.match(unit.starts[0], /^\/usrdata\/fpvos-unlock-[a-f0-9]{32}\.sh$/);
  assert.equal(unit.starts[1], '/factory/sirius-clean-system-flag');
  assert.equal(unit.starts[2], '/tmp/pc/Ascent_G_Gnd_17_5_8.img');
  assert.equal(unit.received.filter((c) => c === CMD.FILE_END).length, 1);
  assert.equal(unit.staged.size, 0);
  assert.ok(stages.includes('unlock'));
});

test('the same downgrade is rejected without the unlock option', async () => {
  const { unit, session, info, image } = await receiver();
  await assert.rejects(flashFirmware(session, profile, image, { info }), /status -6/);
  assert.equal(unit.starts.length, 1);
});

test('failed unlock proof prevents firmware upload; unknown version or hardware identity cannot use unlock', async () => {
  const { unit, session, info, image } = await receiver({ unlockFails: true });
  await assert.rejects(flashFirmware(session, profile, image, { info, unlock: true }), /reconnected device/);
  assert.equal(unit.starts.length, 2);
  assert.ok(!unit.received.includes(CMD.FILE_END));
  const other = await receiver({ firmware: 'Ascent_G_Gnd' });
  await assert.rejects(flashFirmware(other.session, profile, other.image, { info: other.info, unlock: true }), /not supported/);
  assert.ok(!other.unit.received.includes(CMD.REMOTE_UPGRADE));
  assert.equal(canUnlockVrx({ ...info, name: 'Ascent_VRX_Pro' }), false);
  assert.equal(canUnlockVrx({ ...info, firmware: 'Ascent_G_Gnd_19_0_0' }), true);
  assert.equal(canUnlockVrx({ ...info, firmware: 'Ascent_G_Gnd_4294967296_0_0' }), false);
  assert.equal(matchesVrxUnlocked({ ...info, firmware: 'Ascent_G_Gnd_0_0_0', sdk: '0.0.0' }, info), false);
});

test('rejected staging does not arm a selector; cancellation after arming completes reboot but never triggers firmware', async () => {
  const rejected = await receiver({ rejectStaging: true });
  await assert.rejects(flashFirmware(rejected.session, profile, rejected.image, { info: rejected.info, unlock: true }), /Staging request/);
  assert.equal(rejected.unit.starts.length, 1);
  assert.ok(!rejected.unit.received.includes(CMD.REBOOT));
  const r = await receiver();
  const abort = new AbortController();
  await assert.rejects(flashFirmware(r.session, profile, r.image, { info: r.info, unlock: true, signal: abort.signal,
    progress: (p) => { if (p.text.startsWith('Arming')) abort.abort(); } }), /Cancelled/);
  assert.equal(r.unit.mode, 'unlocked');
  assert.equal(r.unit.staged.size, 0);
  assert.equal(r.unit.starts.length, 2);
  assert.ok(!r.unit.received.includes(CMD.FILE_END));
});

test('script staging requires exact chunk lengths even when firmware allows zero-length acknowledgments', async () => {
  const { unit, session, info, image } = await receiver({ dataAckLength: 0 });
  const tolerant = { ...profile, transport: { ...profile.transport, allowZeroDataAckLength: true } };
  await assert.rejects(flashFirmware(session, tolerant, image, { info, unlock: true }), /rejected or miscounted chunk/);
  assert.equal(unit.starts.length, 1);
  assert.equal(unit.received.filter((c) => c === CMD.FILE_DATA).length, 1);
  assert.ok(!unit.received.includes(CMD.REBOOT));
  assert.ok(!unit.received.includes(CMD.FILE_END));
});

// Execute the actual generated shell with filesystem paths relocated into a
// sandbox. Mount and reboot are replaced with command stubs; no host mounts,
// receiver writes or physical I/O are performed.
async function shellRun({ mountFails = false, prepareFails = false, wrongCaller = false } = {}) {
  const plan = buildVrxUnlock('a'.repeat(32));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpvos-unlock-shell-'));
  for (const name of ['etc/init.d', 'factory', 'usrdata', 'tmp', 'bin']) fs.mkdirSync(path.join(root, name), { recursive: true });
  const local = (p) => root + p;
  const original = 'APP_VERSION=18.21.10\nBOARD_TYPE=Gnd485\nBUILD_TIME=202608141800\nCUSTOM=1\n';
  fs.writeFileSync(local('/etc/app.version'), original);
  fs.writeFileSync(local('/etc/app.version.original'), original);
  const trace = local('/tmp/trace');
  const command = (name, body) => fs.writeFileSync(local(`/bin/${name}`), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  command('id', 'echo 0');
  command('mount', `echo bind >>"$TRACE"; [ "$MOUNT_FAILS" != 1 ] || exit 1; cp "$2" "$3"`);
  command('umount', `echo unbind >>"$TRACE"; cp "$ORIGINAL" "$1"`);
  fs.writeFileSync(local('/etc/ota-prepare.sh'), 'echo prepare >>"$TRACE"\n[ "$1" = real_do ] || exit 2\n[ "$PREPARE_FAILS" != 1 ] || exit 3\nfor fd in /proc/$PPID/fd/*; do case "$(readlink "$fd")" in *"/usrdata/"*) exit 4;; esac; done\nexit 0\n');
  fs.writeFileSync(local('/etc/init.d/start_clean_system_fpv_upgrade.sh'), '[ "$1" = 1 ] || exit 5\necho "vendor-init:$(sed -n \'s/^APP_VERSION=//p\' "$VERSION")" >>"$TRACE"\n');
  fs.writeFileSync(local('/etc/sys_reboot.sh'), 'echo reboot >>"$TRACE"\n');
  const script = plan.script.replace(/\/(?:etc|usrdata|factory|tmp)(?=\/)/g, (p) => root + p);
  fs.writeFileSync(local(plan.remotePath), script);
  execFileSync('/bin/sh', ['-n', local(plan.remotePath)]);
  let status = 0;
  try {
    execFileSync('/bin/sh', ['-c', '. "$1"; echo BAD_RETURN >>"$TRACE"',
      wrongCaller ? 'unrelated-shell' : local('/etc/init.d/start_clean_system.sh'), local(plan.remotePath)], {
      env: { ...process.env, PATH: `${local('/bin')}:${process.env.PATH}`, TRACE: trace, VERSION: local('/etc/app.version'),
        ORIGINAL: local('/etc/app.version.original'), MOUNT_FAILS: mountFails ? '1' : '0', PREPARE_FAILS: prepareFails ? '1' : '0',
        upgrade_mode: 'web', flagfile: local('/factory/sirius-clean-system-flag') }, stdio: 'pipe',
    });
  } catch (e) { status = e.status; }
  await new Promise((r) => setTimeout(r, 50));
  return { status, original, version: fs.readFileSync(local('/etc/app.version'), 'utf8'),
    trace: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '', staged: fs.existsSync(local(plan.remotePath)) };
}

test('one-shot script execs from RAM, preserves metadata, overlays before vendor init and exits the sourcing shell', async () => {
  const r = await shellRun();
  assert.equal(r.status, 0);
  assert.equal(r.version, r.original.replace('18.21.10', '0.0.0'));
  assert.equal(r.trace, 'bind\nprepare\nvendor-init:0.0.0\n');
  assert.equal(r.staged, false);
});

test('script failure restores the version overlay and requests a normal recovery reboot; wrong callers cannot run it', async () => {
  for (const opts of [{ mountFails: true }, { prepareFails: true }]) {
    const r = await shellRun(opts);
    assert.equal(r.status, 1);
    assert.equal(r.version, r.original);
    assert.ok(r.trace.includes('reboot'));
    assert.ok(!r.trace.includes('vendor-init'));
  }
  const r = await shellRun({ wrongCaller: true });
  assert.equal(r.status, 1);
  assert.equal(r.version, r.original);
  assert.equal(r.trace, '');
});
