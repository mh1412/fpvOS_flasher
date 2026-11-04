import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseVrx, verifyDigestTail } from '../devices/ascent-vrx.js';
import { getProfile, profileForDevice, profileForUsb, profileForImage } from '../devices/index.js';
import { prepareFirmware, evaluateSelection, flashFirmware } from '../flasher.js';
import { CMD, md5hex } from '../transports/ascent.js';
import { openSimulatedDevice } from './sim.mjs';
import { airImage, vrxImage, signVrx, TEST_VRX_KEY, VRX_TABLE, VRX_SEGMENTS, storedZip } from './fixtures.mjs';

const air = getProfile('ascent-air'), vrx = getProfile('ascent-vrx');
const airInfo = { name: 'Ascent_H_Sky', firmware: 'Ascent_H_Sky_18_21_10' };
const vrxInfo = { name: 'Ascent_VRX', firmware: 'Ascent_G_Gnd_17_5_3', hardware: 'FPV-Ascent-Gnd-485-V1.2-1.0' };
const airCleanInfo = { name: 'Ascent', firmware: 'Ascent_H_Sky_17_5_3', hardware: 'FPV-Edu-Sky-V0.0-0.0',
  serial: '', sdk: '', cpuTemp: 0, status: 0, detail: 'OK' };
const airLegacyInfo = { ...airInfo, firmware: airCleanInfo.firmware, hardware: 'FPV-Ascent-Sky-482-V1.3-1.0', serial: 'AIR0001' };
const airLiteInfo = { ...airInfo, name: 'Ascent_lite', hardware: 'FPV-Ascent-Sky-482-V1.3-1.1', serial: '1_AIR0001' };
const parse = (bytes) => parseVrx(bytes, 'Ascent_G_Gnd_17_5_8.img', { publicKey: TEST_VRX_KEY });

test('profiles identify standard VRX and air units, never Pro, Avatar or conflicting USB/model identities', () => {
  assert.equal(profileForDevice(airInfo, air.meta.usb[0]), air);
  assert.equal(profileForDevice(vrxInfo, vrx.meta.usb[0]), vrx);
  assert.equal(profileForUsb({ usbVendorId: 0x1d75, usbProductId: 0x0101 }), vrx);
  for (const name of ['Ascent_VRX_Pro', 'cx485_pro', 'Avatar VRX', 'Ascent_Goggles', '', 'unknown']) {
    assert.equal(profileForDevice({ ...vrxInfo, name }), null, name);
  }
  assert.equal(profileForDevice(vrxInfo, air.meta.usb[0]), null);
  assert.equal(profileForDevice({ ...vrxInfo, firmware: airInfo.firmware }), null);
  assert.equal(profileForUsb({ usbVendorId: 0x1d75, usbProductId: 2 }), null);
});

test('air clean identity is accepted only after a matching normal-mode connection', () => {
  const before = { ...airInfo, firmware: airCleanInfo.firmware, serial: 'AIR0001', hardware: 'HW_V1.0' };
  assert.equal(profileForDevice(airCleanInfo, air.meta.usb[0]), null);
  assert.equal(air.meta.identity.normalMatches(airCleanInfo, before), false);
  assert.equal(air.meta.identity.updateMatches(airCleanInfo, before, 'clean'), true);
  assert.equal(air.meta.identity.updateMatches({ ...airCleanInfo, detail: '' }, before, 'clean'), true);
  for (const phase of ['normal', 'unlock']) assert.equal(air.meta.identity.updateMatches(airCleanInfo, before, phase), false);
  for (const change of [{ name: 'Ascent_VRX' }, { serial: 'OTHER' }, { hardware: 'FPV-Ascent-Gnd-485-V0.0-0.0' },
    { firmware: 'Ascent_H_Sky_17_5_8' }, { firmware: 'Ascent_G_Gnd_17_5_3' }, { status: -1 }, { detail: 'error' }]) {
    assert.equal(air.meta.identity.updateMatches({ ...airCleanInfo, ...change }, before, 'clean'), false);
  }
  assert.equal(air.meta.identity.updateMatches(airCleanInfo, { ...before, name: 'Ascent' }, 'clean'), false);
});

test('air clean placeholder permits upload but cannot pass postflash factory verification', async () => {
  const image = await prepareFirmware(new File([airImage([17, 5, 8])], 'Ascent_H_Sky_17_5_8.img'), { profile: air });
  for (const retainPlaceholder of [false, true]) {
    const { unit, link, session, info } = await openSimulatedDevice(air, { firmware: airCleanInfo.firmware, cleanInfo: airCleanInfo });
    const result = flashFirmware(session, air, image, { info, usbInfo: air.meta.usb[0], progress: ({ stage }) => {
      if (retainPlaceholder && stage === 'restart') Object.assign(unit.opts, { name: airCleanInfo.name, hardware: airCleanInfo.hardware, serial: '' });
    } });
    if (retainPlaceholder) {
      await assert.rejects(result, /reconnected device/);
      assert.equal(link.isOpen, false);
    } else {
      const after = await result;
      assert.equal(after.firmware, 'Ascent_H_Sky_17_5_8');
      assert.equal(after.serial, info.serial);
      assert.equal(after.hardware, info.hardware);
      assert.deepEqual(unit.file.data, Buffer.from(image.bytes));
    }
    assert.ok(unit.received.includes(CMD.FILE_END));
  }
});

test('air factory identity accepts only the known H_Sky/Lite presentation changes', () => {
  const matches = air.meta.identity.normalMatches;
  assert.equal(matches(airLiteInfo, airLegacyInfo), true);
  assert.equal(matches(airLegacyInfo, airLiteInfo), true);
  assert.equal(matches({ ...airLiteInfo, hardware: airLegacyInfo.hardware }, airLegacyInfo), true);
  assert.equal(matches({ ...airLiteInfo, serial: airLegacyInfo.serial }, airLegacyInfo), true);
  for (const change of [{ name: 'Ascent' }, { name: 'Ascent_VRX' }, { serial: '1_OTHER' }, { serial: '2_AIR0001' },
    { hardware: 'FPV-Ascent-Sky-492-V1.3-1.1' }, { hardware: 'FPV-Ascent-Sky-482-V1.4-1.1' },
    { hardware: 'FPV-Ascent-Sky-482-V1.3-2.1' }, { hardware: 'FPV-Ascent-Sky-482-V1.3-1.2' }, { hardware: '' }, { serial: '' }]) {
    assert.equal(matches({ ...airLiteInfo, ...change }, airLegacyInfo), false);
  }
  assert.equal(matches({ ...airLiteInfo, hardware: 'HW_V1.0' }, { ...airLegacyInfo, hardware: 'HW_V1.0' }), false);
});

test('air postflash accepts the Lite identity presentation after an H_Sky upgrade', async () => {
  const image = await prepareFirmware(new File([airImage()], 'Ascent_H_Sky_18_21_10.img'), { profile: air });
  const { unit, session, info } = await openSimulatedDevice(air, { ...airLegacyInfo, cleanInfo: airCleanInfo, dataAckLength: 0 });
  const after = await flashFirmware(session, air, image, { info, progress: ({ stage }) => {
    if (stage === 'restart') Object.assign(unit.opts, airLiteInfo);
  } });
  assert.equal(after.name, airLiteInfo.name);
  assert.equal(after.serial, airLiteInfo.serial);
  assert.equal(after.hardware, airLiteInfo.hardware);
  assert.equal(after.firmware, 'Ascent_H_Sky_18_21_10');
});

test('air zero-length acknowledgments still reject failed writes and incorrect counts without retrying', async () => {
  const image = await prepareFirmware(new File([airImage()], 'Ascent_H_Sky_18_21_10.img'), { profile: air });
  for (const opts of [{ dataAckLength: 0, rejectData: true }, { dataAckLength: 0, badDataCount: true },
    { dataAckLength: 0, badDataTotal: true }, { dataAckLength: 1 }]) {
    const { unit, link, session, info } = await openSimulatedDevice(air, opts);
    await assert.rejects(flashFirmware(session, air, image, { info }), (e) => {
      assert.match(e.message, /rejected or miscounted chunk/);
      assert.match(e.message, /status -?\d+/);
      assert.match(e.message, /length \d+, expected/);
      assert.match(e.message, /received \d+\/\d+, expected/);
      return true;
    });
    assert.equal(unit.received.filter((c) => c === CMD.FILE_DATA).length, 1);
    assert.ok(!unit.received.includes(CMD.FILE_END));
    assert.equal(link.isOpen, false);
  }
});

test('profile content recognition selects its own validator independently of filenames', async () => {
  assert.equal(profileForImage(airImage()), air);
  assert.equal(profileForImage(vrxImage()), vrx);
  assert.equal(profileForImage(new Uint8Array(0x80)), null);
  assert.equal(profileForImage(airImage([17, 5, 8], 1)), null);
  const renamed = await prepareFirmware(new File([airImage()], 'Ascent_G_Gnd_17_5_8.img'));
  assert.equal(renamed.parsed.profileId, air.meta.id);
  assert.equal(renamed.parsed.remoteName, 'Ascent_H_Sky_18_21_10.img');
  assert.ok(renamed.md5);
  assert.ok(evaluateSelection({ info: vrxInfo, profile: vrx, image: renamed }).issues.some((c) => c.level === 'error'));
});

test('VRX parses modern ground layout and verifies synthetic SHA/RSA against its test key', async () => {
  const bytes = vrxImage(), r = await parse(bytes);
  assert.deepEqual(r.errors, []);
  assert.equal(r.remoteName, 'Ascent_G_Gnd_17_5_8.img');
  assert.ok(r.hashOk && r.signatureOk);
  assert.equal(r.crcStored, undefined);
  assert.deepEqual(r.sections.map((s) => [s.name, s.upgrade]), [['kernel', true], ['userapp0', true], ['userapp1', false]]);
  assert.equal(r.segments.length, 3);
  assert.match((await parseVrx(bytes)).errors.join(), /RSA signature/); // test key is not a production trust key
});

test('VRX catches corruption, refreshed digest without signature, and wrong format', async () => {
  const bytes = vrxImage();
  bytes[bytes.length - 1] ^= 1;
  let r = await parse(bytes);
  assert.ok(!r.hashOk && !r.signatureOk);
  bytes.set(createHash('sha256').update(bytes.subarray(0x2a0)).digest(), 0x180);
  r = await parse(bytes);
  assert.ok(r.hashOk && !r.signatureOk);
  assert.match(r.errors.join(), /RSA/);
  for (const offset of [0x80, 0x84, 0x86, 0x87, 0x8a, 0x8c]) {
    const bad = vrxImage(); bad[offset] ^= 1;
    assert.match((await parse(bad)).errors.join(), /OTRA format/);
  }
  assert.match((await parse(vrxImage().subarray(0, 0x200))).errors.join(), /truncated/);
  assert.match((await parse(airImage())).errors.join(), /board 5|OTRA/);
});

test('VRX rejects malformed tables, unsafe 64-bit offsets, file/flash overflow and overlapping segments even when signed', async () => {
  const mutations = [
    [(v) => v.setBigUint64(0x90, 1n, true), /body size/],
    [(v) => v.setUint16(0xa0, 129, true), /tables/],
    [(v) => v.setUint16(0xa2, 0xffff, true), /tables/],
    [(v) => v.setBigUint64(VRX_TABLE + 40, 1n << 30n, true), /NAND bounds/],
    [(v) => v.setBigUint64(VRX_SEGMENTS, 1n << 60n, true), /supported range/],
    [(v) => v.setBigUint64(VRX_SEGMENTS, 0n, true), /outside the file/],
    [(v) => v.setBigUint64(VRX_SEGMENTS + 24, 0x200000n, true), /NAND partition/],
    [(v) => v.setBigUint64(VRX_SEGMENTS + 32, v.getBigUint64(VRX_SEGMENTS, true), true), /overlaps/],
  ];
  for (const [mutate, expected] of mutations) {
    const bytes = vrxImage(); mutate(new DataView(bytes.buffer)); signVrx(bytes);
    assert.match((await parse(bytes)).errors.join(), expected);
  }
  assert.equal(verifyDigestTail(new Uint8Array(256).fill(255), new Uint8Array(32)), false);
});

test('shared compatibility checks block cross-profile images and unrecognized devices', () => {
  const image = { parsed: { profileId: vrx.meta.id, version: [17, 5, 8], versionText: '17.5.8', errors: [] } };
  assert.deepEqual(evaluateSelection({ info: vrxInfo, profile: vrx, image }).issues, []);
  assert.match(evaluateSelection({ info: airInfo, profile: air, image }).issues[0].text, /not Ascent Lite/);
  assert.match(evaluateSelection({ info: vrxInfo, profile: null, image, selectedProfile: vrx }).issues[0].text, /Unsupported device/);
  assert.match(evaluateSelection({ info: vrxInfo, profile: vrx, image, selectedProfile: air }).issues[0].text, /selected profile/);
  assert.equal(evaluateSelection({ info: { ...vrxInfo, firmware: 'Ascent_G_Gnd_18_21_10' }, profile: vrx, image }).issues[0].level, 'warn');
});

test('automatic unlock is recommended only for valid matching downgrades on eligible hardware, including future versions', () => {
  const info = { ...vrxInfo, serial: 'AUTO001', status: 0, detail: 'OK', firmware: 'Ascent_G_Gnd_18_21_10' };
  const image = { profileId: vrx.meta.id, version: [17, 5, 8], errors: [] };
  const recommended = (device, p, parsed) => evaluateSelection({ info: device, profile: p, image: { parsed } }).automaticUnlock;
  assert.equal(recommended(info, vrx, image), true);
  assert.equal(recommended({ ...info, firmware: 'Ascent_G_Gnd_19_0_0' }, vrx, image), true);
  assert.equal(recommended({ ...info, firmware: 'Ascent_G_Gnd_18_9_10' }, vrx, { ...image, version: [18, 10, 0] }), false);
  for (const version of [[18, 21, 10], [18, 21, 11], [19, 0, 0]]) {
    assert.equal(recommended(info, vrx, { ...image, version }), false);
  }
  assert.equal(recommended(info, vrx, { ...image, errors: ['bad signature'] }), false);
  assert.equal(recommended(info, vrx, { ...image, profileId: air.meta.id }), false);
  assert.equal(recommended({ ...info, serial: '' }, vrx, image), false);
  assert.equal(recommended(airInfo, air, image), false);
  assert.equal(recommended(null, null, image), false);
});

test('archive selection is hardware-scoped; ambiguous offline vendor bundles require a profile', async () => {
  const zip = new File([storedZip([
    ['Ascent_H_Sky_18_21_10.img', airImage()],
    ['Ascent_G_Gnd_17_5_8.img', vrxImage()],
  ])], 'vendor.zip');
  await assert.rejects(prepareFirmware(zip), /different hardware/);
  const a = await prepareFirmware(zip, { profile: air });
  assert.equal(a.parsed.profileId, air.meta.id);
  assert.ok(a.md5);
  const g = await prepareFirmware(zip, { profile: vrx });
  assert.equal(g.name, 'Ascent_G_Gnd_17_5_8.img');
  assert.equal(g.parsed.profileId, vrx.meta.id);
  assert.equal(g.md5, null); // synthetic signing key is not trusted by standard VRX
});

async function simulatedVrx(opts = {}) {
  const receiver = await openSimulatedDevice(vrx, { ...vrxInfo, ...opts });
  const bytes = vrxImage(), parsed = await parse(bytes);
  parsed.profileId = vrx.meta.id;
  return { ...receiver, image: { bytes, parsed, md5: md5hex(bytes) } };
}

test('VRX profile runs sequential stages and flashes unchanged bytes under canonical G_Gnd name', async () => {
  const { unit, session, info, image } = await simulatedVrx();
  const stages = [];
  const order = [];
  const traced = { ...vrx, stages: Object.fromEntries(Object.entries(vrx.stages).map(([phase, steps]) => [phase,
    steps.map((step) => async (ctx) => { order.push(phase); await step(ctx); })])) };
  const after = await flashFirmware(session, traced, image, { info, usbInfo: vrx.meta.usb[0], progress: (p) => stages.push(p.stage) });
  assert.equal(after.name, 'Ascent_VRX');
  assert.equal(unit.file.path, '/tmp/pc/Ascent_G_Gnd_17_5_8.img');
  assert.deepEqual(unit.file.data, Buffer.from(image.bytes));
  assert.deepEqual([...new Set(stages)], ['clean', 'upload', 'install', 'restart', 'done']);
  assert.equal(unit.received.filter((c) => c === CMD.FIND_DEVICE).length, 3);
  assert.deepEqual(order, [...Array(vrx.stages.preflash.length).fill('preflash'),
    ...Array(vrx.stages.flash.length).fill('flash'), ...Array(vrx.stages.postflash.length).fill('postflash')]);
});

test('VRX profile verifies identity after clean reboot before any upload', async () => {
  for (const cleanInfo of [{ serial: 'OTHER' }, { name: 'Ascent_H_Sky' }, { firmware: 'Ascent_H_Sky_17_5_3' }]) {
    const { unit, session, info, image } = await simulatedVrx({ cleanInfo });
    await assert.rejects(flashFirmware(session, vrx, image, { info }), /reconnected device/);
    assert.ok(!unit.received.includes(CMD.FILE_START));
  }
});

test('VRX accepts only the documented healthy clean-mode placeholder and requires full normal identity afterward', async () => {
  const clean = { ...vrxInfo, serial: '', hardware: 'FPV-Ascent-Gnd-485-V0.0-0.0', status: 0, detail: 'OK' };
  const before = { ...vrxInfo, serial: 'SIM0001' };
  assert.equal(vrx.meta.identity.updateMatches(clean, before, 'clean'), true);
  assert.equal(vrx.meta.identity.updateMatches(clean, before, 'normal'), false);
  for (const change of [{ serial: 'OTHER' }, { hardware: 'FPV-Ascent-Gnd-486-V0.0-0.0' },
    { name: 'Ascent_VRX_Pro' }, { firmware: 'Ascent_G_Gnd_16_5_7' }, { status: -1 }, { detail: 'error' }]) {
    assert.equal(vrx.meta.identity.updateMatches({ ...clean, ...change }, before, 'clean'), false);
  }
  const { session, info, image, unit } = await simulatedVrx({ cleanInfo: clean });
  const after = await flashFirmware(session, vrx, image, { info });
  assert.equal(after.serial, info.serial);
  assert.ok(unit.received.includes(CMD.FILE_END));
});

test('VRX rejects bad data status/counts and profile mismatches', async () => {
  for (const opts of [{ rejectData: true }, { badDataCount: true }, { badDataTotal: true }, { dataAckLength: 0 }]) {
    const { unit, session, info, image } = await simulatedVrx(opts);
    await assert.rejects(flashFirmware(session, vrx, image, { info }), /rejected or miscounted chunk/);
    assert.ok(!unit.received.includes(CMD.FILE_END));
  }
  const { unit, session, image } = await simulatedVrx();
  await assert.rejects(flashFirmware(session, vrx, image, { info: airInfo }), /matching connected/);
  assert.ok(!unit.received.includes(CMD.REBOOT));
});

test('cancellation before a flash or after its last chunk never sends the update trigger', async () => {
  for (const before of [true, false]) {
    const { unit, session, info, image } = await simulatedVrx();
    const controller = new AbortController();
    if (before) controller.abort();
    await assert.rejects(flashFirmware(session, vrx, image, {
      info, signal: controller.signal,
      progress: (p) => { if (p.stage === 'upload' && p.text.endsWith('(100%)')) controller.abort(); },
    }), /Cancelled/);
    assert.ok(!unit.received.includes(CMD.FILE_END));
    if (before) assert.ok(!unit.received.includes(CMD.REBOOT));
  }
});

test('negative update status fails immediately even with empty detail or completion percent', async () => {
  for (const installPercent of [0, 100]) {
    const { unit, session, info, image } = await simulatedVrx({ installStatus: -6, installDetail: '', installPercent });
    await assert.rejects(flashFirmware(session, vrx, image, { info }), /update failure \(status -6\)/);
    assert.equal(unit.received.filter((c) => c === CMD.UPGRADE_STATUS).length, 1);
  }
});

test('missing preflash verification prevents any firmware upload', async () => {
  const missing = await simulatedVrx();
  const noVerify = { ...vrx, stages: { ...vrx.stages, preflash: vrx.stages.preflash.slice(0, 1) } };
  await assert.rejects(flashFirmware(missing.session, noVerify, missing.image, { info: missing.info }), /did not verify/);
  assert.ok(!missing.unit.received.includes(CMD.FILE_START));
});

test('cancellation after FileEnd begins cannot skip install monitoring or postflash verification', async () => {
  const r = await simulatedVrx();
  const abort = new AbortController();
  const after = await flashFirmware(r.session, vrx, r.image, { info: r.info, signal: abort.signal,
    progress: (p) => { if (p.text === 'Unit is checking the file') abort.abort(); } });
  assert.equal(after.firmware, 'Ascent_G_Gnd_17_5_8');
  assert.ok(r.unit.received.includes(CMD.UPGRADE_STATUS));
});

test('postflash requires the requested firmware version, not just matching factory identity', async () => {
  const r = await simulatedVrx({ installFirmware: false });
  await assert.rejects(flashFirmware(r.session, vrx, r.image, { info: r.info }), /Installed firmware does not match/);
  assert.equal(r.link.isOpen, false);
});

test('standard VRX stock reference passes production profile and trust key', { skip: !process.env.VRX_IMG && 'set VRX_IMG' }, async () => {
  const file = process.env.VRX_IMG;
  const r = await prepareFirmware(new File([readFileSync(file)], path.basename(file)), { profile: vrx });
  assert.deepEqual(r.parsed.errors, []);
  assert.ok(r.parsed.signatureOk && r.parsed.hashOk);
  assert.equal(r.parsed.remoteName, 'Ascent_G_Gnd_17_5_8.img');
  assert.equal(r.md5, '4996760841a1bcd0332dea3b7e157542');
  assert.equal(r.parsed.sections.length, 14);
  assert.equal(r.parsed.segments.length, 20);
});
