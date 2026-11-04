import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseFpvosBundle, FPVOS_AR9311, matchesFpvosAr9311 } from '../devices/fpvos-ar9311.js';
import { prepareFirmware, evaluateSelection, flashFirmware } from '../flasher.js';
import { profileForDevice, getProfile } from '../devices/index.js';
import { CMD, crc32, Session, encodeFrame, TimeoutError } from '../transports/ascent.js';
import { storedZip } from './fixtures.mjs';
import { FPVOS_P1_AIR, parseP1Bundle } from '../devices/fpvos-p1-air.js';
import { WebSerialLink } from '../transports/web-serial.js';
import { FPVOS_REBOOT_VERIFY } from '../stages/fpvos.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function bundle(kind = 0, board = 485) {
  const payloads = kind === 0 ? [Buffer.from('kernel'), Buffer.from('dtb'), Buffer.from('root')]
    : [Buffer.alloc(0x600000), Buffer.alloc(0x60000)];
  const h = Buffer.alloc(512);
  h.write('FPVOSUP1');
  [1, board, 512 + payloads.reduce((n, p) => n + p.length, 0), payloads.length].forEach((n, i) => h.writeUInt32LE(n, 8 + i * 4));
  h.write('development', 24); h.writeUInt32LE(kind, 88);
  payloads.forEach((p, i) => {
    const o = 96 + 104 * i;
    h.write((board === 485 ? ['kernel.img', 'ascent-gnd485.dtb', 'rootfs.cpio.uboot']
      : ['kernel.img', 'betafpv-p1-air.dtb', 'rootfs.cpio.gz'])[i], o);
    h.writeUInt32LE(p.length, o + 32); h.write(sha(p), o + 36);
  });
  h.writeUInt32LE(crc32(h), 508);
  return Buffer.concat([h, ...payloads]);
}
function fixHeader(b) { b.fill(0, 508, 512); b.writeUInt32LE(crc32(b.subarray(0, 512)), 508); return b; }
const info = { name: 'fpvOS updater', hardware: 'Gnd485', serial: 'fpvos-ar9311', status: 0, maxChunk: 1024,
  firmware: 'fpvOS unsigned development updates', detail: 'clean RAM mode' };
const p1Info = { ...info, hardware: 'P1_SKY', serial: 'fpvos-p1-air' };

test('P1 board contents select its profile regardless of filename, with shared USB IDs', async () => {
  const image = await prepareFirmware(new File([bundle(0, 1345409867)], 'renamed-vrx.fwu'));
  assert.equal(image.parsed.profileId, 'fpvos-p1-air');
  assert.deepEqual(image.parsed.errors, []);
  assert.equal(profileForDevice(p1Info, FPVOS_AR9311.meta.usb[0]), FPVOS_P1_AIR);
  assert.equal(profileForDevice(info, FPVOS_P1_AIR.meta.usb[0]), FPVOS_AR9311);
  assert.equal(evaluateSelection({ info: p1Info, profile: FPVOS_P1_AIR, image }).canFlash, true);
  assert.equal(evaluateSelection({ info, profile: FPVOS_AR9311, image }).canFlash, false);
  for (const change of [{ hardware: 'Gnd485' }, { serial: 'fpvos-ar9311' }, { name: 'P1_SKY' }, { status: -1 }]) {
    assert.equal(profileForDevice({ ...p1Info, ...change }), null);
  }
  assert.ok((await parseFpvosBundle(image.bytes)).errors.length);
  assert.ok((await parseP1Bundle(bundle())).errors.length);
  const zipped = await prepareFirmware(new File([storedZip([['release/p1.fwu', image.bytes]])], 'p1.zip'));
  assert.equal(zipped.parsed.profileId, 'fpvos-p1-air');
  const mixed = new File([storedZip([['p1.fwu', image.bytes], ['vrx.fwu', bundle()]])], 'mixed.zip');
  await assert.rejects(prepareFirmware(mixed, { profile: FPVOS_P1_AIR }), /multiple/);
});

test('P1 rejects restore/root-only bundles, VRX component names, corruption and P1 capacity overflow', async () => {
  for (const edit of [
    (b) => b.writeUInt32LE(1, 88), (b) => b.writeUInt32LE(2, 88),
    (b) => b.writeUInt32LE(2, 20), (b) => b.write('ascent-gnd485.dtb', 200),
    (b) => b.write('rootfs.cpio.uboot', 304), (b) => b.writeUInt32LE(65537, 232),
    (b) => b.writeUInt32LE(8388609, 336), (b) => b.writeUInt32LE(6291457, 128),
    (b) => b[512] ^= 1, (b) => b[92] = 1,
  ]) {
    const b = bundle(0, 1345409867); edit(b);
    assert.ok((await parseP1Bundle(fixHeader(b))).errors.length);
  }
});

test('P1 installs once and verifies postboot hash; a VRX recovery identity never receives a bundle', async () => {
  const image = await prepareFirmware(new File([bundle(0, 1345409867)], 'p1.fwu'));
  for (const opts of [{}, { lostEnd: true }, { wrongHash: true }, { cleanInfo: info }]) {
    const session = fakeSession(image, { unitInfo: p1Info, ...opts });
    const result = flashFirmware(session, FPVOS_P1_AIR, image, { info: p1Info });
    if (opts.wrongHash || opts.cleanInfo) await assert.rejects(result, /SHA-256|identity/);
    else assert.equal((await result).firmware, image.parsed.sha256);
    assert.equal(session.calls.filter((c) => c === CMD.FILE_START).length, opts.cleanInfo ? 0 : 1);
    assert.equal(session.calls.filter((c) => c === CMD.FILE_END).length, opts.cleanInfo ? 0 : 1);
  }
});

test('shared USB reconnect rejects the other board before allowing further commands', async () => {
  const original = globalThis.navigator;
  const old = { getInfo: () => FPVOS_P1_AIR.meta.usb[0] };
  const wrong = { getInfo: old.getInfo, identity: info };
  const right = { getInfo: old.getInfo, identity: p1Info };
  let ports = [wrong];
  const opened = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serial: { getPorts: async () => ports } } });
  try {
    const link = new WebSerialLink(old);
    link.open = async () => { opened.push(link.port); };
    link.close = async () => { if (link.port === wrong) ports = [right]; };
    await link.reopen({ timeoutMs: 3000, acceptDevice: async () => FPVOS_P1_AIR.meta.identity.matches(link.port.identity) });
    assert.deepEqual(opened, [wrong, right]);
    assert.equal(link.port, right);
  } finally { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: original }); }
});

test('shared USB reconnect prefers the original port and does not guess among other units', async () => {
  const original = globalThis.navigator;
  const first = {}, second = {}, stale = {};
  for (const p of [first, second, stale]) p.getInfo = () => FPVOS_P1_AIR.meta.usb[0];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serial: { getPorts: async () => [first, second] } } });
  try {
    for (const current of [second, stale]) {
      const link = new WebSerialLink(current);
      const opened = [];
      link.open = async () => { opened.push(link.port); };
      link.close = async () => {};
      const result = link.reopen({ timeoutMs: 10 });
      if (current === stale) { await assert.rejects(result, /did not come back/); assert.deepEqual(opened, []); }
      else { await result; assert.deepEqual(opened, [second]); }
    }
  } finally { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: original }); }
});

test('AR9311 bundles validate lengths, ordered components, CRC and SHA without signatures or version ordering', async () => {
  for (const kind of [0, 1]) {
    const b = bundle(kind), parsed = await parseFpvosBundle(b);
    assert.deepEqual(parsed.errors, []); assert.equal(parsed.sha256, sha(b)); assert.equal(parsed.kind, kind);
    const image = await prepareFirmware(new File([b], 'renamed.fwu'));
    assert.equal(image.parsed.profileId, 'fpvos-ar9311');
    assert.equal(evaluateSelection({ info, profile: FPVOS_AR9311, image }).canFlash, true);
  }
});

test('bundle parser rejects corruption, other boards, root-only policy, malformed manifests and trailing bytes', async () => {
  const cases = [Buffer.alloc(8), bundle().subarray(0, 511), Buffer.concat([bundle(), Buffer.of(1)])];
  for (const edit of [(b) => b[512] ^= 1, (b) => b.writeUInt32LE(486, 12), (b) => b.writeUInt32LE(1, 20),
    (b) => b.writeUInt32LE(2, 88), (b) => b[92] = 1, (b) => b[196] = 1,
    (b) => b.writeUInt32LE(0xffffffff, 128), (b) => b.write('rootfs.ubi', 96), (b) => b.fill(65, 24, 88)]) {
    const b = bundle(); edit(b); cases.push(fixHeader(b));
  }
  const badCrc = bundle(); badCrc[508] ^= 1; cases.push(badCrc);
  for (const b of cases) assert.ok((await parseFpvosBundle(b)).errors.length);
});

test('fpvOS service identity excludes stock-kernel backend and incomplete stock identities cannot bootstrap', async () => {
  assert.equal(profileForDevice(info, FPVOS_AR9311.meta.usb[0]), FPVOS_AR9311);
  for (const change of [{ serial: 'fpvos-ar9311-vendor' }, { hardware: 'Gnd486' }, { name: 'Ascent_VRX' }, { status: -1 }]) {
    assert.equal(matchesFpvosAr9311({ ...info, ...change }), false);
  }
  const image = await prepareFirmware(new File([bundle()], 'fpvos-ar9311.fwu'));
  assert.equal(evaluateSelection({ info: { name: 'Ascent_VRX' }, profile: getProfile('ascent-vrx'), image }).canFlash, false);
});

function fakeSession(image, opts = {}) {
  const unitInfo = opts.unitInfo ?? info;
  const calls = []; let installed = false, received = 0;
  const session = { calls, reset() {}, attach() {}, deviceInfo: async () => installed
    ? opts.after ?? { ...unitInfo, firmware: opts.wrongHash ? '0'.repeat(64) : image.parsed.sha256 }
    : { ...unitInfo, maxChunk: 128, ...opts.cleanInfo },
    link: { closed: Promise.resolve(), close: async () => {}, reopen: async () => {} },
    async request(cmd, payload) {
      calls.push(cmd);
      if (cmd === CMD.FILE_END && opts.lostEnd) throw new TimeoutError();
      const p = Buffer.alloc(cmd === CMD.FILE_END || cmd === CMD.FILE_DATA ? 80 : cmd === CMD.UPGRADE_STATUS ? 72 : 68);
      if (cmd === CMD.REBOOT) p.write('OK', 4);
      if (cmd === CMD.FILE_DATA || cmd === CMD.FILE_END) {
        received += payload?.length ?? 0;
        p.writeUInt32LE(payload?.length ?? 0, 0); p.writeUInt32LE(received + (opts.badCount ? 1 : 0), 4); p.writeUInt32LE(image.bytes.length, 8);
        p.write(cmd === CMD.FILE_END ? 'transfer verified; query status' : 'OK', 16);
      }
      if (cmd === CMD.UPGRADE_STATUS) { p.writeUInt32LE(100, 0); p.writeInt32LE(opts.state ?? 4, 4); installed = true; }
      return { crcOk: !opts.badCrc, payload: p };
    } };
  return session;
}

test('fpvOS transfer requires installed state 4 and a matching postboot SHA; verify-only is not success', async () => {
  const image = await prepareFirmware(new File([bundle()], 'fpvos.fwu'));
  for (const opts of [{}, { lostEnd: true }, { state: 2 }, { state: -2 }, { wrongHash: true }]) {
    const session = fakeSession(image, opts);
    const promise = flashFirmware(session, FPVOS_AR9311, image, { info });
    if (opts.state || opts.wrongHash) await assert.rejects(promise, /not installed|installation failed|SHA-256/);
    else assert.equal((await promise).firmware, image.parsed.sha256);
    assert.equal(session.calls.filter((c) => c === CMD.FILE_DATA).length, Math.ceil(image.bytes.length / 128));
    assert.equal(session.calls.filter((c) => c === CMD.FILE_END).length, 1);
    if (opts.state) assert.equal(session.calls.filter((c) => c === CMD.REBOOT).length, 1);
  }
});

test('damaged replies, bad byte counts and wrong recovery identities never trigger installation', async () => {
  const image = await prepareFirmware(new File([bundle()], 'fpvos.fwu'));
  for (const opts of [{ badCrc: true }, { badCount: true }, { cleanInfo: { serial: 'fpvos-ar9311-vendor' } },
    { cleanInfo: { detail: 'OK' } }, { cleanInfo: { maxChunk: 0 } }]) {
    const session = fakeSession(image, opts);
    await assert.rejects(flashFirmware(session, FPVOS_AR9311, image, { info }));
    assert.ok(!session.calls.includes(CMD.FILE_END));
  }
});

test('cancellation never finalizes a transfer; cancellation after finalization still verifies installation', async () => {
  const image = await prepareFirmware(new File([bundle()], 'fpvos.fwu'));
  for (const cancelAt of [CMD.FILE_DATA, CMD.FILE_END]) {
    const session = fakeSession(image), controller = new AbortController(), request = session.request.bind(session);
    session.request = async (...args) => { const f = await request(...args); if (args[0] === cancelAt) controller.abort(); return f; };
    const result = flashFirmware(session, FPVOS_AR9311, image, { info, signal: controller.signal });
    if (cancelAt === CMD.FILE_DATA) {
      await assert.rejects(result, /Cancelled/); assert.ok(!session.calls.includes(CMD.FILE_END));
    } else assert.equal((await result).firmware, image.parsed.sha256);
  }
});

test('fpvOS strict session ignores bad CRC and request-type replies', async () => {
  const link = { write: async (b) => {
    const seq = new DataView(b.buffer).getUint32(24, true);
    const bad = encodeFrame({ cmd: CMD.FIND_DEVICE, seq, type: 2 }); bad[32] ^= 1;
    link.onBytes(bad);
    link.onBytes(encodeFrame({ cmd: CMD.FIND_DEVICE, seq, type: 1 }));
    link.onBytes(encodeFrame({ cmd: CMD.FIND_DEVICE, seq, type: 2, payload: Uint8Array.of(42) }));
  } };
  const session = new Session(link, () => {}, FPVOS_AR9311.transport);
  assert.deepEqual((await session.request(CMD.FIND_DEVICE)).payload, Uint8Array.of(42));
});

test('archives accept one fwu but never guess between install and restore bundles', async () => {
  const image = await prepareFirmware(new File([storedZip([['fpvos.fwu', bundle()]])], 'release.zip'));
  assert.equal(image.parsed.profileId, 'fpvos-ar9311');
  await assert.rejects(prepareFirmware(new File([storedZip([['a.fwu', bundle()], ['b.fwu', bundle()]])], 'ambiguous.zip')), /multiple update/);
});

test('original-stock restoration verifies stock boot; a missing postboot device never reports success', async () => {
  const stock = { name: 'Ascent_VRX', firmware: 'Ascent_G_Gnd_18_21_10', hardware: 'FPV-Ascent-Gnd-485-V1.2-1.0', serial: '2614', status: 0 };
  for (const after of [stock, info, { ...stock, hardware: 'FPV-Ascent-Sky-482-V1.3-1.0' }, null]) {
    const runtime = {};
    const ctx = { profile: FPVOS_AR9311, image: { parsed: { kind: 1 } }, runtime, step() {},
      session: { request: async () => ({ crcOk: true, payload: Buffer.alloc(68) }),
        link: { closed: Promise.resolve(), reopen: async () => {} }, reset() {}, attach() {},
        deviceInfo: async () => { if (!after) throw new Error('device missing'); return after; } } };
    if (after === stock) {
      await FPVOS_REBOOT_VERIFY(ctx); assert.equal(runtime.postflashVerified, true);
    } else {
      await assert.rejects(FPVOS_REBOOT_VERIFY(ctx)); assert.notEqual(runtime.postflashVerified, true);
    }
  }
});
