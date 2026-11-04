// Shared FPVOSUP1 envelope; each board supplies its component and size policy.
import { crc32 } from '../transports/ascent.js';

const td = new TextDecoder();
const hex = (b) => Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
const zeros = (b) => b.every((n) => n === 0);
export const isFpvosBundle = (b) => td.decode(b.subarray(0, 8)) === 'FPVOSUP1';

export async function parseFpvosBundle(bytes, policy) {
  const { board, boardName, names, limits, restore = false, maxSize } = policy;
  const r = { errors: [], warnings: [], sections: [], boardName, remoteName: 'fpvos.fwu' };
  const fail = (s) => r.errors.push(s);
  if (bytes.length < 512 || !isFpvosBundle(bytes)) {
    fail('Missing or truncated FPVOSUP1 bundle header.');
    return r;
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o) => v.getUint32(o, true);
  r.kind = u32(88);
  r.board = u32(12);
  const count = u32(20), expected = r.kind === 0 ? 3 : r.kind === 1 && restore ? 2 : 0;
  const header = Uint8Array.from(bytes.subarray(0, 512));
  header.fill(0, 508);
  if (u32(8) !== 1 || r.board !== board) fail(`Unsupported bundle format or board (requires ${boardName}).`);
  if (!expected || count !== expected) fail(`Unsupported component policy: requires a full ${boardName} install${restore ? ' or kernel/DTB restoration bundle' : ''}, not a root-only bundle.`);
  const capacity = r.kind === 1 && restore ? 512 + limits[0] + limits[1] : maxSize;
  if (u32(16) !== bytes.length || bytes.length > capacity) fail(`Bundle length is invalid or exceeds ${boardName} capacity.`);
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
      fail(`Invalid ${boardName} component ${i + 1} (name, size, hash or bounds).`);
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

export const bundleForBoard = (bytes, board) => isFpvosBundle(bytes) && bytes.length >= 16
  && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true) === board;
