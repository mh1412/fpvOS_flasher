// Synthetic containers only: no vendor firmware, signing secrets or device I/O.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { crc32 } from '../checksum.js';

export function airImage(version = [18, 21, 10], board = 3) {
  const secLen = [0x100, 0x80, 0x200, 0x300, 0x400];
  const ids = [0, 1, 2, 4, 5];
  const total = 0x80 + secLen.reduce((a, b) => a + b);
  const d = new Uint8Array(total);
  const v = new DataView(d.buffer);
  d.set(Buffer.from('ASW\0'));
  v.setUint32(4, board, true);
  version.forEach((n, i) => v.setUint32(8 + 4 * i, n, true));
  let off = 0x80;
  ids.forEach((id, i) => {
    const o = 0x14 + 12 * i;
    d[o] = id; d[o + 1] = 1; d[o + 2] = 1;
    v.setUint32(o + 4, 0x80000, true);
    v.setUint32(o + 8, off, true);
    d.set(randomBytes(secLen[i]), off);
    off += secLen[i];
  });
  v.setUint32(0x74, total, true);
  v.setUint32(0x70, crc32(d.subarray(0x80)), true);
  return d;
}

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = keys.publicKey.export({ format: 'jwk' });
export const TEST_VRX_KEY = { modulus: Buffer.from(jwk.n, 'base64url').toString('hex'), exponent: 65537 };

export function signVrx(bytes) {
  bytes.set(createHash('sha256').update(bytes.subarray(0x2a0)).digest(), 0x180);
  bytes.set(sign('sha256', bytes.subarray(0x2a0), keys.privateKey), 0x1a0);
  return bytes;
}

export const VRX_TABLE = 0x2a0 + 0x100;
export const VRX_SEGMENTS = VRX_TABLE + 3 * 52;

export function vrxImage() {
  const start = VRX_SEGMENTS + 3 * 32;
  const bytes = new Uint8Array(start + 3 * 64);
  const v = new DataView(bytes.buffer);
  const u64 = (o, n) => v.setBigUint64(o, BigInt(n), true);
  bytes.set(Buffer.from('ASW\0'));
  v.setUint32(4, 5, true);
  [17, 5, 8].forEach((n, i) => v.setUint32(8 + i * 4, n, true));
  // Ground ASW bytes 0x70/0x74 are zero, not air-unit CRC/size fields.
  bytes.set(Buffer.from('OTRA'), 0x80);
  v.setUint16(0x84, 0x0101, true);
  bytes[0x86] = bytes[0x87] = 2;
  v.setUint16(0x8a, 32, true); v.setUint16(0x8c, 256, true);
  u64(0x90, bytes.length - 0x2a0);
  v.setUint32(0x9c, 0x100, true);
  v.setUint16(0xa0, 3, true); v.setUint16(0xa2, 3, true);
  bytes[0xc1] = bytes[0xc2] = 1;
  ['kernel', 'userapp0', 'userapp1'].forEach((name, i) => {
    const o = VRX_TABLE + i * 52;
    bytes.set(Buffer.from(name), o);
    u64(o + 32, 0x100000 + i * 0x100000); u64(o + 40, 0x100000);
    v.setUint32(o + 48, i < 2 ? 1 : 0, true);
  });
  for (let i = 0; i < 3; i++) {
    const o = VRX_SEGMENTS + i * 32;
    u64(o, start + i * 64 - 0x80);
    u64(o + 8, i === 0 ? 0x100000 : 0x200000 + (i - 1) * 128);
    u64(o + 16, 64); u64(o + 24, 128);
  }
  bytes.set(randomBytes(3 * 64), start);
  return signVrx(bytes);
}

export function storedZip(members) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, bytes] of members) {
    const n = Buffer.from(name), data = Buffer.from(bytes), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, n);
    offset += local.length + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
