// Standard Ascent VRX (Proxima-9311), not VRX Pro / Rockchip or Avatar.
// ASW board 5 prefix + modern 256-byte OTRA header, SHA-256 and RSA-2048.
// Layout and trust key verified against stock 17.5.8 and live VRX 17.5.3.
import { firmwareVersion } from '../firmware.js';
import { defineDevice, aswImage, sameFactoryIdentity } from './common.js';
import { VRX_PREPARE_UPDATE_MODE, VRX_UNLOCK_VERSION } from '../stages/vrx-unlock.js';
import { VERIFY_UPDATE_MODE, ASCENT_FLASH_STEPS, ASCENT_POSTFLASH_STEPS } from '../stages/ascent.js';

const td = new TextDecoder();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const OTRA = 0x80, BODY = 0x2a0;
const FLASH_SIZE = 128 * (1 << 20);

// Public modulus from /etc/artosyn_upgrade_public_rsa2048.pem (DER SPKI).
// DER SHA-256: 8a6557918855a74d60d1ff60ca437859344700800a9155815e200aa9788363a6.
// This key belongs to standard VRX only; it is not a universal Ascent key.
export const VRX_PUBLIC_KEY = Object.freeze({
  modulus: 'b33f235a606c234425bf54deb850895c5aa2661449e420c3bb3da93cc33f51b9'
    + 'cbd51ae0225af18a8a72edd63767df5fab85557735643cc5d148cfc733eecbbdcc'
    + '083b499a2b04e605c089f98d633093b2afdbd90ab1aa85ec380aa90e7575be34df'
    + '21a54e1bedf44ef3833ff02ffad2828c7853d563561c2ddd3d67759a3a41e25a98'
    + '4d3c01c39cd15dec570c121901b6eda11a8897f06ed3f0c9419b55beaf98dc3207'
    + '6e83f02f68dbb98c41ee12ac57258c336cb90556ff2cf2833e660acfe6152761c8ae'
    + 'b9a98e4f0c18f89d03a45234b784c8ab9bf02619af44554f3506fa3b8dd39a0e00'
    + 'e7faa130474d5f5e8b6f72077be32ac823f53629f1573c2279',
  exponent: 65537,
});

// Match the receiver's recovered-digest-tail comparison. This deliberately
// does not claim stricter PKCS#1 padding verification than its own updater.
export function verifyDigestTail(signature, digest, key = VRX_PUBLIC_KEY) {
  if (signature.length !== 256 || digest.length !== 32) return false;
  const modulus = BigInt(`0x${key.modulus}`);
  let base = BigInt(`0x${hex(signature)}`);
  if (base >= modulus) return false;
  let exp = BigInt(key.exponent), result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = result * base % modulus;
    base = base * base % modulus;
    exp >>= 1n;
  }
  return result.toString(16).padStart(512, '0').slice(-64) === hex(digest);
}

export async function parseVrx(bytes, fileName = '', { publicKey = VRX_PUBLIC_KEY } = {}) {
  const r = { errors: [], warnings: [], sections: [], segments: [] };
  const fail = (text) => r.errors.push(text);
  if (bytes.length < BODY || td.decode(bytes.subarray(0, 4)) !== 'ASW\0') {
    fail('Not a standard Ascent VRX image (missing or truncated ASW/OTRA header).');
    return r;
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  r.board = v.getUint32(4, true);
  r.boardName = 'Ascent VRX (G_Gnd)';
  r.version = [8, 12, 16].map((o) => v.getUint32(o, true));
  r.versionText = r.version.join('.');
  r.remoteName = `Ascent_G_Gnd_${r.version.join('_')}.img`;
  if (r.board !== 5) fail(`Standard Ascent VRX needs ASW board 5, not board ${r.board}.`);
  if (td.decode(bytes.subarray(OTRA, OTRA + 4)) !== 'OTRA'
    || v.getUint16(OTRA + 4, true) !== 0x0101
    || bytes[OTRA + 6] !== 2 || bytes[OTRA + 7] !== 2
    || v.getUint16(OTRA + 10, true) !== 32 || v.getUint16(OTRA + 12, true) !== 256) {
    fail('Unsupported VRX OTRA format (expected modern NAND header, SHA-256 and RSA-2048).');
    return r;
  }

  // All 64-bit lengths/offsets must be exact JS integers before arithmetic.
  const u64 = (o) => {
    const n = v.getBigUint64(o, true);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('OTRA length or offset exceeds the supported range.');
    return Number(n);
  };
  try {
    const declared = u64(OTRA + 16);
    if (declared !== bytes.length - BODY) fail('OTRA body size does not match the file: truncated or damaged.');
    const partCount = v.getUint16(OTRA + 32, true);
    const segmentCount = v.getUint16(OTRA + 34, true);
    const tables = BODY + v.getUint16(OTRA + 8, true)
      + v.getUint32(OTRA + 24, true) + v.getUint32(OTRA + 28, true);
    const dataStart = tables + partCount * 52 + segmentCount * 32;
    if (!partCount || partCount > 128 || !segmentCount || dataStart > bytes.length) {
      fail('OTRA partition/segment tables lie outside the file or have unsupported counts.');
      return r;
    }
    const names = new Set();
    for (let i = 0; i < partCount; i++) {
      const o = tables + i * 52;
      const rawName = bytes.subarray(o, o + 32);
      const end = rawName.indexOf(0);
      const name = td.decode(rawName.subarray(0, end < 0 ? 32 : end));
      const start = u64(o + 32), size = u64(o + 40);
      const flags = v.getUint32(o + 48, true);
      if (!/^[A-Za-z0-9_+-]+$/.test(name) || names.has(name)
        || size <= 0 || start + size > FLASH_SIZE || flags > 1) {
        fail(`Invalid VRX partition ${name || i} (name, flags or NAND bounds).`);
      }
      if (r.sections.some((s) => start < s.flashOffset + s.length && s.flashOffset < start + size)) {
        fail(`VRX partition ${name} overlaps another partition.`);
      }
      names.add(name);
      r.sections.push({ name, length: size, flashOffset: start, offset: null, upgrade: flags === 1, storedLength: 0 });
    }
    for (let i = 0; i < segmentCount; i++) {
      const o = tables + partCount * 52 + i * 32;
      const offset = OTRA + u64(o), flashOffset = u64(o + 8);
      const length = u64(o + 16), rawLength = u64(o + 24);
      const part = r.sections.find((s) => flashOffset >= s.flashOffset && flashOffset < s.flashOffset + s.length);
      if (offset < dataStart || length <= 0 || offset + length > bytes.length) {
        fail(`VRX segment ${i + 1} lies outside the file.`);
      }
      if (!part || rawLength <= 0 || flashOffset + rawLength > part.flashOffset + part.length) {
        fail(`VRX segment ${i + 1} does not fit a NAND partition.`);
      }
      if (r.segments.some((s) => offset < s.offset + s.length && s.offset < offset + length
        || flashOffset < s.flashOffset + s.rawLength && s.flashOffset < flashOffset + rawLength)) {
        fail(`VRX segment ${i + 1} overlaps another segment.`);
      }
      if (part) {
        part.offset ??= offset;
        part.storedLength += length;
      }
      r.segments.push({ offset, length, flashOffset, rawLength });
    }
  } catch (e) {
    fail(e.message);
  }

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.subarray(BODY)));
  r.shaStored = hex(bytes.subarray(0x180, 0x1a0));
  r.shaCalc = hex(digest);
  r.hashOk = r.shaStored === r.shaCalc;
  r.signatureOk = verifyDigestTail(bytes.subarray(0x1a0, BODY), digest, publicKey);
  if (!r.hashOk) fail('SHA-256 mismatch: the VRX authenticated body is damaged.');
  if (!r.signatureOk) fail('RSA signature does not match the standard VRX trust key. The stock updater will reject this image.');
  if (fileName && fileName !== r.remoteName) {
    r.warnings.push(`The image will be sent as ${r.remoteName}, using the version in its ASW header.`);
  }
  return r;
}

const matchesVrx = (info) => /^Ascent[_ ]VRX$/i.test(info.name ?? '')
  && (!info.firmware || /^Ascent_G_Gnd(?:_\d+_\d+_\d+)?$/i.test(info.firmware));
const hardwareVrx = (info) => /^FPV-Ascent-Gnd-485-V\d+\.\d+-\d+\.\d+$/.test(info.hardware ?? '');
const cleanHardware = 'FPV-Ascent-Gnd-485-V0.0-0.0';
export const canUnlockVrx = (info) => !!info && /^Ascent_G_Gnd_\d+_\d+_\d+$/.test(info.firmware ?? '')
  && firmwareVersion(info.firmware)?.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)
  && info.name === 'Ascent_VRX' && !!info.serial && hardwareVrx(info) && info.hardware !== cleanHardware
  && info.status === 0 && info.detail === 'OK';
export const matchesVrxUnlocked = (current, before) => canUnlockVrx(before)
  && current.name === before.name && current.firmware === `Ascent_G_Gnd_${VRX_UNLOCK_VERSION.replaceAll('.', '_')}`
  && current.sdk === VRX_UNLOCK_VERSION && current.serial === '' && current.hardware === cleanHardware
  && current.status === 0 && current.detail === 'OK';
export const vrxUpdateMatches = (current, before, phase) => matchesVrx(current) && (phase === 'unlock' ? matchesVrxUnlocked(current, before)
  : sameFactoryIdentity(current, before) || phase === 'clean' && !!before.serial && current.serial === '' && hardwareVrx(before)
    && current.hardware === cleanHardware && current.name === before.name && current.firmware === before.firmware
    && current.status === 0 && current.detail === 'OK');

export const ASCENT_VRX = defineDevice({
  meta: {
    id: 'ascent-vrx', name: 'Ascent VRX · Stock', models: ['Ascent VRX · Stock'],
    usb: [{ usbVendorId: 0x1d75, usbProductId: 0x0101 }],
    identity: { matches: matchesVrx, normalMatches: sameFactoryIdentity, updateMatches: vrxUpdateMatches },
    image: aswImage({ prefix: 'Ascent_G_Gnd', board: 5, parse: parseVrx, capacity: true,
      checks: (p) => [
        ['Body SHA-256', p.shaCalc ? `${p.hashOk ? 'OK' : 'Mismatch'} · ${p.shaCalc}` : '', p.hashOk ? 'good' : ''],
        ['RSA signature', p.signatureOk == null ? '' : p.signatureOk
          ? 'OK · standard VRX key (receiver digest-tail check)' : 'Invalid for standard VRX key', p.signatureOk ? 'good' : ''],
      ] }),
    unlock: {
      supported: canUnlockVrx, label: 'Unlock before flashing (allow older firmware)',
      notice: 'A one-shot clean-mode script will overlay the current version with 0.0.0 in RAM, initialize the stock USB updater, and then flash this image. The staged script removes itself; the overlay disappears on reboot. Stock image signature checks still apply.',
    },
    notices: {
      flash: 'Keep the VRX on external DC power and USB connected until it restarts. Its updater verifies the stock RSA signature, then writes both single and paired NAND partitions, including boot components. This is not an atomic whole-system A/B update; persistent application changes may be replaced.',
      network: 'The standard VRX normally exposes USB networking alongside serial. This asks its updater to enable RNDIS; USB may re-enumerate.',
    },
  },
  stages: { preflash: [VRX_PREPARE_UPDATE_MODE, VERIFY_UPDATE_MODE], flash: ASCENT_FLASH_STEPS, postflash: ASCENT_POSTFLASH_STEPS },
});
