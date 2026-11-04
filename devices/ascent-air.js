// Ascent Lite / Lite+ H_Sky firmware layout, selected by the air profile.
// 128-byte ASW header followed by five components; not the VRX OTRA layout.
import { crc32 } from '../checksum.js';
import { ASCENT_TRANSPORT } from '../transports/ascent.js';
import { aswBoard } from '../firmware.js';
import { defineDevice, aswImage, sameFactoryIdentity, formatHex } from './common.js';
import { ASCENT_ENTER_UPDATE, VERIFY_UPDATE_MODE, ASCENT_FLASH_STEPS, ASCENT_POSTFLASH_STEPS } from '../stages/ascent.js';

const BOARD_NAMES = { 1: 'Ascent ground unit (L_Gnd)', 3: 'Ascent air unit (H_Sky)', 5: 'Ascent VRX (G_Gnd)' };
const SECTION_NAMES = { 0: 'boot', 1: 'env', 2: 'kernel', 4: 'rootfs', 5: 'fpv' };
// NAND partitions from stock mtdparts. Descriptor "alloc" is not a limit:
// the stock kernel itself can exceed its declared allocation.
const PART_SIZE = { 2: 4 << 20, 4: 16 << 20, 5: 32 << 20 };

// Header: ASW magic, board at 4, version at 8/12/16, five 12-byte
// descriptors at 0x14, payload CRC at 0x70 and total file size at 0x74.
export function parseAirImage(bytes, fileName = '') {
  const errors = [], warnings = [];
  const r = { errors, warnings, sections: [] };
  const board = aswBoard(bytes);
  if (board == null) {
    errors.push('Not a firmware image this profile knows (no ASW header).');
    return r;
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  r.board = board;
  r.boardName = BOARD_NAMES[board] ?? `unknown board ${board}`;
  r.version = [v.getUint32(8, true), v.getUint32(12, true), v.getUint32(16, true)];
  r.versionText = r.version.join('.');
  if (board !== 3) {
    errors.push(`This image is for the ${r.boardName}, not an H_Sky air unit. Use its hardware profile.`);
    return r;
  }
  r.sizeStored = v.getUint32(0x74, true);
  r.crcStored = v.getUint32(0x70, true);
  r.crcCalc = crc32(bytes.subarray(0x80));
  if (r.sizeStored !== bytes.length) {
    errors.push(`The file is ${bytes.length} bytes but its header says ${r.sizeStored}: truncated or damaged.`);
  }
  if (r.crcStored !== r.crcCalc) errors.push('Checksum mismatch: the file is damaged.');

  for (let i = 0; i < 5; i++) {
    const o = 0x14 + 12 * i;
    r.sections.push({
      id: bytes[o],
      name: SECTION_NAMES[bytes[o]] ?? `id${bytes[o]}`,
      upgrade: bytes[o + 1] === 1,
      alloc: v.getUint32(o + 4, true),
      offset: v.getUint32(o + 8, true),
    });
  }
  r.sections.forEach((s, i) => {
    const end = i + 1 < r.sections.length ? r.sections[i + 1].offset : bytes.length;
    s.length = end - s.offset;
    if (s.offset < 0x80 || s.length < 0 || end > bytes.length) {
      errors.push(`Section ${s.name} lies outside the file.`);
    } else if (PART_SIZE[s.id] && s.length > PART_SIZE[s.id]) {
      errors.push(`Section ${s.name} (${s.length} bytes) does not fit its ${PART_SIZE[s.id] >> 20} MiB partition.`);
    }
  });

  // The updater takes its version from the filename; use the ASW version.
  r.remoteName = `Ascent_H_Sky_${r.version.join('_')}.img`;
  const m = /(\d+)_(\d+)_(\d+)\.img$/i.exec(fileName);
  if (fileName && !m) {
    warnings.push(`The file name has no version; it will be sent as ${r.remoteName}.`);
  } else if (m && m.slice(1).join('.') !== r.versionText) {
    warnings.push(`The file name says ${m.slice(1).join('.')} but the image is ${r.versionText}; it will be sent as ${r.remoteName}.`);
  }
  return r;
}

const matchesAir = (info) => /^(Ascent_H_Sky|Ascent_Lite(?:_?\+|_plus)?|Ascent_Lite_Plus)$/i.test(info.name ?? '')
  && (!info.firmware || /^Ascent_H_Sky(?:_\d+_\d+_\d+)?$/i.test(info.firmware));
function airNormalMatches(current, before) {
  if (!matchesAir(current) || !matchesAir(before)) return false;
  if (sameFactoryIdentity(current, before)) return true;
  // Newer Lite firmware changes the presentation of the same factory data.
  // Limit compatibility to the observed H_Sky/Lite transition, serial prefix,
  // and trailing 1.0 -> 1.1 report; board and main hardware revision stay exact.
  const legacy = /^Ascent_H_Sky$/i.test(before.name ?? '') ? before : current;
  const lite = legacy === before ? current : before;
  return /^Ascent_H_Sky$/i.test(legacy.name ?? '') && /^Ascent_Lite$/i.test(lite.name ?? '')
    && !!legacy.serial && (lite.serial === legacy.serial || lite.serial === `1_${legacy.serial}`)
    && /^FPV-Ascent-Sky-\d+-V\d+\.\d+-\d+\.\d+$/.test(legacy.hardware ?? '')
    && (lite.hardware === legacy.hardware || legacy.hardware.endsWith('-1.0')
      && lite.hardware === legacy.hardware.slice(0, -1) + '1');
}
// Some air clean updaters replace the model and factory fields with these
// placeholders. Accept them only after identifying the original air unit.
const airUpdateMatches = (current, before, phase) => matchesAir(before) && (airNormalMatches(current, before)
  || phase === 'clean' && current.name === 'Ascent' && current.hardware === 'FPV-Edu-Sky-V0.0-0.0'
    && current.serial === '' && current.firmware === before.firmware && /^Ascent_H_Sky_\d+_\d+_\d+$/.test(current.firmware ?? '')
    && current.status === 0 && (current.detail === 'OK' || current.detail === ''));

export const ASCENT_AIR = defineDevice({
  meta: {
    id: 'ascent-air', name: 'Ascent Lite / Lite+ air unit', models: ['Ascent Lite air unit', 'Ascent Lite+ air unit'],
    usb: [{ usbVendorId: 0x1d76, usbProductId: 0x0101 }],
    identity: { matches: matchesAir, normalMatches: airNormalMatches, updateMatches: airUpdateMatches },
    image: aswImage({ prefix: 'Ascent_H_Sky', board: 3, parse: parseAirImage,
      checks: (p) => [['CRC-32', p.crcStored == null ? '' : p.crcStored === p.crcCalc
        ? `OK · ${formatHex(p.crcCalc)}` : `bad: ${formatHex(p.crcStored)} in header, file is ${formatHex(p.crcCalc)}`,
      p.crcStored === p.crcCalc ? 'good' : '']] }),
    notices: {
      flash: 'The air unit updates banked kernel/root/application components; boot and environment can be written in place. Keep it powered and connected until it restarts.',
      network: 'The air unit leaves serial mode until it reboots, and this page loses it.',
    },
  },
  transport: Object.freeze({ ...ASCENT_TRANSPORT, allowZeroDataAckLength: true }),
  stages: { preflash: [ASCENT_ENTER_UPDATE, VERIFY_UPDATE_MODE], flash: ASCENT_FLASH_STEPS, postflash: ASCENT_POSTFLASH_STEPS },
});
