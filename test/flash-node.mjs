#!/usr/bin/env node
// Linux CLI over the same hardware profiles and protocol as the browser.
import fs from 'node:fs';
import path from 'node:path';
import { findSerialDevice, NodeSerialLink } from '../transports/node-serial.mjs';
import { USB_FILTERS, profileForUsb, profileForDevice } from '../devices/index.js';
import { prepareFirmware, flashFirmware, evaluateSelection } from '../flasher.js';

const log = (m, level = 'info') => console.log(`${new Date().toISOString().slice(11, 23)} ${level.padEnd(5)} ${m}`);

async function main() {
  const [cmd, file] = process.argv.slice(2);
  if (!['info', 'flash'].includes(cmd) || cmd === 'flash' && !file) throw new Error('usage: node test/flash-node.mjs info | flash IMG');
  const device = findSerialDevice(USB_FILTERS);
  if (!device) throw new Error('no supported Ascent serial port');
  const usbProfile = profileForUsb(device.usbInfo);
  const link = new NodeSerialLink(device, { filters: usbProfile.meta.usb, serial: usbProfile.transport.serial, log: console.error });
  try {
    await link.open();
    const session = usbProfile.transport.protocol.createSession(link, log, usbProfile.transport);
    const info = await session.deviceInfo();
    const profile = profileForDevice(info, device.usbInfo);
    console.log(JSON.stringify(info, null, 2));
    if (cmd === 'flash') {
      const image = await prepareFirmware(new File([fs.readFileSync(file)], path.basename(file)), { profile });
      const checks = evaluateSelection({ info, profile, image, unlockOverride: false }).issues;
      if (checks.some((c) => c.level === 'error')) throw new Error(checks.filter((c) => c.level === 'error').map((c) => c.text).join(' '));
      checks.filter((c) => c.level === 'warn').forEach((c) => log(c.text, 'warn'));
      const after = await flashFirmware(session, profile, image, {
        info, usbInfo: device.usbInfo, log, progress: ({ text }) => log(text),
      });
      log(`done; unit reports ${JSON.stringify(after)}`);
    }
  } finally { await link.close(); }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
