// A fake navigator.serial with a simulated Ascent device behind it, injected into
// the page by browser-check.mjs before app.js runs. It mimics how Chrome
// behaves: a reboot errors the readable stream, fires "disconnect", and the
// unit comes back as a new SerialPort with a "connect" event.
//
// window.__fake = { regrant: false } makes the rebooted unit missing from
// getPorts(), as when Chrome does not keep the permission.

(() => {
  const params = new URLSearchParams(location.search);
  const readyAt = Date.now() + Number(params.get('startupDelay') ?? 0);
  const type = params.get('device') ?? 'air';
  const rejectData = params.has('rejectData');
  const installFailure = params.has('installFailure');
  const VID = type === 'air' ? 0x1d76 : 0x1d75;
  let custom = type === 'fpvos' || type === 'p1';
  const stockP1 = type === 'p1stock';   // a stock P1 on its Sirius serial port, not yet fpvOS
  const name = type === 'air' ? 'Ascent_H_Sky' : type === 'vrx' ? 'Ascent_VRX' : 'Ascent_VRX_Pro';
  const factory = { name, serial: 'FAKE0001', hardware: type === 'air' ? 'FPV-Ascent-Sky-482-V1.3-1.0'
    : type === 'vrx' ? 'FPV-Ascent-Gnd-485-V1.2-1.0' : 'HW_V1.0' };
  let firmware = `${type === 'air' ? 'Ascent_H_Sky' : 'Ascent_G_Gnd'}_${params.get('fw') ?? (type === 'air' ? '18_21_10' : '17_5_3')}`;
  const staged = new Map();
  const fake = window.__fake = Object.assign({ regrant: true, bootMs: 600, log: [] }, window.__fake || {});
  fake.starts = []; fake.rebootPayloads = [];
  const serial = new EventTarget();
  let A = null;   // protocol module, loaded on first use
  let granted = [];
  let device = null;

  function fire(type, port) {
    const ev = new Event(type);
    Object.defineProperty(ev, 'target', { value: port });
    serial.dispatchEvent(ev);
  }

  class FakePort extends EventTarget {
    constructor(dev) { super(); this.dev = dev; this.readable = null; this.writable = null; }

    getInfo() {
      if (this.dev.stockP1) return { usbVendorId: 0x1d6b, usbProductId: 0x0101 };
      return this.dev.custom ? { usbVendorId: 0x1d6b, usbProductId: 0x0104 } : { usbVendorId: VID, usbProductId: 0x0101 };
    }

    async open() {
      if (!this.dev.present || this.dev.port !== this) throw new DOMException('Failed to open serial port.', 'NetworkError');
      if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError');
      A = A || await import('/transports/ascent.js');
      this.readable = new ReadableStream({ start: (c) => { this.ctrl = c; } });
      this.writable = new WritableStream({
        write: (chunk) => {
          if (!this.dev.present) throw new DOMException('The device has been lost.', 'NetworkError');
          this.dev.receive(chunk);
        },
      });
    }

    async close() {
      this.readable = null;
      this.writable = null;
    }

    lose() {
      try { this.ctrl?.error(new DOMException('The device has been lost.', 'NetworkError')); } catch { /* closed */ }
      this.readable = null;
      this.writable = null;
    }
  }

  class FakeUnit {
    constructor(mode) {
      this.mode = mode;
      this.custom = custom;
      this.stockP1 = stockP1;
      this.present = true;
      this.port = new FakePort(this);
      this.parser = null;
      this.status = 0;
    }

    send(f, payload = new Uint8Array(0)) {
      const out = A.encodeFrame({ cmd: f.cmd, seq: f.seq, payload, type: 2 });
      setTimeout(() => { try { this.port.ctrl?.enqueue(out); } catch { /* lost */ } }, 2);
    }

    struct(size, fill) {
      const p = new Uint8Array(size);
      const v = new DataView(p.buffer);
      fill((off, n) => v.setInt32(off, n, true), (off, s) => p.set(new TextEncoder().encode(s), off));
      return p;
    }

    receive(bytes) {
      // A stock P1 speaks U-Boot's raw USB protocol, not our frames: capture the
      // restart command enterP1Bootloader writes, the way detection relies on.
      if (this.stockP1) { fake.p1RebootRaw = Array.from(bytes); return; }
      this.parser = this.parser || new A.FrameParser({ maxPayload: 4 << 20 });
      for (const f of this.parser.push(bytes)) {
        fake.log.push(`${this.mode} ${A.cmdName(f.cmd)} seq ${f.seq} crc ${f.crcOk}`);
        this.handle(f);
      }
    }

    handle(f) {
      const C = A.CMD;
      if (f.cmd === C.FIND_DEVICE) {
        if (Date.now() < readyAt) return;
        if (this.custom) return this.send(f, this.struct(300, (i32, str) => {
          i32(0, 1 << 20); str(4, 'development'); str(36, 'fpvOS updater');
          str(104, /^[a-f0-9]{64}$/.test(firmware) ? firmware : 'fpvOS unsigned development updates');
          str(168, type === 'p1' ? 'fpvos-p1-air' : 'fpvos-ar9311'); str(200, type === 'p1' ? 'P1_SKY' : 'Gnd485'); str(236, this.mode === 'clean' ? 'clean RAM mode' : 'normal mode');
        }));
        const current = this.mode === 'unlocked' && !params.has('unlockFails') ? 'Ascent_G_Gnd_0_0_0' : firmware;
        const airClean = type === 'air' && this.mode === 'clean';
        return this.send(f, this.struct(300, (i32, str) => {
          i32(0, 1 << 20); str(4, airClean ? '' : current.split('_').slice(-3).join('.')); str(36, airClean ? 'Ascent' : factory.name); i32(100, airClean ? 0 : 51);
          str(104, current); str(168, airClean || type === 'vrx' && this.mode !== 'normal' ? '' : factory.serial);
          str(200, airClean ? 'FPV-Edu-Sky-V0.0-0.0' : type === 'vrx' && this.mode !== 'normal' ? 'FPV-Ascent-Gnd-485-V0.0-0.0' : factory.hardware);
          str(236, 'OK');
        }));
      }
      if (f.cmd === C.REBOOT) {
        const request = new TextDecoder().decode(f.payload).replace(/\0.*$/s, '');
        this.send(f, this.custom ? this.struct(68, (i32, str) => { i32(0,0); str(4, type === 'p1' && request === 'clean' ? 'rebooting into clean RAM mode' : 'OK'); }) : undefined);
        fake.rebootPayloads.push(request);
        if (this.custom && request === 'clean') { if (type === 'p1') return reboot('clean'); this.mode = 'clean'; return; }
        let mode = request === 'clean' ? 'clean' : 'normal';
        if (request === 'normal' && staged.has('/factory/sirius-clean-system-flag')) {
          const flag = new TextDecoder().decode(staged.get('/factory/sirius-clean-system-flag'));
          const scriptPath = /^web:(\/usrdata\/fpvos-unlock-[a-f0-9]{32}\.sh)\n$/.exec(flag)?.[1];
          if (flag === 'web:/usrdata/fpvos-bootstrap.sh\n' && staged.has('/usrdata/fpvos-update') && staged.has('/usrdata/fpvos-bootstrap.sh')) {
            custom = true; mode = 'clean'; fake.bootstrap = true;
            staged.delete('/usrdata/fpvos-update'); staged.delete('/usrdata/fpvos-bootstrap.sh');
          } else mode = scriptPath && staged.has(scriptPath) ? 'unlocked' : 'clean';
          staged.delete('/factory/sirius-clean-system-flag'); staged.delete(scriptPath);
        }
        return reboot(mode);
      }
      if (f.cmd === C.REMOTE_UPGRADE) {
        this.file = null;
        return this.send(f, this.struct(68, (i32, str) => { i32(0, 0); str(4, 'OK'); }));
      }
      if (f.cmd === C.FILE_START) {
        const v = new DataView(f.payload.buffer, f.payload.byteOffset);
        this.file = { md5: new TextDecoder().decode(f.payload.subarray(0, 32)), length: v.getInt32(64, true), parts: [], got: 0 };
        fake.remotePath = new TextDecoder().decode(f.payload.subarray(72, 200)).replace(/\0.*$/s, '');
        this.file.path = fake.remotePath;
        fake.starts.push(fake.remotePath);
        return this.send(f, this.struct(68, (i32, str) => { i32(0, 0); str(4, 'OK'); }));
      }
      if (f.cmd === C.FILE_DATA) {
        this.file.parts.push(f.payload);
        this.file.got += f.payload.length;
        if (!this.file.path.endsWith('.img')) {
          const all = new Uint8Array(this.file.got); let offset = 0;
          for (const p of this.file.parts) { all.set(p, offset); offset += p.length; }
          staged.set(this.file.path, all);
        }
        return this.send(f, this.struct(80, (i32, str) => {
          i32(0, type === 'air' ? 0 : f.payload.length); i32(4, this.file.got); i32(8, this.file.length);
          i32(12, rejectData ? -1 : 0); str(16, rejectData ? 'write failed' : 'OK');
        }));
      }
      if (f.cmd === C.FILE_END) {
        const all = new Uint8Array(this.file.got);
        let o = 0;
        for (const p of this.file.parts) { all.set(p, o); o += p.length; }
        const ok = A.md5hex(all) === this.file.md5;
        fake.md5ok = ok;
        if (this.custom) {
          crypto.subtle.digest('SHA-256', all).then((digest) => {
            this.nextFirmware = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2,'0')).join('');
            this.send(f, this.struct(80, (i32, str) => {
              i32(4,this.file.got); i32(8,this.file.length); i32(12,ok?0:-1); str(16,ok?'transfer verified; query status':'md5 fail');
            }));
          });
          return;
        }
        this.nextFirmware = this.file.path.slice(this.file.path.lastIndexOf('/') + 1).replace(/\.img$/, '');
        if (params.has('enforceRollback') && this.mode !== 'unlocked') {
          const have = firmware.split('_').slice(-3).map(Number), want = this.nextFirmware.split('_').slice(-3).map(Number);
          for (let i = 0; i < 3; i++) if (want[i] !== have[i]) { this.rollbackRejected = want[i] < have[i]; break; }
        }
        return this.send(f, this.struct(80, (i32, str) => { i32(12, ok ? 0 : -1); str(16, ok ? 'OK' : 'md5 fail'); }));
      }
      if (f.cmd === C.UPGRADE_STATUS) {
        const failed = installFailure || this.rollbackRejected;
        this.status = Math.min(100, this.status + 25);
        this.send(f, this.struct(72, (i32, str) => {
          i32(0, failed ? 0 : this.status); i32(4, failed ? -6 : this.custom ? this.status === 100 ? 4 : 3 : 0);
          if (!failed) str(8, 'WRITING');
        }));
        if (!failed && this.status >= 100) {
          firmware = this.nextFirmware;
          if (type === 'air') {
            const lite = firmware === 'Ascent_H_Sky_18_21_10';
            Object.assign(factory, { name: lite ? 'Ascent_lite' : 'Ascent_H_Sky', serial: lite ? '1_FAKE0001' : 'FAKE0001',
              hardware: `FPV-Ascent-Sky-482-V1.3-${lite ? '1.1' : '1.0'}` });
          }
          if (!this.custom) setTimeout(() => reboot('normal'), 50);
        }
        return undefined;
      }
      return this.send({ ...f, cmd: C.UNKNOWN });
    }
  }

  function reboot(mode) {
    setTimeout(() => {
      const old = device;
      old.present = false;
      old.port.lose();
      granted = granted.filter((p) => p !== old.port);
      fire('disconnect', old.port);
      setTimeout(() => {
        device = new FakeUnit(mode);
        fake.mode = mode;
        if (fake.regrant) {
          granted.push(device.port);
          fire('connect', device.port);
        }
      }, fake.bootMs);
    }, 20);
  }

  device = new FakeUnit('normal');
  granted = [device.port];
  fake.mode = 'normal';

  serial.getPorts = async () => granted.slice();
  serial.requestPort = async () => {
    fake.requested = (fake.requested || 0) + 1;
    if (!granted.includes(device.port)) granted.push(device.port);
    return device.port;
  };
  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
})();
