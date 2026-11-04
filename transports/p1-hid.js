// P1 1.0.44 U-Boot RAM transport. No NAND/flash commands are exposed.
import { crc32 } from '../checksum.js';
export const P1_STOCK_USB = Object.freeze({ usbVendorId: 0x1d6b, usbProductId: 0x0101 });
export const P1_HID_FILTER = Object.freeze({ vendorId: 0x1d6b, productId: 0x0100, usagePage: 0xff00, usage: 1 });
const MAGIC = Uint8Array.of(4, 85, 255, 170, 65, 82, 84, 79);
const MAGIC_ADDRESS = 0x2ffbf378, TABLE = 0x2ffbf290, CALLBACK = 0x2ffbf330, COMMAND = 0x2ff65e98;
const SCRATCH = 0x24bff000;
export const P1_RAM_FILES = Object.freeze({ 'kernel.img': [0x24400000, 6291456],
  'betafpv-p1-air.dtb': [0x22080000, 65536], 'recovery-initrd.img': [0x26000000, 65536] });
const FINGERPRINTS = [0x2ff86788, 0x2ff86950, COMMAND, 0x2ff85b50];
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((n) => n.toString(16).padStart(2, '0')).join('');
function cancelled(signal) { if (signal?.aborted) throw new Error('Preparation cancelled. Power-cycle the P1 before reconnecting.'); }
function deadline(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
export async function enterP1Bootloader(port, { signal } = {}) {
  const info = port.getInfo();
  if (info.usbVendorId !== P1_STOCK_USB.usbVendorId || info.usbProductId !== P1_STOCK_USB.usbProductId) throw new Error('Select the stock P1 Sirius serial port.');
  let writer;
  try {
    cancelled(signal);
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    cancelled(signal);
    await deadline(writer.write(Uint8Array.of(0xaa, 5, 0, 0x1d, 0, 0, 0xcc, 0xeb, 0xaa)), 5000, 'Stock P1 did not accept the reboot command.');
  } finally {
    writer?.releaseLock();
    try { await deadline(port.close(), 2000, 'Serial close timeout'); } catch { /* Reboot can disconnect the port. */ }
  }
}
export function p1Frame(kind, body, first = 4) {
  if (![4, 5, 6].includes(kind) || body.length > 960) throw new Error('Invalid P1 RAM command.');
  const p = new Uint8Array(48 + body.length), v = new DataView(p.buffer);
  p.set(MAGIC); p[0] = first;
  v.setUint32(16, p.length, true); v.setUint32(20, 1, true); p[28] = 1;
  v.setUint16(36, kind, true); v.setUint16(38, 12, true); v.setUint32(40, body.length, true); p.set(body, 48);
  return p;
}
function setup(tag, count, address) {
  const p = new Uint8Array(16), v = new DataView(p.buffer);
  p.set(new TextEncoder().encode(tag)); v.setUint32(4, count, true); v.setBigUint64(8, BigInt(address), true); return p;
}
export class P1HidRecovery {
  constructor(device, { signal, progress = () => {}, log = () => {}, readTimeout = 3000 } = {}) {
    this.device = device; this.signal = signal; this.progress = progress; this.log = log; this.readTimeout = readTimeout;
    this.verified = false; this.commands = false; this.loaded = new Set(); this.pending = null;
    this.onReport = (e) => {
      if (e.device && e.device !== device) return;
      const p = new Uint8Array(e.data.byteLength + 1); p[0] = e.reportId;
      p.set(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength), 1); this.pending?.(p);
    };
    this.onDisconnect = (e) => { if (e.device === device) this.rejectRead?.(new Error('P1 USB bootloader disconnected.')); };
  }
  async open() {
    const d = this.device;
    if (d.vendorId !== P1_HID_FILTER.vendorId || d.productId !== P1_HID_FILTER.productId || d.productName !== 'USB download gadget'
      || !d.collections.some((c) => c.usagePage === 0xff00 && c.usage === 1
        && c.inputReports.some((r) => r.reportId === 4) && c.outputReports.some((r) => r.reportId === 2))) {
      throw new Error('Select the P1 USB download gadget. This is not the supported bootloader interface.');
    }
    cancelled(this.signal);
    try { await d.open(); } catch { throw new Error('Cannot open the P1 bootloader. Close other updaters and check USB/HID access permissions.'); }
    d.addEventListener('inputreport', this.onReport);
    globalThis.navigator?.hid?.addEventListener('disconnect', this.onDisconnect);
  }
  async close() {
    this.rejectRead?.(new Error('P1 connection closed.'));
    this.device.removeEventListener('inputreport', this.onReport);
    globalThis.navigator?.hid?.removeEventListener('disconnect', this.onDisconnect);
    if (this.device.opened) { try { await this.device.close(); } catch { /* USB re-enumeration */ } }
  }
  async send(kind, body, first = 4) {
    cancelled(this.signal);
    const p = p1Frame(kind, body, first);
    await deadline(this.device.sendReport(first, p.subarray(1)), 5000, 'P1 USB transfer timed out. Power-cycle and retry preparation.');
  }
  readable(address, size) {
    return Number.isInteger(address) && Number.isInteger(size) && size > 0 && (
      address >= TABLE && address + size <= MAGIC_ADDRESS + 8
      || FINGERPRINTS.some((a) => address >= a && address + size <= a + 64)
      || address === SCRATCH && size === 4
      || Object.values(P1_RAM_FILES).some(([a, n]) => address >= a && address + size <= a + n));
  }
  async read(address, size, timeout = this.readTimeout) {
    if (!this.readable(address, size)) throw new Error('P1 read outside approved RAM windows.');
    const data = new Uint8Array(size);
    for (let offset = 0; offset < size;) {
      cancelled(this.signal);
      const count = Math.min(16, size - offset);
      // Input report 4 is only 64 bytes. The protocol adds 48 bytes of headers.
      let finish, fail;
      const reply = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      reply.catch(() => {}); // A disconnect can reject while sendReport is still pending.
      this.pending = finish; this.rejectRead = fail;
      let p;
      try {
        await this.send(5, setup('ufgt', count, address + offset));
        p = await deadline(reply, timeout, 'No compatible P1 bootloader reply.');
      } finally { this.pending = this.rejectRead = null; }
      const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
      if (p.length !== 48 + count || !equal(p.subarray(0, 8), MAGIC) || p[28] !== 1
        || v.getUint32(20, true) !== 1 || v.getUint32(24, true) !== 0
        || v.getUint16(36, true) !== 2 || v.getUint16(38, true) !== 12
        || v.getUint32(40, true) !== count || v.getUint32(44, true) !== 0) throw new Error('Malformed P1 RAM reply.');
      data.set(p.subarray(48), offset); offset += count;
    }
    return data;
  }
  async identify(fingerprints) {
    // A fixed, one-byte RAM-only probe is necessary before Linux HID can deliver
    // replies. It changes a protocol constant, never an instruction or NAND.
    // Unknown firmware must not reach callback installation or image upload.
    let adapted = false;
    try { adapted = equal(await this.read(MAGIC_ADDRESS, 8, 350), MAGIC); } catch (e) { cancelled(this.signal); }
    if (!adapted) {
      await this.send(4, setup('uftr', 1, MAGIC_ADDRESS), 255);
      await this.send(4, Uint8Array.of(4), 255);
      if (!equal(await this.read(MAGIC_ADDRESS, 8), MAGIC)) throw new Error('Unsupported P1 bootloader. Power-cycle the unit.');
    }
    if (fingerprints.length !== FINGERPRINTS.length || fingerprints.some((f, i) => f.address !== FINGERPRINTS[i] || f.size !== 64)) throw new Error('Invalid bootloader fingerprint policy.');
    for (const f of fingerprints) {
      if (await sha256(await this.read(f.address, f.size)) !== f.sha256) throw new Error('Unsupported P1 bootloader version. Only stock 1.0.44 is supported; no firmware was written. Power-cycle the unit.');
    }
    const table = await this.read(TABLE, 168), v = new DataView(table.buffer);
    for (let i = 0; i < 7; i++) {
      const expectedKind = i >= 4 ? i : 0;
      const pointer = v.getBigUint64(i * 24 + 16, true);
      const expected = [0x2ff86448, 0, 0, 0, 0x2ff86788, 0x2ff86950, 0][i];
      if (v.getBigUint64(i * 24, true) !== BigInt(expectedKind) || v.getBigUint64(i * 24 + 8, true) !== 0n
        || pointer !== BigInt(expected) && !(i === 6 && pointer === BigInt(COMMAND))) throw new Error('Unrecognized P1 bootloader dispatch table; no firmware was written.');
    }
    this.verified = true;
    const callback = new Uint8Array(8); new DataView(callback.buffer).setBigUint64(0, BigInt(COMMAND), true);
    await this.write(CALLBACK, callback);
    if (!equal(await this.read(CALLBACK, 8), callback)) throw new Error('P1 RAM callback verification failed.');
    this.commands = true;
    this.log('Verified P1 1.0.44 bootloader; enabled temporary RAM recovery commands.');
  }
  async write(address, data) {
    if (!this.verified || !(address === CALLBACK && data.length === 8 || address === SCRATCH && data.length === 4
      || Object.values(P1_RAM_FILES).some(([a, n]) => address === a && data.length > 0 && data.length <= n))) throw new Error('Unverified or out-of-range P1 RAM write.');
    await this.send(4, setup('uftr', data.length, address));
    for (let offset = 0; offset < data.length;) {
      // The vendor handler treats every 16-byte body as a transfer setup.
      let count = Math.min(960, data.length - offset); if (count === 16) count = 8;
      await this.send(4, data.subarray(offset, offset + count)); offset += count;
      if (data.length > 1024) this.progress({ address, bytes: offset, total: data.length });
    }
  }
  async upload(name, bytes) {
    const policy = P1_RAM_FILES[name];
    if (!this.commands || !policy || !bytes.length || bytes.length > policy[1]) throw new Error('Invalid P1 recovery image.');
    const [address] = policy;
    this.loaded.delete(name);
    await this.write(address, bytes);
    // U-Boot's crc32 command stores the result in network byte order.
    const expected = crc32(bytes), sentinel = new Uint8Array(4);
    new DataView(sentinel.buffer).setUint32(0, (expected ^ 0xffffffff) >>> 0);
    await this.write(SCRATCH, sentinel);
    await this.send(6, new TextEncoder().encode(`crc32 ${address.toString(16)} ${bytes.length.toString(16)} ${SCRATCH.toString(16)}`));
    const result = await this.read(SCRATCH, 4);
    if (new DataView(result.buffer).getUint32(0) !== expected) throw new Error(`P1 ${name} RAM checksum mismatch; recovery will not boot.`);
    this.loaded.add(name); this.log(`Verified ${name} in P1 RAM (${bytes.length} bytes).`);
  }
  async boot() {
    if (!this.commands || Object.keys(P1_RAM_FILES).some((name) => !this.loaded.has(name))) throw new Error('All P1 recovery images must be verified before boot.');
    await this.send(6, new TextEncoder().encode('setenv bootm_boot_mode nosec; setenv fdt_high ffffffffffffffff; setenv initrd_high ffffffffffffffff; bootm 24400000 26000000 22080000'));
  }
}
