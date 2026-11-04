// P1 source firmware, independent recovery and browser-only stock preparation.
import { ASCENT_TRANSPORT, ASCENT_PROTOCOL } from '../transports/ascent.js';
import { defineDevice } from './common.js';
import { FPVOS_PREPARE, FPVOS_TRANSFER, FPVOS_INSTALL, FPVOS_REBOOT_VERIFY } from '../stages/fpvos.js';
import { parseFpvosBundle, bundleForBoard } from './fpvos-bundle.js';
import { enterP1Bootloader, prepareP1Recovery, P1_STOCK_USB, P1_HID_FILTER } from '../stages/p1-bootstrap.js';

export const parseP1Bundle = (bytes) => parseFpvosBundle(bytes, {
  board: 1345409867, boardName: 'BETAFPV P1 Air / P1_SKY', maxSize: 16777216,
  names: ['kernel.img', 'betafpv-p1-air.dtb', 'rootfs.cpio.gz'],
  limits: [6291456, 65536, 8388608],
});

export const matchesFpvosP1Air = (info) => info.name === 'fpvOS updater'
  && info.hardware === 'P1_SKY' && info.serial === 'fpvos-p1-air' && info.status === 0;

export const FPVOS_P1_AIR = defineDevice({
  meta: {
    id: 'fpvos-p1-air', name: 'BETAFPV P1 Air · fpvOS', models: ['BETAFPV P1 Air · fpvOS'],
    usb: [{ usbVendorId: 0x1d6b, usbProductId: 0x0104 }],
    deviceVersion: () => null,
    preparation: Object.freeze({ enterBootloader: enterP1Bootloader, loadRecovery: prepareP1Recovery,
      serialFilter: P1_STOCK_USB, hidFilter: P1_HID_FILTER }),
    identity: { matches: matchesFpvosP1Air, normalMatches: (a, b) => matchesFpvosP1Air(a) && matchesFpvosP1Air(b) },
    image: { pattern: /\.fwu$/i, detect: (b) => bundleForBoard(b, 1345409867), parse: parseP1Bundle,
      columns: ['Component', 'Size', 'Offset', 'Update flag'],
      checks: (p) => [['Bundle SHA-256', p.sha256 ?? ''], ['Operation', 'Install fpvOS']] },
    notices: { flash: 'Keep external power connected throughout the update. Requires the P1 fpvOS updater or clean recovery; prepare stock 1.0.44 using the browser controls in the Device panel first. The device checks the supported P1_SKY 1.0.44 NAND layout and preserves stock bank 1, factory calibration and user settings. Unsigned development firmware; keep a verified backup and recovery access.' },
  },
  transport: Object.freeze({ ...ASCENT_TRANSPORT, strictReplies: true,
    protocol: Object.freeze({ createSession: ASCENT_PROTOCOL.createSession }),
    timeouts: Object.freeze({ ...ASCENT_TRANSPORT.timeouts, connect: 30000, install: 15 * 60000 }) }),
  stages: { preflash: [FPVOS_PREPARE], flash: [FPVOS_TRANSFER, FPVOS_INSTALL], postflash: [FPVOS_REBOOT_VERIFY] },
});
