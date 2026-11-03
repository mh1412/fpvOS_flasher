// New-kernel Gnd485 recovery service; not the stock-kernel root-only profile.
import { ASCENT_TRANSPORT, ASCENT_PROTOCOL } from '../transports/ascent.js';
import { defineDevice } from './common.js';
import { FPVOS_PREPARE, FPVOS_TRANSFER, FPVOS_INSTALL, FPVOS_REBOOT_VERIFY } from '../stages/fpvos.js';

import { parseFpvosBundle as parseBundle, bundleForBoard } from './fpvos-bundle.js';
export { isFpvosBundle } from './fpvos-bundle.js';

export const parseFpvosBundle = (bytes) => parseBundle(bytes, {
  board: 485, boardName: 'fpvOS AR9311 / Gnd485', restore: true, maxSize: 21757952,
  names: ['kernel.img', 'ascent-gnd485.dtb', 'rootfs.cpio.uboot'],
  limits: [0x600000, 0x60000, 0x1000000],
});

export const matchesFpvosAr9311 = (info) => ['fpvOS updater', 'fpvOS AR9311 updater'].includes(info.name)
  && info.hardware === 'Gnd485' && info.serial === 'fpvos-ar9311' && info.status === 0;

export const FPVOS_AR9311 = defineDevice({
  meta: {
    id: 'fpvos-ar9311', name: 'Ascent VRX · fpvOS', models: ['Ascent VRX · fpvOS'],
    usb: [{ usbVendorId: 0x1d6b, usbProductId: 0x0104 }],
    deviceVersion: () => null,
    identity: { matches: matchesFpvosAr9311, normalMatches: (a, b) => matchesFpvosAr9311(a) && matchesFpvosAr9311(b) },
    image: { pattern: /\.fwu$/i, detect: (b) => bundleForBoard(b, 485), parse: parseFpvosBundle,
      columns: ['Component', 'Size', 'Offset', 'Update flag'],
      checks: (p) => [['Bundle SHA-256', p.sha256 ?? ''], ['Operation', p.kind === 1 ? 'Restore original stock kernel/DTB' : 'Install fpvOS']] },
    notices: { flash: 'Keep external DC power connected. Shared kernel/DTB writes are not power-loss atomic. Keep original partition backups and a working U-Boot RAM recovery path. Stock restoration requires an original-backup restoration bundle; vendor .img files are not yet supported by this service.' },
  },
  transport: Object.freeze({ ...ASCENT_TRANSPORT, strictReplies: true,
    protocol: Object.freeze({ createSession: ASCENT_PROTOCOL.createSession }),
    timeouts: Object.freeze({ ...ASCENT_TRANSPORT.timeouts, connect: 30000, install: 15 * 60000 }) }),
  stages: { preflash: [FPVOS_PREPARE], flash: [FPVOS_TRANSFER, FPVOS_INSTALL], postflash: [FPVOS_REBOOT_VERIFY] },
});
