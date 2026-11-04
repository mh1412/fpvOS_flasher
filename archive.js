// Opens what the user dropped: a firmware image as is, or an archive holding
// one. zip (stored or deflate, zip64), gzip, xz and tar, nested in any order
// (the vendor's .zip, a .img.xz, a .tar.gz ...). Only the entry that is
// wanted is unpacked: a zip is read from its central directory, so a 400 MB
// download costs the size of the one image.
//
// Needs Blob and DecompressionStream, which browsers and Node 18+ both have.

import { crc32 } from './checksum.js';
import { unxz, isXz } from './xz.js';

export class ArchiveError extends Error {
  constructor(msg) { super(msg); this.name = 'ArchiveError'; }
}

const MAX_DEPTH = 4;
const MAX_SIZE = 512 * (1 << 20);   // larger than any image a device here takes

const td = new TextDecoder();
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const stripCompression = (n) => n.replace(/\.(xz|gz)$/i, '');
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

// file: a File or Blob with a name.
// wanted(name): true for an image name a device here can take, used to pick
//   one entry out of a zip or tar (compression suffixes are ignored).
// family(name): optional hardware family; mixed-family matches require a target.
// onProgress(text): what is being done, for the UI.
// Returns { name, bytes, trail: [container names, outermost first], notes: [] }.
export async function openFirmware(file, { wanted = () => false, family = () => null, onProgress = () => {} } = {}) {
  const notes = [];
  return open(file, file.name ?? 'file', [], 0);

  async function open(blob, name, trail, depth) {
    if (depth > MAX_DEPTH) throw new ArchiveError('Archives nested too deep.');
    if (blob.size > MAX_SIZE) throw new ArchiveError(`${name} is larger than ${MAX_SIZE >> 20} MiB.`);
    const head = await bytesOf(blob.slice(0, 512));
    const inner = [...trail, name];

    if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5)) {
      onProgress(`Reading ${name}`);
      const entries = await zipEntries(blob);
      const e = choose(entries, name);
      onProgress(`Unpacking ${baseName(e.name)}`);
      return open(new Blob([await zipExtract(blob, e)]), baseName(e.name), inner, depth + 1);
    }
    if (head[0] === 0x1f && head[1] === 0x8b) {
      onProgress(`Unpacking ${name}`);
      const out = await collect(blob.stream().pipeThrough(new DecompressionStream('gzip')));
      return open(new Blob([out]), name.replace(/\.t?gz$/i, (m) => (m.toLowerCase() === '.tgz' ? '.tar' : '')), inner, depth + 1);
    }
    if (isXz(head)) {
      onProgress(`Unpacking ${name}`);
      const out = await unxz(await bytesOf(blob), {
        limit: MAX_SIZE,
        onProgress: (f) => onProgress(`Unpacking ${name} (${Math.round(f * 100)}%)`),
      });
      return open(new Blob([out]), name.replace(/\.t?xz$/i, (m) => (m.toLowerCase() === '.txz' ? '.tar' : '')), inner, depth + 1);
    }
    if (isTar(head)) {
      const data = await bytesOf(blob);
      const e = choose(tarEntries(data), name);
      return open(new Blob([data.subarray(e.offset, e.offset + e.size)]), baseName(e.name), inner, depth + 1);
    }
    return { name, bytes: await bytesOf(blob), trail, notes };
  }

  // One image out of many: the one a device takes, else the only .img.
  function choose(entries, archive) {
    const files = entries.filter((e) => !e.name.endsWith('/'));
    let hits = files.filter((e) => wanted(stripCompression(baseName(e.name))));
    if (!hits.length) hits = files.filter((e) => /\.(img|fwu)$/i.test(stripCompression(e.name)));
    if (!hits.length) {
      const list = files.slice(0, 8).map((e) => baseName(e.name)).join(', ');
      throw new ArchiveError(`No firmware image in ${archive}${list ? ` (it has ${list}${files.length > 8 ? ', ...' : ''})` : ''}.`);
    }
    if (hits.length > 1) {
      if (hits.some((e) => /\.fwu$/i.test(stripCompression(e.name)))) {
        throw new ArchiveError(`${archive} contains multiple update bundles/images; select one explicitly.`);
      }
      const families = new Set(hits.map((e) => family(stripCompression(baseName(e.name)))).filter(Boolean));
      if (families.size > 1) {
        throw new ArchiveError(`${archive} contains images for different hardware. Connect a device or select a hardware profile first.`);
      }
      // the newest by the version in the name
      const ver = (e) => (/(\d+)_(\d+)_(\d+)\.img/i.exec(e.name) ?? [0, 0, 0, 0]).slice(1).map(Number);
      hits.sort((a, b) => {
        const va = ver(a), vb = ver(b);
        for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i];
        return 0;
      });
      notes.push(`${archive} has ${hits.length} images; using ${baseName(hits[0].name)} (the newest). `
        + `The others: ${hits.slice(1).map((e) => baseName(e.name)).join(', ')}.`);
    }
    return hits[0];
  }
}

async function collect(stream, limit = MAX_SIZE) {
  const parts = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw new ArchiveError(`Unpacked data is larger than ${limit >> 20} MiB.`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// --------------------------------------------------------------------- zip --

export async function zipEntries(blob) {
  const size = blob.size;
  const tailStart = Math.max(0, size - (65535 + 22));
  const tail = await bytesOf(blob.slice(tailStart));
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ArchiveError('Damaged zip (no end of central directory).');
  if (u16(tail, eocd + 4) !== 0 || u16(tail, eocd + 6) !== 0) throw new ArchiveError('Multi-part zips are not supported.');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new ArchiveError('Damaged zip64 (no locator).');
    const recOffset = u64(tail, loc + 8);
    const rec = await bytesOf(blob.slice(recOffset, recOffset + 56));
    if (u32(rec, 0) !== 0x06064b50) throw new ArchiveError('Damaged zip64 (no end record).');
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  if (cdOffset + cdSize > size) throw new ArchiveError('Damaged zip (central directory past the end).');

  const cd = await bytesOf(blob.slice(cdOffset, cdOffset + cdSize));
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || u32(cd, p) !== 0x02014b50) throw new ArchiveError('Damaged zip central directory.');
    const e = {
      flags: u16(cd, p + 8),
      method: u16(cd, p + 10),
      crc: u32(cd, p + 16),
      compSize: u32(cd, p + 20),
      size: u32(cd, p + 24),
      offset: u32(cd, p + 42),
    };
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    e.name = td.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // zip64 extra field: the 64-bit values, for the fields that are 0xffffffff
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(cd, x), len = u16(cd, x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (e.size === 0xffffffff) { e.size = u64(cd, q); q += 8; }
        if (e.compSize === 0xffffffff) { e.compSize = u64(cd, q); q += 8; }
        if (e.offset === 0xffffffff) { e.offset = u64(cd, q); q += 8; }
      }
      x += 4 + len;
    }
    entries.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function zipExtract(blob, e) {
  if (e.flags & 1) throw new ArchiveError(`${e.name} is encrypted.`);
  if (e.size > MAX_SIZE) throw new ArchiveError(`${e.name} is larger than ${MAX_SIZE >> 20} MiB.`);
  const local = await bytesOf(blob.slice(e.offset, e.offset + 30));
  if (u32(local, 0) !== 0x04034b50) throw new ArchiveError(`Damaged zip (no local header for ${e.name}).`);
  const start = e.offset + 30 + u16(local, 26) + u16(local, 28);
  const raw = blob.slice(start, start + e.compSize);
  let out;
  if (e.method === 0) out = await bytesOf(raw);
  else if (e.method === 8) out = await collect(raw.stream().pipeThrough(new DecompressionStream('deflate-raw')));
  else throw new ArchiveError(`${e.name} uses zip compression method ${e.method}; only stored and deflate are supported.`);
  if (out.length !== e.size || crc32(out) !== e.crc) throw new ArchiveError(`${e.name} is damaged in the zip (size or CRC).`);
  return out;
}

// --------------------------------------------------------------------- tar --

function isTar(h) {
  if (h.length < 512) return false;
  if (td.decode(h.subarray(257, 262)) === 'ustar') return true;
  return tarChecksumOk(h);   // old v7 archives have no magic
}

function tarChecksumOk(h) {
  const stored = parseInt(td.decode(h.subarray(148, 156)).replace(/\0.*$/s, '').trim(), 8);
  if (Number.isNaN(stored)) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return sum === stored;
}

function tarNumber(h, o, len) {
  if (h[o] & 0x80) {   // GNU base-256
    let v = h[o] & 0x7f;
    for (let i = 1; i < len; i++) v = v * 256 + h[o + i];
    return v;
  }
  const s = td.decode(h.subarray(o, o + len)).replace(/\0.*$/s, '').trim();
  return s ? parseInt(s, 8) : 0;
}

const tarString = (h, o, len) => td.decode(h.subarray(o, o + len)).replace(/\0.*$/s, '');

export function tarEntries(b) {
  const entries = [];
  let off = 0, longName = null, paxPath = null;
  while (off + 512 <= b.length) {
    const h = b.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    if (!tarChecksumOk(h)) throw new ArchiveError('Damaged tar header.');
    const size = tarNumber(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    let name = tarString(h, 0, 100);
    if (tarString(h, 257, 5) === 'ustar') {
      const prefix = tarString(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const data = off + 512;
    if (data + size > b.length) throw new ArchiveError('Truncated tar.');
    if (type === 'L') {
      longName = tarString(b, data, size);
    } else if (type === 'x') {
      for (const rec of td.decode(b.subarray(data, data + size)).split('\n')) {
        const m = /^\d+ path=(.*)$/s.exec(rec);
        if (m) paxPath = m[1];
      }
    } else if (type !== 'g') {
      if (type === '0' || type === '7') entries.push({ name: paxPath ?? longName ?? name, offset: data, size });
      longName = paxPath = null;
    }
    off = data + Math.ceil(size / 512) * 512;
  }
  return entries;
}
