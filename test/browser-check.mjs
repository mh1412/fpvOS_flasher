#!/usr/bin/env node
// Runs the page in headless Chrome against fake-serial.js and flashes an
// image through the real UI: bare image, archive and reselect paths, plus
// profile mismatch / unsupported device checks. No physical USB access.
//   node test/browser-check.mjs [IMG] [OUTDIR]
// CHROME=/path/to/chromium selects a browser; VRX_IMG adds signed stock VRX flows.
// Defaults to a synthetic air image. Screenshots go to OUTDIR (a temp dir by default).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { airImage, vrxImage, storedZip } from './fixtures.mjs';
import { openBrowser, PUBLIC_ASSETS } from './browser-harness.mjs';
import { crc32 } from '../checksum.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[3] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'flasher-check-'));
fs.mkdirSync(out, { recursive: true });
const img = process.argv[2] ? path.resolve(process.argv[2]) : path.join(out, 'Ascent_H_Sky_18_21_10.img');
if (!process.argv[2]) fs.writeFileSync(img, airImage());
if (!fs.existsSync(img)) { console.error('usage: browser-check.mjs [IMG] [OUTDIR]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fake = fs.readFileSync(path.join(root, 'test/fake-serial.js'), 'utf8');

async function connectedPage(query = '') {
  await cdp('Page.navigate', { url: `${base}${query}` });
  await until("document.readyState === 'complete' && document.querySelector('#unit-info') && !document.querySelector('#unit-info').hidden", 10000, 'auto-connect');
}

async function scenario(name, query, { reselect, file = img, source = img, profile = 'ascent-air', unlock = false, bootstrap = false }) {
  console.log(`--- ${name}`);
  await connectedPage(query);
  await chooseFile(file);
  await until("!document.querySelector('#file-info').hidden && /[0-9a-f]{32}/.test(document.querySelector('#file-meta').innerText)", 30000, 'image parsed');
  const shown = await js("[...document.querySelectorAll('#file-meta dt')].find(e => e.textContent === 'MD5').nextElementSibling.textContent");
  const expectedMd5 = createHash('md5').update(fs.readFileSync(source)).digest('hex');
  if (shown !== expectedMd5) throw new Error(`${name}: page shows md5 ${shown}, image is ${expectedMd5}`);
  if (!await js(`document.querySelector('#profile-hint').textContent.includes(${JSON.stringify(profile === 'ascent-vrx' ? 'Ascent VRX · Stock' : profile === 'fpvos-ar9311' ? 'Ascent VRX · fpvOS' : profile === 'fpvos-p1-air' ? 'BETAFPV P1 Air · fpvOS' : 'Ascent Lite')})`)) {
    throw new Error(`${name}: wrong detected hardware profile`);
  }
  await until("!document.querySelector('#flash').disabled", 5000, 'flash enabled');
  if (unlock) {
    if (await js("document.querySelector('#unlock-before-flash').disabled")) throw new Error('unlock unavailable');
    if (!await js("document.querySelector('#unlock-before-flash').checked")) throw new Error('downgrade did not auto-select unlock');
  }
  await shot(`${name}-ready`);
  await js("document.querySelector('#flash').click()");
  await until("document.querySelector('#ask').open", 3000, 'confirm dialog');
  const notice = await js("document.querySelector('#ask-text').textContent");
  if (profile === 'ascent-vrx' && !/external DC power/.test(notice)) throw new Error('VRX confirmation lacks its power/update policy');
  if (unlock && !/0\.0\.0/.test(notice)) throw new Error('unlock confirmation lacks the version overlay policy');
  if (bootstrap && !/RAM updater/.test(notice)) throw new Error('bootstrap confirmation lacks its experimental preparation policy');
  await shot(`${name}-confirm`);
  await js("document.querySelector('#ask-ok').click()");
  let reselects = 0;
  const t0 = Date.now();
  while (await js("document.querySelector('#result').hidden")) {
    if (Date.now() - t0 > 120000) throw new Error('flash did not finish');
    if (reselect && !(await js("document.querySelector('#reselect').hidden"))) {
      if (reselects === 0) await shot(`${name}-reselect`);
      await js("document.querySelector('#reselect').click()");
      reselects++;
    }
    await sleep(200);
  }
  await js("document.querySelector('details').open = true");
  await shot(`${name}-done`);
  const r = await js(`({
    result: document.querySelector('#result').textContent,
    ok: document.querySelector('#result').dataset.ok,
    md5ok: window.__fake.md5ok,
    remotePath: window.__fake.remotePath,
    mode: window.__fake.mode,
    requested: window.__fake.requested || 0,
    cmds: window.__fake.log.filter(l => !/FILE_DATA|UPGRADE_STATUS/.test(l)),
    starts: window.__fake.starts, reboots: window.__fake.rebootPayloads,
  })`);
  console.log(`${r.result} (${reselects} port reselections)`);
  const fail = [];
  if (r.ok !== 'true') fail.push(`result: ${r.result}`);
  if (!r.md5ok) fail.push('unit md5 check failed');
  if (r.mode !== 'normal') fail.push(`unit ends in ${r.mode} mode`);
  if (reselect && r.requested < (bootstrap ? 1 : 2)) fail.push(`missing port reselection (${r.requested})`);
  if (!reselect && r.requested) fail.push('asked for the port without need');
  const expectedName = profile === 'fpvos-p1-air' ? 'fpvos.fwu' : path.basename(source);
  if (r.remotePath !== `/tmp/pc/${expectedName}`) fail.push(`wrong remote filename: ${r.remotePath}`);
  if (unlock && (r.starts.length !== 3 || r.reboots[0] !== 'normal' || r.cmds.filter(c => /FILE_END/.test(c)).length !== 1)) fail.push('unlock staging/reboot/update trigger order was wrong');
  if (bootstrap && (r.starts.length !== 4 || r.starts[0] !== '/usrdata/fpvos-update' || r.starts[1] !== '/usrdata/fpvos-bootstrap.sh'
    || r.reboots[0] !== 'normal' || r.cmds.filter(c => /FILE_END/.test(c)).length !== 1)) fail.push('bootstrap staging/reboot/update trigger order was wrong');
  return fail;
}

async function looks() {
  console.log('--- looks: dark, phone width, an unsupported L_Gnd image');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await connectedPage();
  const bad = path.join(out, 'Ascent_L_Gnd_17_5_8.img');
  fs.writeFileSync(bad, airImage([17, 5, 8], 1));
  await chooseFile(bad);
  await until("document.querySelectorAll('#checks li[data-level=error]').length > 0", 5000, 'error shown');
  const disabled = await js("document.querySelector('#flash').disabled");
  const overflow = await js('document.documentElement.scrollWidth > window.innerWidth');
  await shot('looks-dark-phone-bad-image');
  const fail = [];
  if (!disabled) fail.push('flash enabled for an unsupported ground image');
  if (overflow) fail.push('horizontal scroll at 390 px');
  return fail;
}

async function rejectedProfile(name, query, file, selected = '') {
  console.log(`--- ${name}`);
  await connectedPage(query);
  if (selected) await js(`document.querySelector('#profile').value = ${JSON.stringify(selected)}; document.querySelector('#profile').dispatchEvent(new Event('change'))`);
  await chooseFile(file);
  await until("document.querySelectorAll('#checks li[data-level=error]').length > 0", 10000, 'profile mismatch');
  await shot(name);
  const disabled = await js("document.querySelector('#flash').disabled");
  const commands = await js('window.__fake.log');
  return disabled && commands.every((c) => /FIND_DEVICE/.test(c)) ? [] : [`${name}: mismatch allowed a flash`];
}

async function offlineProfiles(bundle) {
  console.log('--- offline archive profile selection');
  await connectedPage();
  await js("document.querySelector('#disconnect').click()");
  await until("document.querySelector('#unit-status').dataset.kind === 'idle'", 5000);
  await chooseFile(bundle);
  await until("document.querySelector('#checks').textContent.includes('different hardware')", 10000, 'ambiguous bundle rejected');
  await js("document.querySelector('#profile').value = 'ascent-air'; document.querySelector('#profile').dispatchEvent(new Event('change'))");
  await until("document.querySelector('#file-name').textContent.startsWith('Ascent_H_Sky') && /MD5/.test(document.querySelector('#file-meta').textContent)", 10000, 'offline air selection');
  if (!await js("document.querySelector('#flash').disabled")) return ['flash enabled while disconnected'];
  await shot('offline-profile');
  return [];
}

async function failedTransfer(install = false) {
  console.log(install ? '--- negative install status with empty detail fails immediately' : '--- failed chunk releases the device');
  await connectedPage(`?${install ? 'installFailure' : 'rejectData'}=1`);
  await chooseFile(img);
  await until("!document.querySelector('#flash').disabled", 10000);
  await js("document.querySelector('#flash').click()");
  await until("document.querySelector('#ask').open", 3000);
  await js("document.querySelector('#ask-ok').click()");
  await until("!document.querySelector('#result').hidden", 10000);
  const ok = await js(`document.querySelector('#result').dataset.ok === 'false'
    && document.querySelector('#result').textContent.includes(${JSON.stringify(install ? 'update failure (status -6)' : 'rejected or miscounted chunk')})
    && document.querySelector('#unit-status').dataset.kind === 'idle'
    && document.querySelector('#flash').disabled
    && ${install ? "window.__fake.log.filter(c => /UPGRADE_STATUS/.test(c)).length === 1" : "!window.__fake.log.some(c => /FILE_END/.test(c))"}`);
  await shot(install ? 'failed-install-disconnected' : 'failed-chunk-disconnected');
  return ok ? [] : ['failed transfer/install did not stop/release the updater session'];
}

async function failedUnlock(file) {
  console.log('--- unlock verification blocks firmware upload');
  await connectedPage('?device=vrx&fw=18_21_10&unlockFails=1');
  await chooseFile(file);
  await until("!document.querySelector('#flash').disabled", 10000);
  await js("document.querySelector('#unlock-before-flash').checked = true; document.querySelector('#unlock-before-flash').dispatchEvent(new Event('change')); document.querySelector('#flash').click()");
  await until("document.querySelector('#ask').open", 3000);
  await js("document.querySelector('#ask-ok').click()");
  await until("!document.querySelector('#result').hidden", 10000);
  const ok = await js("document.querySelector('#result').dataset.ok === 'false' && window.__fake.starts.length === 2 && !window.__fake.log.some(c => /FILE_END/.test(c))");
  return ok ? [] : ['failed unlock proof allowed firmware upload'];
}

async function unlockSelection(file, invalidFile) {
  console.log('--- automatic unlock selection, manual override and context reset');
  const failures = [];
  const selected = () => js("document.querySelector('#unlock-before-flash').checked");
  const loaded = (name = path.basename(file)) => until(`document.querySelector('#file-name').textContent === ${JSON.stringify(name)}
    && !document.querySelector('#file-meta').hidden && [...document.querySelectorAll('#file-meta dt')].some(e => e.textContent === 'MD5')
    && !document.querySelector('#file-status').textContent`, 10000, 'valid image loaded');
  const anotherFile = path.join(out, 'reselected-vrx.img');
  fs.copyFileSync(file, anotherFile);
  await connectedPage('?device=vrx&fw=18_21_10');
  if (await selected()) failures.push('unlock selected without an image');
  await chooseFile(file); await loaded();
  if (!await selected()) failures.push('older image did not select unlock');
  await js("document.querySelector('#unlock-before-flash').click(); document.querySelector('#verbose').click()");
  if (await selected()) failures.push('manual disable was overwritten');
  await chooseFile(anotherFile); await loaded(path.basename(anotherFile));
  if (!await selected()) failures.push('new file selection did not restore automatic unlock');
  await js("document.querySelector('#disconnect').click()");
  await until("document.querySelector('#unit-status').dataset.kind === 'idle'", 5000);
  if (await selected()) failures.push('unlock remained selected while disconnected');
  await js("document.querySelector('#connect').click()");
  await until("document.querySelector('#unit-status').dataset.kind === 'ok'", 10000); await loaded(path.basename(anotherFile));
  if (!await selected()) failures.push('reconnection did not re-evaluate the existing image');
  for (const fw of ['17_5_8', '16_5_7', '19_0_0']) {
    await connectedPage(`?device=vrx&fw=${fw}`);
    await chooseFile(file); await loaded();
    if (await selected() !== (fw === '19_0_0')) failures.push(`wrong automatic selection for current ${fw}`);
    if (fw === '17_5_8') {
      await js("document.querySelector('#unlock-before-flash').click(); document.querySelector('#verbose').click()");
      if (!await selected()) failures.push('manual enable was overwritten');
    }
  }
  await chooseFile(invalidFile);
  await until("document.querySelector('#checks').textContent.includes('RSA signature')", 10000);
  if (await selected()) failures.push('invalid image auto-selected unlock');
  if (!await js("window.__fake.log.every(c => /FIND_DEVICE/.test(c))")) failures.push('selection tests wrote to the device');
  return failures;
}

// a zip shaped like the vendor's download, and an .img.xz
const zip = path.join(out, 'Firmware_V18.21.10.zip');
execFileSync('python3', ['-c', `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('Firmware_V18.21.10/Readme.txt', 'read me')
    z.writestr('Firmware_V18.21.10/Ascent_G_Gnd_18_21_10.img', b'ground' * 1000)
    z.write(sys.argv[2], 'Firmware_V18.21.10/' + sys.argv[3])
`, zip, img, path.basename(img)]);
const xzFile = path.join(out, `${path.basename(img)}.xz`);
fs.writeFileSync(xzFile, execFileSync('xz', ['-c', '-6', img], { maxBuffer: 1 << 30 }));
const syntheticVrx = path.join(out, 'Ascent_G_Gnd_17_5_8.img');
fs.writeFileSync(syntheticVrx, vrxImage());
const syntheticBundle = path.join(out, 'synthetic-mixed.zip');
fs.writeFileSync(syntheticBundle, storedZip([[path.basename(img), fs.readFileSync(img)], [path.basename(syntheticVrx), fs.readFileSync(syntheticVrx)]]));
const fwu = path.join(out, 'fpvos.fwu');
const fwuHeader = Buffer.alloc(512), fwuParts = ['kernel','dtb','root'].map((s) => Buffer.from(s));
fwuHeader.write('FPVOSUP1'); [1,485,525,3].forEach((n,i) => fwuHeader.writeUInt32LE(n,8+i*4)); fwuHeader.write('browser-test',24);
fwuParts.forEach((p,i) => { const at=96+104*i; fwuHeader.write(['kernel.img','ascent-gnd485.dtb','rootfs.cpio.uboot'][i],at);
  fwuHeader.writeUInt32LE(p.length,at+32); fwuHeader.write(createHash('sha256').update(p).digest('hex'),at+36); });
fwuHeader.writeUInt32LE(crc32(fwuHeader),508); fs.writeFileSync(fwu,Buffer.concat([fwuHeader,...fwuParts]));

const p1Fwu = path.join(out, 'fpvos-p1-air.fwu');
const p1Header = Buffer.from(fwuHeader);
p1Header.writeUInt32LE(1345409867, 12);
['kernel.img', 'betafpv-p1-air.dtb', 'rootfs.cpio.gz'].forEach((name, i) => {
  const at = 96 + 104 * i; p1Header.fill(0, at, at + 32); p1Header.write(name, at);
});
p1Header.fill(0, 508); p1Header.writeUInt32LE(crc32(p1Header), 508);
fs.writeFileSync(p1Fwu, Buffer.concat([p1Header, ...fwuParts]));

const harness = await openBrowser({ root, out });
const { cdp, evaluate: js, until, screenshot: shot, chooseFile, problems } = harness;
const base = `${harness.origin}/`;
let failures = [];
try {
  for (const name of PUBLIC_ASSETS) {
    const response = await fetch(`${base}${name}`);
    if (!response.ok) throw new Error(`Missing public asset: ${name}`);
    await response.arrayBuffer();
  }
  for (const name of ['test/fake-serial.js', 'test/browser-harness.mjs', 'transports/node-serial.mjs', '.git/config']) {
    if ((await fetch(`${base}${name}`)).status !== 404) throw new Error(`Private asset served: ${name}`);
  }
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__fake = { regrant: !location.search.includes('regrant=0') };\n${fake}`,
  });
  failures.push(...await scenario('kept', '?fw=17_5_3', { reselect: false }));
  failures.push(...await scenario('zip', '', { reselect: false, file: zip }));
  failures.push(...await scenario('xz', '', { reselect: false, file: xzFile }));
  failures.push(...await scenario('lost', '?regrant=0', { reselect: true }));
  failures.push(...await scenario('stock-to-fpvos', '?device=vrx&fw=18_21_10', { reselect: true, file:fwu, source:fwu, profile:'ascent-vrx', bootstrap:true }));
  failures.push(...await scenario('fpvos-update', '?device=fpvos', { reselect:false, file:fwu, source:fwu, profile:'fpvos-ar9311' }));
  failures.push(...await scenario('p1-update', '?device=p1&startupDelay=8000', { reselect:false, file:p1Fwu, source:p1Fwu, profile:'fpvos-p1-air' }));
  failures.push(...await scenario('p1-reselect', '?device=p1&regrant=0', { reselect:true, file:p1Fwu, source:p1Fwu, profile:'fpvos-p1-air' }));
  failures.push(...await rejectedProfile('p1-rejects-vrx', '?device=p1', fwu));
  failures.push(...await rejectedProfile('fpvos-vrx-rejects-p1', '?device=fpvos', p1Fwu));
  failures.push(...await rejectedProfile('vrx-rejects-air', '?device=vrx', img));
  failures.push(...await rejectedProfile('pro-cannot-be-forced', '?device=pro', img, 'ascent-vrx'));
  failures.push(...await rejectedProfile('vrx-rejects-untrusted-signature', '?device=vrx', syntheticVrx));
  failures.push(...await offlineProfiles(syntheticBundle));
  failures.push(...await failedTransfer());
  failures.push(...await failedTransfer(true));
  if (process.env.VRX_IMG) {
    const vrx = path.resolve(process.env.VRX_IMG);
    const bundle = path.join(out, 'mixed-hardware.zip');
    fs.writeFileSync(bundle, storedZip([[path.basename(img), fs.readFileSync(img)], [path.basename(vrx), fs.readFileSync(vrx)]]));
    failures.push(...await scenario('vrx-mixed-zip', '?device=vrx', { reselect: false, file: bundle, source: vrx, profile: 'ascent-vrx' }));
    failures.push(...await scenario('vrx-lost', '?device=vrx&regrant=0', { reselect: true, file: vrx, source: vrx, profile: 'ascent-vrx' }));
    failures.push(...await unlockSelection(vrx, syntheticVrx));
    failures.push(...await scenario('vrx-unlock-downgrade', '?device=vrx&fw=18_21_10&enforceRollback=1', { reselect: false, file: vrx, source: vrx, profile: 'ascent-vrx', unlock: true }));
    failures.push(...await failedUnlock(vrx));
    failures.push(...await rejectedProfile('air-rejects-vrx', '', vrx));
    failures.push(...await rejectedProfile('vrx-rejects-selected-air-profile', '?device=vrx', vrx, 'ascent-air'));
  }
  failures.push(...await looks());
} catch (e) {
  failures.push(e.message);
}
failures.push(...problems);
console.log(`screenshots: ${out}`);
console.log(failures.length ? `FAIL\n  ${failures.join('\n  ')}` : 'PASS');
await harness.close();
process.exit(failures.length ? 1 : 0);
