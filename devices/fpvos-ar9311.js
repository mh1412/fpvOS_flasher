// New-kernel Gnd485 recovery service; not the stock-kernel root-only profile.
import { crc32, ASCENT_TRANSPORT, ASCENT_PROTOCOL } from '../transports/ascent.js';
import { defineDevice } from './common.js';
import { FPVOS_PREPARE, FPVOS_TRANSFER, FPVOS_INSTALL, FPVOS_REBOOT_VERIFY } from '../stages/fpvos.js';

const td = new TextDecoder();
const hex = (b) => Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
const zeros = (b) => b.every((n) => n === 0);
const names = ['kernel.img', 'ascent-gnd485.dtb', 'rootfs.cpio.uboot'];
const limits = [0x600000, 0x60000, 0x1000000];
export const isFpvosBundle = (b) => td.decode(b.subarray(0, 8)) === 'FPVOSUP1';

export async function parseFpvosBundle(bytes) {
  const r = { errors: [], warnings: [], sections: [], boardName: 'fpvOS AR9311 / Gnd485', remoteName: 'fpvos.fwu' };
  const fail = (s) => r.errors.push(s);
  if (bytes.length < 512 || !isFpvosBundle(bytes)) {
    fail('Missing or truncated FPVOSUP1 bundle header.');
    return r;
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o) => v.getUint32(o, true);
  r.kind = u32(88);
  r.board = u32(12);
  const count = u32(20), expected = r.kind === 0 ? 3 : r.kind === 1 ? 2 : 0;
  const header = Uint8Array.from(bytes.subarray(0, 512));
  header.fill(0, 508);
  if (u32(8) !== 1 || r.board !== 485) fail('Unsupported bundle format or board (requires AR9311 Gnd485).');
  if (!expected || count !== expected) fail('Unsupported component policy: requires a full AR9311 install or kernel/DTB restoration bundle, not a root-only bundle.');
  if (u32(16) !== bytes.length || bytes.length > (r.kind === 1 ? 6685184 : 21757952)) fail('Bundle length is invalid or exceeds AR9311 capacity.');
  if (crc32(header) !== u32(508)) fail('Bundle header CRC-32 mismatch.');
  const label = bytes.subarray(24, 88), end = label.indexOf(0);
  if (end < 1 || label.subarray(0, end).some((n) => n < 32 || n > 126)) fail('Invalid bundle release label.');
  r.versionText = end > 0 ? td.decode(label.subarray(0, end)) : '';
  if (!zeros(bytes.subarray(92, 96)) || !zeros(bytes.subarray(408, 508))
    || expected && !zeros(bytes.subarray(96 + expected * 104, 408))) fail('Nonzero reserved bundle fields.');
  if (r.errors.length) return r;
  let offset = 512;
  for (let i = 0; i < count; i++) {
    const at = 96 + i * 104, name = new TextEncoder().encode(names[i]);
    const length = u32(at + 32), hash = td.decode(bytes.subarray(at + 36, at + 100));
    if (!bytes.subarray(at, at + name.length).every((n, j) => n === name[j])
      || !zeros(bytes.subarray(at + name.length, at + 32)) || u32(at + 100) !== 0
      || !length || length > limits[i] || r.kind === 1 && length !== limits[i]
      || !/^[a-f0-9]{64}$/.test(hash) || offset + length > bytes.length) {
      fail(`Invalid AR9311 component ${i + 1} (name, size, hash or bounds).`);
      return r;
    }
    const actual = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.subarray(offset, offset + length))));
    if (actual !== hash) fail(`SHA-256 mismatch for ${names[i]}.`);
    r.sections.push({ name: names[i], length, offset, upgrade: true, sha256: actual });
    offset += length;
  }
  if (offset !== bytes.length) fail('Bundle has trailing or missing component bytes.');
  r.sha256 = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  r.warnings.push('Unsigned firmware: hashes verify integrity, not authenticity. Device-side image and NAND checks remain mandatory.');
  return r;
}

export const matchesFpvosAr9311 = (info) => ['fpvOS updater', 'fpvOS AR9311 updater'].includes(info.name)
  && info.hardware === 'Gnd485' && info.serial === 'fpvos-ar9311' && info.status === 0;

export const FPVOS_AR9311 = defineDevice({
  meta: {
    id: 'fpvos-ar9311', name: 'Ascent VRX · fpvOS', models: ['Ascent VRX · fpvOS'],
    usb: [{ usbVendorId: 0x1d6b, usbProductId: 0x0104 }],
    deviceVersion: () => null,
    identity: { matches: matchesFpvosAr9311, normalMatches: (a, b) => matchesFpvosAr9311(a) && matchesFpvosAr9311(b) },
    image: { pattern: /\.fwu$/i, detect: isFpvosBundle, parse: parseFpvosBundle,
      columns: ['Component', 'Size', 'Offset', 'Update flag'],
      checks: (p) => [['Bundle SHA-256', p.sha256 ?? ''], ['Operation', p.kind === 1 ? 'Restore original stock kernel/DTB' : 'Install fpvOS']] },
    notices: { flash: 'Keep external DC power connected. Shared kernel/DTB writes are not power-loss atomic. Keep original partition backups and a working U-Boot RAM recovery path. Stock restoration requires an original-backup restoration bundle; vendor .img files are not yet supported by this service.' },
  },
  transport: Object.freeze({ ...ASCENT_TRANSPORT, strictReplies: true,
    protocol: Object.freeze({ createSession: ASCENT_PROTOCOL.createSession }),
    timeouts: Object.freeze({ ...ASCENT_TRANSPORT.timeouts, install: 15 * 60000 }) }),
  stages: { preflash: [FPVOS_PREPARE], flash: [FPVOS_TRANSFER, FPVOS_INSTALL], postflash: [FPVOS_REBOOT_VERIFY] },
});
