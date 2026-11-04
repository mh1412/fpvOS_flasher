// Linux link adapter, independent of the hardware registry.
import fs from 'node:fs';
import path from 'node:path';
import tty from 'node:tty';
import { execFileSync } from 'node:child_process';
import { sleep } from './ascent.js';

export function findSerialDevice(filters, usbPath) {
  for (const n of fs.readdirSync('/sys/class/tty').filter((x) => x.startsWith('ttyACM'))) {
    try {
      const usbDev = path.dirname(fs.realpathSync(`/sys/class/tty/${n}/device`));
      if (usbPath && usbDev !== usbPath) continue;
      const usbInfo = {
        usbVendorId: parseInt(fs.readFileSync(`${usbDev}/idVendor`, 'utf8').trim(), 16),
        usbProductId: parseInt(fs.readFileSync(`${usbDev}/idProduct`, 'utf8').trim(), 16),
      };
      if (filters.some((u) => u.usbVendorId === usbInfo.usbVendorId && u.usbProductId === usbInfo.usbProductId)) {
        return { dev: `/dev/${n}`, usbInfo, usbPath: usbDev };
      }
    } catch { /* not USB */ }
  }
  return null;
}

export class NodeSerialLink {
  constructor(device, { filters, serial = { baudRate: 115200 }, log = () => {} }) {
    this.device = device;
    this.filters = filters;
    this.serial = serial;
    this.log = log;
    this.onBytes = null;
    this.onClose = null;
    this.closed = Promise.resolve();
  }

  async open() {
    const { dev } = this.device;
    execFileSync('stty', ['-F', dev, 'raw', '-echo', '-echoe', '-echok', '-echoctl', '-echoke', '-hupcl', String(this.serial.baudRate)]);
    this.wfd = fs.openSync(dev, fs.constants.O_WRONLY | fs.constants.O_NOCTTY);
    const rfd = fs.openSync(dev, fs.constants.O_RDONLY | fs.constants.O_NOCTTY);
    this.rs = new tty.ReadStream(rfd);
    this.rs.setRawMode(true);
    this.closed = new Promise((r) => { this.markClosed = r; });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.markClosed();
      this.onClose?.();
    };
    this.rs.on('data', (b) => this.onBytes?.(new Uint8Array(b)));
    this.rs.on('error', end);
    this.rs.on('end', end);
    this.rs.on('close', end);
    this.log(`[link] opened ${dev}`);
  }

  async write(bytes) {
    let off = 0;
    while (off < bytes.length) {
      off += await new Promise((resolve, reject) => fs.write(this.wfd, bytes, off, bytes.length - off, null,
        (e, n) => e ? reject(e) : resolve(n)));
    }
  }

  async close() {
    try { this.rs?.destroy(); } catch { /* gone */ }
    try { if (this.wfd != null) fs.closeSync(this.wfd); } catch { /* gone */ }
    this.wfd = null;
    await this.closed;
  }

  async reopen({ timeoutMs = 90000, signal, filters, acceptDevice } = {}) {
    await this.close();
    if (filters) this.filters = filters;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Cancelled.');
      try {
        const device = findSerialDevice(this.filters, this.device.usbPath);
        if (!device) throw new Error('waiting for the original USB profile');
        this.device = device;
        await this.open();
        if (acceptDevice && !await acceptDevice()) throw new Error('wrong updater identity');
        return;
      } catch { await this.close(); await sleep(500); }
    }
    throw new Error('the unit did not come back');
  }
}
