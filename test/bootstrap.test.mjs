import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BOOTSTRAP_BASE, loadAr9311Bootstrap, supportsAr9311Bootstrap } from '../stages/ar9311-bootstrap.js';
import { prepareFirmware, evaluateSelection, flashFirmware } from '../flasher.js';
import { getProfile } from '../devices/index.js';
import { CMD, crc32, ASCENT_TRANSPORT, LinkLostError, uploadUnfinalized } from '../transports/ascent.js';
import { storedZip } from './fixtures.mjs';
import { WebSerialLink } from '../transports/web-serial.js';

const stock = getProfile('ascent-vrx'), fpvos = getProfile('fpvos-ar9311');
const before = { name: 'Ascent_VRX', firmware: 'Ascent_G_Gnd_18_21_10', hardware: 'FPV-Ascent-Gnd-485-V1.2-1.0',
  serial: '2614', status: 0, detail: 'OK', maxChunk: 65536 };
const updater = { name: 'fpvOS updater', firmware: 'fpvOS unsigned development updates', hardware: 'Gnd485',
  serial: 'fpvos-ar9311', status: 0, detail: 'clean RAM mode', maxChunk: 1 << 20 };
const td = new TextDecoder();
const hash = (b) => createHash('sha256').update(b).digest('hex');
const assetsFetch = async (url) => new Response(readFileSync(url));
function firmware() {
  const h = Buffer.alloc(512), parts = ['kernel', 'dtb', 'root'].map((s) => Buffer.from(s));
  h.write('FPVOSUP1'); [1,485,512+13,3].forEach((n,i) => h.writeUInt32LE(n,8+i*4)); h.write('test',24);
  parts.forEach((p,i) => { const o=96+i*104; h.write(['kernel.img','ascent-gnd485.dtb','rootfs.cpio.uboot'][i],o); h.writeUInt32LE(p.length,o+32); h.write(hash(p),o+36); });
  h.writeUInt32LE(crc32(h),508); return new File([h,...parts], 'fpvos-ar9311.fwu');
}
function mock(image, opts = {}) {
  const calls = [], files = new Map(), reopens = [];
  let mode = 'stock', file;
  const session = { settings: ASCENT_TRANSPORT, calls, files, reopens, reset() {}, attach() {},
    link: { closed: Promise.resolve(), onNeedPort() {}, close: async () => {},
      port: { getInfo: () => mode === 'stock' ? stock.meta.usb[0] : opts.badUsb ? stock.meta.usb[0] : fpvos.meta.usb[0] },
      reopen: async (options) => { reopens.push(options); } },
    deviceInfo: async () => mode === 'stock' ? { ...before, ...opts.changedStock } : { ...updater,
      firmware: mode === 'normal' ? image.parsed.sha256 : updater.firmware, ...opts.changedUpdater },
    request: async (cmd,payload) => {
      calls.push({cmd,path:file?.path});
      const data = cmd === CMD.FILE_DATA || cmd === CMD.FILE_END;
      const p = Buffer.alloc(data ? 80 : cmd === CMD.UPGRADE_STATUS ? 72 : 68);
      p.write('OK',data?16:4);
      if (cmd === CMD.FILE_START) {
        const v = new DataView(payload.buffer,payload.byteOffset,payload.byteLength);
        file = { path:td.decode(payload.subarray(72,200)).replace(/\0.*$/s,''), size:v.getInt32(64,true), chunks:[], got:0 };
        files.set(file.path,file);
      }
      if (cmd === CMD.FILE_DATA) {
        file.chunks.push(payload); file.got += payload.length;
        p.writeUInt32LE(payload.length,0); p.writeUInt32LE(file.got,4); p.writeUInt32LE(file.size,8);
        if (opts.rejectBinary && file.path === '/usrdata/fpvos-update') p.writeInt32LE(-1,12);
        if (opts.cancel && file.path === '/factory/sirius-clean-system-flag') opts.cancel.abort();
      }
      if (cmd === CMD.REBOOT) {
        const request = td.decode(payload).replace(/\0.*$/s,'');
        if (request === 'normal') { mode = 'clean'; if (opts.lostRebootAck) throw new LinkLostError(); }
        if (request === 'reboot') mode = 'normal';
      }
      if (cmd === CMD.FILE_END) {
        assert.equal(file.path, '/tmp/pc/fpvos.fwu');
        p.writeUInt32LE(file.got,4); p.writeUInt32LE(file.size,8); p.write('transfer verified; query status',16);
      }
      if (cmd === CMD.UPGRADE_STATUS) { p.fill(0); p.writeUInt32LE(100,0); p.writeInt32LE(4,4); }
      return { crcOk:true, payload:p };
    } };
  return session;
}

test('bundled assets match the pinned manifest and reject missing, oversized or tampered downloads', async () => {
  const loaded = await loadAr9311Bootstrap({fetcher:assetsFetch});
  assert.ok(loaded.binary.bytes.length > 1 << 20);
  assert.equal(loaded.launcher.bytes.length,433);
  for (const name of ['manifest.json','bootstrap.sh','fpvos-update-ar9311']) {
    await assert.rejects(loadAr9311Bootstrap({fetcher: async (url) => {
      const bytes = Buffer.from(readFileSync(url)); if (url.pathname.endsWith(name)) bytes[0] ^= 1;
      return new Response(bytes);
    }}), /SHA-256|mismatch/);
  }
  await assert.rejects(loadAr9311Bootstrap({fetcher:async () => new Response('',{status:404})}),/HTTP 404/);
  await assert.rejects(loadAr9311Bootstrap({fetcher:async () => new Response(new Uint8Array(8193))}),/size limit/);
});

test('only supported healthy stock identities can select install bootstrap; restoration and air stay separate', async () => {
  const image = await prepareFirmware(firmware(),{profile:stock});
  const plan = evaluateSelection({info:before,profile:stock,image});
  assert.ok(plan.canFlash && plan.bootstrapSelected);
  assert.equal(plan.executionProfile,fpvos); assert.equal(plan.unlockAvailable,false);
  for (const change of [{serial:''},{status:-1},{firmware:'Ascent_G_Gnd_99_1_0'},{name:'Ascent_VRX_Pro'},{hardware:'FPV-Ascent-Gnd-485-V0.0-0.0'}]) {
    assert.equal(supportsAr9311Bootstrap({...before,...change}),false);
    assert.equal(evaluateSelection({info:{...before,...change},profile:stock,image}).canFlash,false);
  }
  assert.equal(evaluateSelection({info:before,profile:stock,image,selectedProfile:fpvos}).canFlash,false);
  assert.equal(evaluateSelection({info:before,profile:getProfile('ascent-air'),image}).canFlash,false);
  assert.equal(evaluateSelection({info:before,profile:stock,image:{...image,parsed:{...image.parsed,kind:1}}}).canFlash,false);
  const zip = new File([storedZip([['fpvos-ar9311.fwu',new Uint8Array(await firmware().arrayBuffer())]])],'release.zip');
  assert.equal((await prepareFirmware(zip,{profile:stock})).parsed.profileId,'fpvos-ar9311');
});

test('stock bootstrap stages exact assets without FileEnd and explicitly selects the new USB updater before flashing', async () => {
  const image = await prepareFirmware(firmware());
  for (const lostRebootAck of [false,true]) {
    const session = mock(image,{lostRebootAck});
    const after = await flashFirmware(session,stock,image,{info:before,bootstrapFetch:assetsFetch});
    assert.equal(after.firmware,image.parsed.sha256);
    for (const [name,path] of [['fpvos-update-ar9311','/usrdata/fpvos-update'],['bootstrap.sh','/usrdata/fpvos-bootstrap.sh']]) {
      assert.deepEqual(Buffer.concat(session.files.get(path).chunks),readFileSync(new URL(name,BOOTSTRAP_BASE)));
    }
    assert.equal(td.decode(Buffer.concat(session.files.get('/factory/sirius-clean-system-flag').chunks)),'web:/usrdata/fpvos-bootstrap.sh\n');
    assert.equal(session.calls.filter((c) => c.cmd === CMD.FILE_END).length,1);
    assert.equal(session.reopens[0].requireSelection,true);
    assert.deepEqual(session.reopens[0].filters,fpvos.meta.usb);
    assert.equal(session.settings.strictReplies,true);
  }
});

test('bootstrap errors and cancellation never send firmware or finalize staging', async () => {
  const image = await prepareFirmware(firmware());
  for (const opts of [{rejectBinary:true},{badUsb:true},{changedUpdater:{serial:'fpvos-ar9311-vendor'}},
    {changedUpdater:{detail:'normal mode'}},{changedStock:{serial:'other'}},{cancel:new AbortController()}]) {
    const session = mock(image,opts);
    await assert.rejects(flashFirmware(session,stock,image,{info:before,bootstrapFetch:assetsFetch,signal:opts.cancel?.signal}));
    assert.ok(!session.files.has('/tmp/pc/fpvos.fwu'));
    assert.ok(!session.calls.some((c) => c.cmd === CMD.FILE_END));
    if (opts.rejectBinary) assert.ok(!session.files.has('/factory/sirius-clean-system-flag'));
    if (opts.cancel) assert.equal(session.reopens[0].requireSelection,true);
  }
  const session = mock(image);
  await assert.rejects(flashFirmware(session,stock,image,{info:before,bootstrapFetch:async () => new Response('bad')}),/manifest/);
  assert.equal(session.calls.length,0);
  // Ordinary script staging keeps its 64 KiB bound despite the dedicated binary uploader.
  await assert.rejects(uploadUnfinalized(session,{bytes:new Uint8Array(65537),remotePath:'/usrdata/example.sh'}),/bounded/);
});

test('bootstrap port selection never silently opens an already-authorized updater', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis,'navigator');
  let enumerations = 0, picked = 0;
  const existing = { getInfo: () => fpvos.meta.usb[0] }, selected = { getInfo: () => fpvos.meta.usb[0] };
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{serial:{getPorts:async () => { enumerations++; return [existing]; }}}});
  try {
    const link = new WebSerialLink(existing,{onNeedPort:async () => { picked++; return selected; }});
    link.close = async () => {};
    link.open = async () => {};
    await link.reopen({requireSelection:true,filters:fpvos.meta.usb,acceptPort:() => true});
    assert.equal(enumerations,0); assert.equal(picked,1); assert.equal(link.port,selected);
  } finally {
    if (previous) Object.defineProperty(globalThis,'navigator',previous); else delete globalThis.navigator;
  }
});
