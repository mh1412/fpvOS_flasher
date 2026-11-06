import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { P1HidRecovery, P1_RAM_FILES, enterP1Bootloader, sha256 } from '../transports/p1-hid.js';
import { loadP1Recovery, prepareP1Recovery } from '../stages/p1-bootstrap.js';
import { crc32 } from '../checksum.js';
const TABLE = 0x2ffbf290, MAGIC = 0x2ffbf378, CALLBACK = 0x2ffbf330;
class FakeHid extends EventTarget {
  constructor(variant = 'v1') {
    super();
    this.layout = variant === 'v2'
      ? { magic: 0x2febebd0, table: 0x2febeae8, callback: 0x2febeb88, command: 0x2fe651d8, callbacks: [0x2fe85898, 0, 0, 0, 0x2fe85bd8, 0x2fe85da0, 0], fingerprints: [0x2fe85bd8, 0x2fe85da0, 0x2fe651d8, 0x2fe84fa0] }
      : { magic: MAGIC, table: TABLE, callback: CALLBACK, command: 0x2ff65e98, callbacks: [0x2ff86448, 0, 0, 0, 0x2ff86788, 0x2ff86950, 0], fingerprints: [0x2ff86788, 0x2ff86950, 0x2ff65e98, 0x2ff85b50] }; this.vendorId = 0x1d6b; this.productId = 0x0100; this.productName = 'USB download gadget';
    this.collections = [{ usagePage: 0xff00, usage: 1, inputReports: [{ reportId: 4 }], outputReports: [{ reportId: 2 }] }];
    this.opened = false; this.memory = new Map(); this.writes = []; this.commands = []; this.frames = []; this.corruptCrc = false;
    this.put(this.layout.magic, Uint8Array.of(255, 85, 255, 170, 65, 82, 84, 79));
    const table = new Uint8Array(168), v = new DataView(table.buffer);
    for (let i = 0; i < 7; i++) {
      v.setBigUint64(i * 24, BigInt(i >= 4 ? i : 0), true);
      v.setBigUint64(i * 24 + 16, BigInt(this.layout.callbacks[i]), true);
    }
    this.put(this.layout.table, table);
  }
  put(a, data) { data.forEach((b, i) => this.memory.set(a + i, b)); }
  get(a, n) { return Uint8Array.from({ length: n }, (_, i) => this.memory.get(a + i) ?? 0); }
  async fingerprints() {
    return Promise.all(this.layout.fingerprints.map(async (address, i) => {
      const b = new Uint8Array(64).fill(i + 1); this.put(address, b);
      return { address, size: 64, sha256: await sha256(b) };
    }));
  }
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendReport(id, data) {
    const p = new Uint8Array(data.length + 1); p[0] = id; p.set(data, 1); this.frames.push(p);
    if (id !== this.memory.get(this.layout.magic)) return; // Legacy mode cannot deliver browser reads.
    const v = new DataView(p.buffer), kind = v.getUint16(36, true), body = p.slice(48), b = new DataView(body.buffer);
    if (kind === 4) {
      if (body.length === 16) {
        assert.equal(new TextDecoder().decode(body.slice(0, 4)), 'uftr');
        this.transfer = { address: Number(b.getBigUint64(8, true)), size: b.getUint32(4, true), offset: 0 };
      } else {
        assert.ok(this.transfer); const t = this.transfer;
        assert.ok(t.offset + body.length <= t.size); this.put(t.address + t.offset, body);
        this.writes.push({ address: t.address + t.offset, bytes: body.length }); t.offset += body.length;
        if (t.offset === t.size) this.transfer = null;
        this.onWrite?.();
      }
    } else if (kind === 5) {
      const address = Number(b.getBigUint64(8, true)), n = b.getUint32(4, true);
      if (id !== 4 || this.dropReplies) return;
      assert.ok(n <= 16);
      const reply = new Uint8Array(48 + n), r = new DataView(reply.buffer);
      reply.set(this.get(this.layout.magic, 8)); r.setUint32(20, 1, true); reply[28] = 1;
      r.setUint16(36, 2, true); r.setUint16(38, 12, true); r.setUint32(40, n, true); reply.set(this.get(address, n), 48);
      if (this.malformed) r.setUint32(40, n + 1, true);
      const e = new Event('inputreport'); Object.assign(e, { device: this, reportId: reply[0], data: new DataView(reply.buffer, 1) });
      queueMicrotask(() => this.dispatchEvent(e));
    } else if (kind === 6) {
      const command = new TextDecoder().decode(body); this.commands.push(command);
      assert.equal(new DataView(this.get(this.layout.callback, 8).buffer).getBigUint64(0, true), BigInt(this.layout.command));
      if (command.startsWith('crc32 ')) {
        const [, a, n, dest] = command.split(' '); const result = new Uint8Array(4);
        new DataView(result.buffer).setUint32(0, (crc32(this.get(parseInt(a, 16), parseInt(n, 16))) ^ (this.corruptCrc ? 1 : 0)) >>> 0);
        this.put(parseInt(dest, 16), result);
      } else assert.equal(command, 'setenv bootm_boot_mode nosec; setenv fdt_high ffffffffffffffff; setenv initrd_high ffffffffffffffff; bootm 24400000 26000000 22080000');
    } else throw new Error(`Unexpected operation ${kind}`);
  }
}
async function identified(options = {}) {
  const device = new FakeHid(options.stockVersion?.startsWith('2.') ? 'v2' : 'v1'), fingerprints = await device.fingerprints();
  const link = new P1HidRecovery(device, { readTimeout: 20, ...options });
  await link.open(); await link.identify(fingerprints); return { device, link, fingerprints };
}
const fetchAssets = async (url) => new Response(await fs.readFile(new URL('../assets/p1-updater/browser-v1/' + new URL(url).pathname.split('/').pop(), import.meta.url)));

test('stock entry sends only the nine-byte reboot request and closes serial', async () => {
  const events = [];
  const port = { getInfo: () => ({ usbVendorId: 0x1d6b, usbProductId: 0x0101 }),
    open: async () => events.push('open'), close: async () => events.push('close'),
    writable: { getWriter: () => ({ write: async (b) => events.push(Buffer.from(b).toString('hex')), releaseLock: () => events.push('release') }) } };
  await enterP1Bootloader(port); assert.deepEqual(events, ['open', 'aa05001d0000ccebaa', 'release', 'close']);
  port.getInfo = () => ({ usbVendorId: 0x1d75, usbProductId: 0x0101 });
  await assert.rejects(enterP1Bootloader(port), /stock P1/); assert.equal(events.length, 4);
});
test('wrong HID interface is rejected before opening or modifying RAM', async () => {
  const d = new FakeHid(); d.collections = [];
  await assert.rejects(new P1HidRecovery(d).open(), /supported bootloader/);
  assert.equal(d.opened, false); assert.equal(d.writes.length, 0);
});
test('unknown bootloader stops after the single reversible protocol probe', async () => {
  const d = new FakeHid(), fingerprints = await d.fingerprints(); d.put(fingerprints[0].address, Uint8Array.of(99));
  const link = new P1HidRecovery(d, { readTimeout: 20 }); await link.open();
  try { await assert.rejects(link.identify(fingerprints), /Unsupported P1 bootloader version/);
    assert.deepEqual(d.writes, [{ address: MAGIC, bytes: 1 }]); assert.equal(d.commands.length, 0);
  } finally { await link.close(); }
});
test('malformed dispatch table never enables the command callback', async () => {
  const d = new FakeHid(), fp = await d.fingerprints(); d.put(TABLE + 8, Uint8Array.of(1));
  const link = new P1HidRecovery(d); await link.open();
  try { await assert.rejects(link.identify(fp), /dispatch table/); assert.ok(d.writes.every(w => w.address === MAGIC)); }
  finally { await link.close(); }
});
test('bounded RAM uploads split a 16-byte tail and require every verified image before boot', async () => {
  const { device, link } = await identified();
  try {
    await assert.rejects(link.boot(), /All P1 recovery images/);
    for (const name of Object.keys(P1_RAM_FILES)) await link.upload(name, new Uint8Array(976).fill(0x31));
    assert.ok(device.writes.some(w => w.bytes === 8));
    await link.boot(); assert.equal(device.commands.filter(c => c.includes('bootm 244')).length, 1);
    await assert.rejects(link.write(0, new Uint8Array(1)), /out-of-range/);
    await assert.rejects(link.read(0x0a106138, 4), /approved RAM/);
    assert.ok(device.frames.every(p => [4, 5, 6].includes(new DataView(p.buffer).getUint16(36, true))));
  } finally { await link.close(); }
});
test('a checksum mismatch prevents boot and cannot reuse an earlier verification', async () => {
  const { device, link } = await identified();
  try {
    for (const name of Object.keys(P1_RAM_FILES)) await link.upload(name, new Uint8Array(32));
    device.corruptCrc = true;
    await assert.rejects(link.upload('kernel.img', new Uint8Array(32)), /checksum mismatch/);
    await assert.rejects(link.boot(), /verified/); assert.ok(!device.commands.some(c => c.includes('bootm 244')));
  } finally { await link.close(); }
});
test('cancellation during an upload never issues a boot command', async () => {
  const controller = new AbortController(), { device, link } = await identified({ signal: controller.signal });
  device.onWrite = () => controller.abort();
  try { await assert.rejects(link.upload('kernel.img', new Uint8Array(2000)), /cancelled/);
    assert.ok(!device.commands.some(c => c.includes('bootm 244')));
  } finally { await link.close(); }
});
test('missing and malformed replies fail closed', async () => {
  const { device, link } = await identified();
  try { device.malformed = true; await assert.rejects(link.read(TABLE, 8), /Malformed/);
    device.malformed = false; device.dropReplies = true; await assert.rejects(link.read(TABLE, 8), /No compatible/);
  } finally { await link.close(); }
});
test('preparation can resume after a verified RAM adaptation without repeating the probe', async () => {
  const { device, link, fingerprints } = await identified(); await link.close();
  const probes = device.writes.filter(w => w.address === MAGIC).length;
  const next = new P1HidRecovery(device); await next.open();
  try { await next.identify(fingerprints); assert.equal(device.writes.filter(w => w.address === MAGIC).length, probes); }
  finally { await next.close(); }
});
test('all pinned recovery assets load and initramfs forces independent recovery', async () => {
  const { files } = await loadP1Recovery({ fetcher: fetchAssets });
  assert.equal(files.length, 3); const initrd = files.find(f => f.name === 'recovery-initrd.img').bytes;
  const v = new DataView(initrd.buffer); assert.equal(v.getUint32(0), 0x27051956);
  assert.equal(v.getUint32(24), crc32(initrd.subarray(64)));
  const archive = gunzipSync(initrd.subarray(64)).toString();
  assert.match(archive, /if false; then/); assert.doesNotMatch(archive, /if \/usr\/sbin\/ar9311-nandctl boot/);
  assert.match(archive, /: > \/run\/fpvos-clean-boot/);
});
test('tampered manifest or recovery binary stops before opening a device', async () => {
  for (const bad of ['manifest.json', 'kernel.img', 'recovery-initrd.img']) {
    const d = new FakeHid(); let opens = 0; d.open = async () => { opens++; };
    const fetcher = async (url) => { const r = await fetchAssets(url); if (!new URL(url).pathname.endsWith(bad)) return r;
      const bytes = new Uint8Array(await r.arrayBuffer()); bytes[bytes.length - 1] ^= 1; return new Response(bytes); };
    await assert.rejects(prepareP1Recovery(d, { stockVersion: '1.0.44', fetcher }), /SHA-256 mismatch/); assert.equal(opens, 0);
  }
});
test('oversized and truncated downloads are rejected', async () => {
  await assert.rejects(loadP1Recovery({ fetcher: async () => new Response(new Uint8Array(8193)) }), /size limit/);
  await assert.rejects(loadP1Recovery({ fetcher: async (url) => new URL(url).pathname.endsWith('kernel.img') ? new Response(new Uint8Array(1)) : fetchAssets(url) }), /size\/SHA-256/);
});

test('each listed v2 release uses only its own verified RAM layout', async () => {
  for (const stockVersion of ['2.0.5', '2.0.6', '2.1.2']) {
    const { device, link } = await identified({ stockVersion });
    try {
      assert.deepEqual(device.writes.slice(0, 2), [{ address: 0x2febebd0, bytes: 1 }, { address: 0x2febeb88, bytes: 8 }]);
      await assert.rejects(link.read(TABLE, 8), /approved RAM/);
      await assert.rejects(link.write(CALLBACK, new Uint8Array(8)), /out-of-range/);
      for (const name of Object.keys(P1_RAM_FILES)) await link.upload(name, new Uint8Array(976).fill(0x32));
      await link.boot(); assert.equal(device.commands.filter(c => c.includes('bootm 244')).length, 1);
    } finally { await link.close(); }
  }
});
test('unsupported or missing stock selection never opens a device or fetches assets', async () => {
  for (const stockVersion of [undefined, '', '2.0.7', '2.2.0', '__proto__']) {
    const d = new FakeHid(); let fetches = 0;
    await assert.rejects(prepareP1Recovery(d, { stockVersion, fetcher: () => { fetches++; } }), /supported stock/);
    assert.equal(fetches, 0); assert.equal(d.opened, false); assert.equal(d.writes.length, 0);
  }
});
test('wrong policy is rejected before the initial RAM probe', async () => {
  const d = new FakeHid('v2'); const fps = await d.fingerprints();
  const link = new P1HidRecovery(d, { stockVersion: '1.0.44' }); await link.open();
  try { await assert.rejects(link.identify(fps), /fingerprint policy/); assert.equal(d.frames.length, 0); }
  finally { await link.close(); }
});
test('a failed version-specific probe does not try another bootloader layout', async () => {
  const d = new FakeHid('v2'), policyDevice = new FakeHid();
  const fps = await policyDevice.fingerprints();
  const link = new P1HidRecovery(d, { stockVersion: '1.0.44', readTimeout: 20 }); await link.open();
  try {
    await assert.rejects(link.identify(fps), /No compatible/);
    assert.deepEqual(d.writes, [{ address: MAGIC, bytes: 1 }]);
    assert.equal(d.commands.length, 0); assert.equal(link.verified, false);
  } finally { await link.close(); }
});

test('bundled recovery includes its hash-pinned corresponding source patch', async () => {
  const { manifest } = await loadP1Recovery({ fetcher: fetchAssets });
  const patch = new Uint8Array(await (await fetchAssets(new URL(manifest.source_patch.file, 'https://localhost/'))).arrayBuffer());
  assert.equal(patch.length, manifest.source_patch.size);
  assert.equal(await sha256(patch), manifest.source_patch.sha256);
  assert.match(new TextDecoder().decode(patch), /backends\/p1-air\/layout\.h/);
});
