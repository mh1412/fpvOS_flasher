// Shared Ascent wire protocol and transfer primitives. Device policy and
// preflash/flash/postflash orchestration live outside this module.
//
// This speaks the protocol of the vendor's PC tool (read from a decompile of its
// Windows build, v2.0.40) to ar_fpvhs_upgrade (air) or ar_fpv_upgrade (VRX). The
// unit does the flashing itself: it checks the frame CRCs and the file's MD5.
// Image authentication and single/paired flash-write behavior depend on the
// hardware profile. The host only ships the file; see devices/ and stages/.
//
// No browser APIs in here: the transport ("link") is passed in, so the Web
// Serial page and the Node tests share this file. A link has
//   open(), close(), write(Uint8Array)
//   onBytes(Uint8Array) and onClose()  - set by Session, called by the link
//   closed                             - a promise that settles when the port goes away
//   reopen({timeoutMs})                - waits for the unit to come back after a reboot

import { crc32 } from '../checksum.js';

export const CMD = Object.freeze({
  UNKNOWN: 0,             // the unit's reply to a command it does not know
  REBOOT: 3,              // payload "clean": reboot into the update system
  NETWORK_MODE: 59,       // switch the USB gadget from serial to RNDIS
  FIND_DEVICE: 60,
  REMOTE_UPGRADE: 114,
  FILE_START: 115,
  FILE_DATA: 116,
  FILE_END: 117,
  UPGRADE_STATUS: 118,
});

const CMD_NAME = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k]));
export const cmdName = (c) => CMD_NAME[c] ?? `cmd ${c}`;

// ------------------------------------------------------------------ frames --
// 36-byte little-endian header, then the payload:
//   u32 magic "OTRA"  u16 version 3292  u16 type (1 request, 2 ack)
//   u16 msgid 0  u16 0xABCD  u32 command  u16 format 2  u16 userid 0
//   u32 length  u32 seq  u32 retry  u32 crc32
// crc32 is the standard CRC-32 over the header with this field zeroed, then
// over the payload. Replies echo the request's seq.

export const HEADER_LEN = 36;
const MAGIC = 0x4152544f;
const VERSION = 3292;
const TYPE_REQUEST = 1;
const FORMAT_BINARY = 2;
const UNUSED = 0xabcd;
const MAX_REPLY = 64 * 1024;   // replies are a few hundred bytes; the unit's side takes 1 MiB chunks
const EMPTY = new Uint8Array(0);

// crc32(b, crc32(a)) == crc32(a + b)
export { crc32 };

export function encodeFrame({ cmd, seq, retry = 0, payload = EMPTY, type = TYPE_REQUEST }) {
  const f = new Uint8Array(HEADER_LEN + payload.length);
  const v = new DataView(f.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, type, true);
  v.setUint16(10, UNUSED, true);
  v.setUint32(12, cmd, true);
  v.setUint16(16, FORMAT_BINARY, true);
  v.setUint32(20, payload.length, true);
  v.setUint32(24, seq >>> 0, true);
  v.setUint32(28, retry, true);
  f.set(payload, HEADER_LEN);
  v.setUint32(32, crc32(f), true);
  return f;
}

// Splits a byte stream into frames. Bytes before a magic are skipped (and
// counted), a header with an absurd length is skipped, and the CRC is checked
// but a bad one only marks the frame: the PC tool does not check it at all.
export class FrameParser {
  constructor({ maxPayload = MAX_REPLY } = {}) {
    this.maxPayload = maxPayload;
    this.reset();
  }

  reset() {
    this.buf = EMPTY;
    this.skipped = 0;
  }

  push(bytes) {
    const b = new Uint8Array(this.buf.length + bytes.length);
    b.set(this.buf);
    b.set(bytes, this.buf.length);
    const frames = [];
    let i = 0;
    for (;;) {
      const m = findMagic(b, i);
      if (m < 0) {
        const keep = Math.max(i, b.length - 3);   // a magic may straddle reads
        this.skipped += keep - i;
        i = keep;
        break;
      }
      this.skipped += m - i;
      i = m;
      if (b.length - i < HEADER_LEN) break;
      const v = new DataView(b.buffer, b.byteOffset + i, HEADER_LEN);
      const len = v.getUint32(20, true);
      if (len > this.maxPayload) {
        i += 1;
        this.skipped += 1;
        continue;
      }
      if (b.length - i < HEADER_LEN + len) break;
      const head = b.slice(i, i + HEADER_LEN);
      const payload = b.slice(i + HEADER_LEN, i + HEADER_LEN + len);
      const crc = v.getUint32(32, true);
      head.fill(0, 32, 36);
      frames.push({
        type: v.getUint16(6, true),
        cmd: v.getUint32(12, true),
        seq: v.getUint32(24, true),
        retry: v.getUint32(28, true),
        payload,
        crcOk: crc32(payload, crc32(head)) === crc,
      });
      i += HEADER_LEN + len;
    }
    this.buf = b.slice(i);
    return frames;
  }
}

function findMagic(b, from) {
  for (let i = from; i + 4 <= b.length; i++) {
    if (b[i] === 0x4f && b[i + 1] === 0x54 && b[i + 2] === 0x52 && b[i + 3] === 0x41) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- payloads --

const te = new TextEncoder();
const td = new TextDecoder();

function cstr(p, off, len) {
  const s = p.subarray(Math.min(off, p.length), Math.min(off + len, p.length));
  const z = s.indexOf(0);
  return td.decode(z < 0 ? s : s.subarray(0, z));
}

function i32(p, off) {
  if (p.length < off + 4) return undefined;
  return new DataView(p.buffer, p.byteOffset + off, 4).getInt32(0, true);
}

function putCstr(p, off, len, s) {
  const b = te.encode(s);
  if (b.length >= len) throw new Error(`"${s}" is too long (max ${len - 1} bytes)`);
  p.set(b, off);
}

// FIND_DEVICE reply (ResDeviceInfo in the PC tool)
export function parseDeviceInfo(p) {
  return {
    maxChunk: i32(p, 0),
    sdk: cstr(p, 4, 32),
    name: cstr(p, 36, 64),
    cpuTemp: i32(p, 100),
    firmware: cstr(p, 104, 64),
    serial: cstr(p, 168, 32),
    hardware: cstr(p, 200, 32),
    status: i32(p, 232),
    detail: cstr(p, 236, 64),
  };
}

// FILE_DATA / FILE_END reply (ResFileDataInfo)
export function parseFileAck(p) {
  return {
    length: i32(p, 0),
    cursize: i32(p, 4),
    totalsize: i32(p, 8),
    status: i32(p, 12),
    detail: cstr(p, 16, 64),
  };
}

// UPGRADE_STATUS reply (ResUpgradeStatus)
export function parseUpgradeStatus(p) {
  return { percent: i32(p, 0), status: i32(p, 4), detail: cstr(p, 8, 64) };
}

// FILE_START payload (ArFileInfo): md5 as lowercase hex in a 64-byte field,
// i32 length, i32 saveAsFile = 1, char[128] path on the unit, char[128] the
// host's path (the PC tool sends its local path with '/' separators).
export function encodeFileStart({ md5hex, length, remotePath, localPath }) {
  const p = new Uint8Array(64 + 4 + 4 + 128 + 128);
  const v = new DataView(p.buffer);
  putCstr(p, 0, 64, md5hex);
  v.setInt32(64, length, true);
  v.setInt32(68, 1, true);
  putCstr(p, 72, 128, remotePath);
  putCstr(p, 200, 128, localPath);
  return p;
}

export function rebootPayload(mode) {
  const p = new Uint8Array(32);
  putCstr(p, 0, 32, mode);
  return p;
}

// --------------------------------------------------------------------- md5 --
// The unit wants the file's MD5, and WebCrypto has none.

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

function md5Block(st, x, v, off) {
  for (let i = 0; i < 16; i++) x[i] = v.getInt32(off + 4 * i, true);
  let a = st[0], b = st[1], c = st[2], d = st[3];
  for (let i = 0; i < 64; i++) {
    let f, g;
    if (i < 16) { f = (b & c) | (~b & d); g = i; }
    else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
    else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
    else { f = c ^ (b | ~d); g = (7 * i) & 15; }
    const s = MD5_S[((i >> 4) << 2) | (i & 3)];
    const sum = (a + f + MD5_K[i] + x[g]) | 0;
    a = d; d = c; c = b;
    b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0;
  }
  st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0;
  st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
}

export function md5hex(bytes) {
  const st = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476);
  const x = new Int32Array(16);
  const n = bytes.length;
  const full = n - (n % 64);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let off = 0; off < full; off += 64) md5Block(st, x, v, off);
  const tail = new Uint8Array(n % 64 < 56 ? 64 : 128);
  tail.set(bytes.subarray(full));
  tail[n % 64] = 0x80;
  const tv = new DataView(tail.buffer);
  tv.setUint32(tail.length - 8, (n * 8) % 2 ** 32, true);
  tv.setUint32(tail.length - 4, Math.floor((n * 8) / 2 ** 32), true);
  for (let off = 0; off < tail.length; off += 64) md5Block(st, x, tv, off);
  const out = new Uint8Array(st.buffer);
  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ----------------------------------------------------------------- session --

export class LinkLostError extends Error {
  constructor(msg = 'The unit disconnected.') { super(msg); this.name = 'LinkLostError'; }
}
export class TimeoutError extends Error {
  constructor(msg) { super(msg); this.name = 'TimeoutError'; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, msg) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new TimeoutError(msg)), ms); }),
  ]).finally(() => clearTimeout(t));
}

// Request/reply over a link. A reply matches on command and seq. A resend gets
// a new seq (as the PC tool does), and a late reply to any earlier attempt
// still counts.
export class Session {
  constructor(link, log = () => {}, settings = ASCENT_TRANSPORT) {
    this.link = link;
    this.log = log;
    this.settings = settings;
    this.parser = new FrameParser();
    this.seq = 1;
    this.waiters = new Set();
    this.crcWarned = false;
    this.attach(link);
  }

  attach(link) {
    this.link = link;
    link.onBytes = (b) => this.#feed(b);
    link.onClose = () => {
      for (const w of this.waiters) w.fail(new LinkLostError());
    };
  }

  reset() { this.parser.reset(); }

  #feed(bytes) {
    const before = this.parser.skipped;
    for (const f of this.parser.push(bytes)) {
      if (this.settings.strictReplies && (!f.crcOk || f.type !== 2)) continue;
      if (!f.crcOk && !this.crcWarned) {
        this.crcWarned = true;
        this.log(`reply ${cmdName(f.cmd)} has a CRC that does not match (accepted, as the PC tool does)`, 'warn');
      }
      let taken = false;
      for (const w of this.waiters) if (w.match(f)) { w.deliver(f); taken = true; }
      if (!taken) this.log(`ignored ${cmdName(f.cmd)} seq ${f.seq}`, 'debug');
    }
    if (this.parser.skipped > before) {
      this.log(`skipped ${this.parser.skipped - before} bytes that were not frames`, 'debug');
    }
  }

  #waiter(match) {
    let hit = null, err = null, wake = null;
    const w = {
      match,
      deliver: (f) => { if (!hit) { hit = f; wake?.(); } },
      fail: (e) => { err = e; wake?.(); },
    };
    this.waiters.add(w);
    return {
      next: (ms) => new Promise((resolve, reject) => {
        let t;
        const done = () => {
          clearTimeout(t);
          wake = null;
          if (hit) resolve(hit); else if (err) reject(err); else resolve(null);
        };
        if (hit || err) return done();
        wake = done;
        t = setTimeout(done, Math.max(0, ms));
      }),
      cancel: () => this.waiters.delete(w),
    };
  }

  // retryMs 0 = send once and wait the whole timeout.
  async request(cmd, payload = EMPTY, { expect = cmd, timeoutMs = this.settings.timeouts.request,
    retryMs = this.settings.timeouts.retry } = {}) {
    const seqs = new Set();
    const waiter = this.#waiter((f) => seqs.has(f.seq) && (f.cmd === expect || f.cmd === CMD.UNKNOWN));
    const deadline = Date.now() + timeoutMs;
    try {
      for (let attempt = 0; ; attempt++) {
        const seq = this.seq;
        this.seq = (this.seq + 1) >>> 0;
        seqs.add(seq);
        if (attempt > 0) this.log(`no reply to ${cmdName(cmd)}, sending it again (${attempt})`, 'warn');
        try {
          await this.link.write(encodeFrame({ cmd, seq, retry: attempt, payload }));
        } catch (e) {
          throw new LinkLostError(`Writing to the unit failed: ${e.message}`);
        }
        const left = deadline - Date.now();
        const f = await waiter.next(retryMs > 0 ? Math.min(retryMs, left) : left);
        if (f) {
          if (f.cmd === CMD.UNKNOWN && expect !== CMD.UNKNOWN) {
            throw new Error(`The unit does not know ${cmdName(cmd)}.`);
          }
          return f;
        }
        if (Date.now() >= deadline) throw new TimeoutError(`The unit did not answer ${cmdName(cmd)}.`);
      }
    } finally {
      waiter.cancel();
    }
  }

  async deviceInfo({ timeoutMs = 6000 } = {}) {
    const f = await this.request(CMD.FIND_DEVICE, EMPTY, { timeoutMs, retryMs: 1500 });
    return parseDeviceInfo(f.payload);
  }
}

export const ASCENT_PROTOCOL = Object.freeze({
  createSession: (link, log, settings) => new Session(link, log, settings),
  networkMode: (session) => session.request(CMD.NETWORK_MODE, EMPTY, { timeoutMs: 3000, retryMs: 0 }),
});
export const ASCENT_TRANSPORT = Object.freeze({
  protocol: ASCENT_PROTOCOL,
  serial: Object.freeze({ baudRate: 115200, bufferSize: 65536 }),
  maxChunk: 1 << 20,
  allowZeroDataAckLength: false,
  timeouts: Object.freeze({ request: 8000, retry: 2000, data: 30000,
    updateBoot: 90000, normalBoot: 120000, reboot: 30000, install: 10 * 60000, poll: 500 }),
});

export async function sendFileChunks(session, { bytes, chunkSize, timeoutMs, signal, strictCrc = false,
  allowZeroLength = false, onChunk = () => {} }) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid transfer chunk size.');
  for (let off = 0; off < bytes.length; off += chunkSize) {
    if (signal?.aborted) throw new Error('Cancelled.');
    const part = bytes.subarray(off, Math.min(off + chunkSize, bytes.length));
    // Never resent: the receiving updater appends each data chunk.
    const f = await session.request(CMD.FILE_DATA, part, { timeoutMs, retryMs: 0 });
    const ack = parseFileAck(f.payload), sent = off + part.length;
    // Some air updaters leave Length at zero. Their cumulative and total
    // counters still have to match exactly; staging retains strict lengths.
    const lengthOk = ack.length === part.length || allowZeroLength && ack.length === 0;
    if (strictCrc && !f.crcOk || ack.status !== 0 || ack.detail !== 'OK' || !lengthOk
      || ack.cursize !== sent || ack.totalsize !== bytes.length) {
      throw new Error(`The unit rejected or miscounted chunk ${off / chunkSize + 1}: status ${ack.status} ${ack.detail || '(no detail)'} `
        + `(length ${ack.length}, expected ${part.length}${allowZeroLength ? ' or 0' : ''}; received ${ack.cursize}/${ack.totalsize}, expected ${sent}/${bytes.length}${strictCrc && !f.crcOk ? '; bad reply CRC' : ''}).`);
    }
    onChunk({ index: off / chunkSize + 1, sent, ack });
  }
}

// Small profile-owned staging files, deliberately without FileEnd (which
// starts firmware programming). Reset receiving counters separately per file.
export function uploadUnfinalized(session, file, options) {
  return stageFile(session, file, options, 65536);
}

export function uploadBootstrapBinary(session, file, options) {
  if (file.remotePath !== '/usrdata/fpvos-update' || file.bytes.length < 64
    || ![0x7f, 0x45, 0x4c, 0x46, 2, 1].every((b, i) => file.bytes[i] === b)
    || file.bytes[18] !== 183 || file.bytes[19] !== 0) throw new Error('Invalid AR9311 bootstrap executable/path.');
  return stageFile(session, file, options, 2 << 20);
}

async function stageFile(session, { bytes, remotePath }, { signal, timeoutMs = 8000, chunkSize = 65536 } = {}, limit) {
  if (!bytes.length || bytes.length > limit || !Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid bounded staging payload/chunk size.');
  const abort = () => { if (signal?.aborted) throw new Error('Cancelled.'); };
  const checkControl = (f) => {
    if (!f.crcOk || f.payload.length < 68 || i32(f.payload, 0) !== 0 || cstr(f.payload, 4, 64) !== 'OK') {
      throw new Error(`Staging request rejected or damaged: ${cstr(f.payload, 4, 64) || 'invalid acknowledgment'}.`);
    }
  };
  abort();
  checkControl(await session.request(CMD.REMOTE_UPGRADE, EMPTY, { timeoutMs, retryMs: 0 }));
  abort();
  checkControl(await session.request(CMD.FILE_START, encodeFileStart({
    md5hex: md5hex(bytes), length: bytes.length, remotePath,
    localPath: `/fpvos-flasher/${remotePath.slice(remotePath.lastIndexOf('/') + 1)}`,
  }), { timeoutMs, retryMs: 0 }));
  await sendFileChunks(session, { bytes, chunkSize: Math.min(65536, chunkSize), timeoutMs, signal, strictCrc: true });
}

export async function rebootIntoUpdateMode(session, { mode = 'clean', stage = 'clean',
  timeoutMs = session.settings.timeouts.updateBoot, signal, progress = () => {}, log = () => {} } = {}) {
  const link = session.link;
  progress({ stage, frac: 0.02, text: mode === 'normal' ? 'Rebooting into the selected clean-mode script' : 'Rebooting the unit into update mode' });
  try {
    await session.request(CMD.REBOOT, rebootPayload(mode), { timeoutMs: 8000, retryMs: mode === 'normal' ? 0 : 2000 });
    log(`unit accepted the ${mode} reboot`);
  } catch (e) {
    if (!(e instanceof LinkLostError)) throw e;
    log('unit went away before acknowledging the reboot', 'warn');
  }
  progress({ stage, frac: 0.025, text: 'Waiting for the unit to restart' });
  await withTimeout(link.closed, 30000, 'The unit did not restart.');
  session.reset();
  progress({ stage, frac: 0.03, text: 'Waiting for the update-mode USB serial port' });
  await link.reopen({ timeoutMs, signal });
  session.attach(link);
  await sleep(200);
  if (signal?.aborted) throw new Error('Cancelled.');
  return await session.deviceInfo({ timeoutMs: 15000 });
}
