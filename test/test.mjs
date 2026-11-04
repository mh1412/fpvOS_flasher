// node --test test/test.mjs
// ASCENT_IMG=path/to/Ascent_H_Sky_*.img also checks a real image.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CMD, FrameParser, encodeFrame, crc32, md5hex,
  encodeFileStart,
} from '../transports/ascent.js';
import { parseAirImage } from '../devices/ascent-air.js';
import { firmwareVersion } from '../firmware.js';
import { openSimulatedDevice } from './sim.mjs';
import { airImage as asw } from './fixtures.mjs';
import { getProfile } from '../devices/index.js';
import { flashFirmware } from '../flasher.js';

// The packet enable_rndis.py sends (cmd 59, seq 0), known to work on the unit.
const RNDIS = Uint8Array.from([
  0x4F, 0x54, 0x52, 0x41, 0xDC, 0x0C, 0x01, 0x00, 0x00, 0x00, 0xCD, 0xAB,
  0x3B, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xA6, 0xEA, 0x7B, 0xE0,
]);

test('frame encoding matches the known RNDIS packet', () => {
  assert.deepEqual(encodeFrame({ cmd: CMD.NETWORK_MODE, seq: 0 }), RNDIS);
});

test('crc32 chains', () => {
  const a = randomBytes(1000), b = randomBytes(77);
  assert.equal(crc32(Buffer.concat([a, b])), crc32(b, crc32(a)));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('md5 matches node:crypto', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 1 << 20, (1 << 20) + 3]) {
    const b = randomBytes(n);
    assert.equal(md5hex(new Uint8Array(b)), createHash('md5').update(b).digest('hex'), `size ${n}`);
  }
});

test('parser: junk, split reads, back-to-back frames, bad length, bad crc', () => {
  const a = encodeFrame({ cmd: 60, seq: 7, payload: Uint8Array.of(1, 2, 3), type: 2 });
  const b = encodeFrame({ cmd: 116, seq: 8, payload: new Uint8Array(80), type: 2 });
  const bogus = encodeFrame({ cmd: 1, seq: 1 });
  new DataView(bogus.buffer).setUint32(20, 0x7fffffff, true);   // absurd length
  const bad = encodeFrame({ cmd: 118, seq: 9, payload: Uint8Array.of(9), type: 2 });
  bad[36] ^= 0xff;
  const stream = Buffer.concat([Buffer.from('unkonwn cmd\n'), bogus.subarray(0, 36), a, b, Buffer.from('xx'), bad]);

  const p = new FrameParser();
  const got = [];
  for (const byte of stream) got.push(...p.push(Uint8Array.of(byte)));
  assert.deepEqual(got.map((f) => [f.cmd, f.seq, f.crcOk]), [[60, 7, true], [116, 8, true], [118, 9, false]]);
  assert.deepEqual([...got[0].payload], [1, 2, 3]);

  const p2 = new FrameParser();
  assert.equal(p2.push(Buffer.concat([a, b])).length, 2);
});

test('file start payload layout', () => {
  const p = encodeFileStart({ md5hex: 'ab'.repeat(16), length: 1234, remotePath: '/tmp/pc/x.img', localPath: '/h/x.img' });
  assert.equal(p.length, 328);
  const v = new DataView(p.buffer);
  assert.equal(Buffer.from(p.subarray(0, 32)).toString(), 'ab'.repeat(16));
  assert.equal(p[32], 0);
  assert.equal(v.getInt32(64, true), 1234);
  assert.equal(v.getInt32(68, true), 1);
  assert.equal(Buffer.from(p.subarray(72, 85)).toString(), '/tmp/pc/x.img');
  assert.equal(Buffer.from(p.subarray(200, 208)).toString(), '/h/x.img');
});

test('firmware version from the device string', () => {
  assert.deepEqual(firmwareVersion('Ascent_H_Sky_18_21_10'), [18, 21, 10]);
  assert.equal(firmwareVersion('FPV-Ascent-Sky-482-V18.21-10.3'), null);
});

// ----------------------------------------------------------------- images --

test('asw: good, damaged, truncated, ground, odd names', () => {
  const good = parseAirImage(asw(), 'Ascent_H_Sky_18_21_10.img');
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.warnings, []);
  assert.equal(good.remoteName, 'Ascent_H_Sky_18_21_10.img');
  assert.deepEqual(good.sections.map((s) => [s.name, s.length]), [['boot', 0x100], ['env', 0x80], ['kernel', 0x200], ['rootfs', 0x300], ['fpv', 0x400]]);

  const dmg = asw();
  dmg[0x500] ^= 1;
  assert.match(parseAirImage(dmg).errors.join(), /Checksum/);
  assert.match(parseAirImage(asw().subarray(0, 0x400)).errors.join(), /truncated/);
  assert.match(parseAirImage(asw([17, 5, 8], 5)).errors.join(), /Ascent VRX \(G_Gnd\), not an H_Sky air unit/);
  assert.match(parseAirImage(new Uint8Array(200)).errors.join(), /ASW/);

  const renamed = parseAirImage(asw(), 'Ascent_H_Sky_18_21_10 (1).img');
  assert.match(renamed.warnings.join(), /no version/);
  assert.equal(renamed.remoteName, 'Ascent_H_Sky_18_21_10.img');
  assert.match(parseAirImage(asw(), 'Ascent_H_Sky_18_21_9.img').warnings.join(), /says 18.21.9/);
});

const realImage = process.env.ASCENT_IMG;

test('asw: a real image', { skip: realImage && existsSync(realImage) ? false : 'set ASCENT_IMG' }, () => {
  const r = parseAirImage(new Uint8Array(readFileSync(realImage)), path.basename(realImage));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.sections.map((s) => s.name), ['boot', 'env', 'kernel', 'rootfs', 'fpv']);
});

// ------------------------------------------------------------------ flash --

async function simFlash(opts = {}, image = asw()) {
  const logs = [];
  const profile = getProfile('ascent-air');
  const { unit, session, info } = await openSimulatedDevice(profile, opts, (m, l = 'info') => logs.push(`${l} ${m}`));
  const stages = [];
  const parsed = parseAirImage(image, 'x.img');
  parsed.profileId = profile.meta.id;
  info.maxChunk = opts.chunk ?? 0x180;
  const after = await flashFirmware(session, profile, {
    bytes: image, md5: md5hex(image), parsed,
  }, { info, progress: (p) => stages.push(p.stage), log: (m, l = 'info') => logs.push(`${l} ${m}`), dataTimeoutMs: 500 });
  return { unit, info, after, stages, logs };
}

test('flash against the simulated unit', async () => {
  const img = asw();
  const { unit, info, after, stages } = await simFlash({}, img);
  assert.equal(info.firmware, 'Ascent_H_Sky_18_21_10');
  assert.equal(info.maxChunk, 0x180);
  assert.deepEqual(Buffer.compare(unit.file.data, Buffer.from(img)), 0);
  assert.equal(unit.file.path, '/tmp/pc/Ascent_H_Sky_18_21_10.img');
  assert.equal(unit.file.md5, createHash('md5').update(img).digest('hex'));
  assert.equal(after.firmware, 'Ascent_H_Sky_18_21_10');
  assert.deepEqual([...new Set(stages)], ['clean', 'upload', 'install', 'restart', 'done']);
  const order = unit.received.filter((c) => c !== CMD.UPGRADE_STATUS && c !== CMD.FILE_DATA);
  assert.deepEqual(order, [CMD.FIND_DEVICE, CMD.REBOOT, CMD.FIND_DEVICE, CMD.REMOTE_UPGRADE, CMD.FILE_START, CMD.FILE_END, CMD.FIND_DEVICE]);
});

test('air flash accepts zero-length acknowledgments with exact counters across 1 MiB and partial chunks', async () => {
  const img = asw();
  const big = new Uint8Array(3.5 * (1 << 20));
  big.set(img);
  const v = new DataView(big.buffer);
  // grow the last section to the new end of file and fix the header
  v.setUint32(0x74, big.length, true);
  v.setUint32(0x70, crc32(big.subarray(0x80)), true);
  assert.deepEqual(parseAirImage(big).errors, []);
  const { unit } = await simFlash({ chunk: 1 << 20, dataAckLength: 0 }, big);
  assert.equal(Buffer.compare(unit.file.data, Buffer.from(big)), 0);
  assert.equal(unit.file.chunks.length, 4);
});

test('flash survives lost replies, junk and split reads', async () => {
  const { unit, logs } = await simFlash({
    dropReply: new Set([CMD.REMOTE_UPGRADE, CMD.FILE_START, CMD.UPGRADE_STATUS]), junk: true, split: 7,
  });
  assert.equal(unit.file.data.length, unit.file.length);
  assert.ok(logs.some((l) => /sending it again/.test(l)));
});

test('flash: a lost data ack fails instead of sending the chunk twice', async () => {
  await assert.rejects(simFlash({ dropReply: new Set([CMD.FILE_DATA]) }), /did not answer FILE_DATA/);
});

test('flash: md5 rejected by the unit', async () => {
  await assert.rejects(simFlash({ badMd5: true }), /rejected the file: md5 check fail/);
});
