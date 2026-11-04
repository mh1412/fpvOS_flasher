// fpvOS Flasher: Web Serial transport and UI over hardware profiles.
import { LinkLostError } from './transports/ascent.js';
import { WebSerialLink } from './transports/web-serial.js';
import {
  PROFILES, USB_FILTERS, CONNECT_FILTERS, getProfile, profileForUsb, profileForDevice, preparationForUsb,
} from './devices/index.js';
import { prepareFirmware, evaluateSelection, flashFirmware } from './flasher.js';
import { formatBytes } from './devices/common.js';

const isOurs = (port) => !!profileForUsb(port.getInfo());
const hex4 = (n) => (n ?? 0).toString(16).padStart(4, '0');
const usbId = (port) => `${hex4(port.getInfo().usbVendorId)}:${hex4(port.getInfo().usbProductId)}`;

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state --

const state = {
  link: null,
  session: null,
  info: null,
  profile: null,     // positively identified connected hardware, never a UI override
  selectedProfile: null, // optional image/archive target while disconnected
  unlockOverride: null, // null = version-based automatic selection; boolean = manual choice
  p1Stage: null,     // stock P1 preparation: null | 'restart' (step 1 next) | 'recovery' (step 2 next) | 'done'
  connecting: false,
  image: null,       // { file, bytes, parsed, md5 }
  operation: null,
  preparing: false,
  get busy() { return this.operation !== null || this.preparing; },
  flashed: null,     // result line after a flash
};

// -------------------------------------------------------------------- log --

const logLines = [];

function log(msg, level = 'info') {
  const l = { t: new Date().toISOString().slice(11, 23), level, msg };
  logLines.push(l);
  showLogLine(l);
}

function showLogLine(l) {
  if (l.level === 'debug' && !$('verbose').checked) return;
  const box = $('log');
  const line = document.createElement('div');
  line.className = `log-${l.level}`;
  line.textContent = `${l.t}  ${l.msg}`;
  box.append(line);
  box.scrollTop = box.scrollHeight;
}

function logText() {
  return logLines.map((l) => `${l.t} ${l.level.padEnd(5)} ${l.msg}`).join('\n');
}

// ------------------------------------------------------------------ unit --

async function connect() {
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: CONNECT_FILTERS });
  } catch {
    return;   // chooser closed
  }
  // A stock unit that must be prepared first (the P1 on its Sirius port) is not
  // yet an fpvOS device, so it cannot just be opened: hand it to preparation.
  if (!isOurs(port) && preparationForUsb(port.getInfo())) { await beginP1Preparation(port); return; }
  await openPort(port);
}

async function openPort(port) {
  if (state.link || state.busy || state.connecting || !isOurs(port)) return;
  state.connecting = true;
  const usbProfile = profileForUsb(port.getInfo());
  const link = new WebSerialLink(port, {
    // fpvOS boards share USB IDs and the same strict transport. Resolve the
    // board from FIND_DEVICE; each stage supplies its reconnect policy.
    acceptPort: (info) => profileForUsb(info) === usbProfile,
    serial: usbProfile.transport.serial,
    filters: usbProfile.meta.usb,
    log,
    onNeedPort: askForPort,
    onPortBack: () => { $('reselect').hidden = true; portRequest = null; },
  });
  setUnitStatus('connecting', 'Connecting…');
  render();
  try {
    await link.open();
  } catch (e) {
    setUnitStatus('error', "Could not open the port. Is another program (the vendor's PC tool, a terminal) using it?");
    log(`open: ${e.message}`, 'error');
    state.connecting = false;
    render();
    return;
  }
  state.link = link;
  state.session = usbProfile.transport.protocol.createSession(link, log, usbProfile.transport);
  watchLink(link);
  // which device this is, and whether another one with the same id is
  // allowed too (the browser does not tell their serial numbers)
  const same = (await navigator.serial.getPorts().catch(() => [])).filter((p) => usbId(p) === usbId(port)).length;
  log(`opened the port of USB device ${usbId(port)}${same > 1 ? ` (${same} such devices allowed on this page)` : ''}`);
  try {
    state.info = await state.session.deviceInfo({ timeoutMs: usbProfile.transport.timeouts.connect ?? 6000 });
    state.profile = profileForDevice(state.info, port.getInfo());
    state.unlockOverride = null;
    log(`connected: ${state.info.firmware || state.info.name} (hw ${state.info.hardware}, sn ${state.info.serial})`);
    setUnitStatus(state.profile ? 'ok' : 'error', state.profile ? 'Connected' : 'Connected device has no supported hardware profile.');
  } catch (e) {
    log(`no answer to FIND_DEVICE: ${e.message}`, 'error');
    setUnitStatus('error', 'The port opened but the device does not answer. Wait for it to finish booting, then reconnect. '
      + 'If other USB devices are plugged in (a flight controller, an ESP32 board), unplug them and plug the unit straight into the computer.');
    await link.close();
    state.link = state.session = state.info = state.profile = null;
  }
  state.connecting = false;
  render();
  if (state.profile && state.image?.file && !state.selectedProfile) loadFile(state.image.file);
}

// closed is a new promise after every reopen, and a flash reopens on its own
function watchLink(link) {
  link.closed.then(() => {
    if (state.link === link && !state.busy) disconnected();
  });
}

function disconnected() {
  state.link = state.session = state.info = state.profile = null;
  state.unlockOverride = null;
  setUnitStatus('idle', 'Not connected');
  log('device disconnected');
  render();
}

async function disconnect() {
  const link = state.link;
  if (!link || state.busy) return;
  state.link = null;
  await link.close();
  disconnected();
}

let portRequest = null;

function askForPort() {
  $('reselect').hidden = false;
  log('the device has not reappeared yet; the browser may need it selected again', 'warn');
  return new Promise((resolve) => { portRequest = resolve; });
}

async function reselect() {
  try {
    const port = await navigator.serial.requestPort({ filters: state.link?.filters ?? USB_FILTERS });
    $('reselect').hidden = true;
    portRequest?.(port);
    portRequest = null;
  } catch { /* chooser closed; keep the button */ }
}

function setUnitStatus(kind, text) {
  const s = $('unit-status');
  s.dataset.kind = kind;
  s.querySelector('span').textContent = text;
}

// Reached only from a Connect click where the chosen port is a stock P1 (its
// Sirius serial id), never from auto-open on plug. Confirm, then run the first
// step with the port we already have, so the restart needs no second chooser.
async function beginP1Preparation(port) {
  if (state.busy || state.connecting || state.link) return;
  const ok = await ask('Stock BETAFPV P1 Air',
    'Prepare this unit in the browser and install fpvOS? Supported: a standard P1 Air on stock firmware 1.0.44, '
    + 'kept on external power throughout. Other stock versions and P1 AIO models are not supported. '
    + 'Nothing is written to flash yet; the bootloader is checked first.',
    'Prepare');
  if (!ok) return;
  $('p1-preparation').open = true;
  $('p1-stock-confirm').checked = true;
  state.p1Stage = 'restart';
  render();
  await prepareP1(false, port);
}

// Stock P1 uses Web Serial to enter U-Boot, then WebHID for RAM recovery.
// Each chooser must run directly from its own user gesture after re-enumeration;
// the restart can reuse the port Connect already picked (presetPort).
let preparationAbort = null;
async function prepareP1(loadRecovery, presetPort = null) {
  if (state.busy || state.connecting || state.link || !$('p1-stock-confirm').checked) return;
  const preparation = getProfile('fpvos-p1-air').meta.preparation;
  state.preparing = true;
  preparationAbort = new AbortController();
  const signal = preparationAbort.signal;
  const progress = (text) => { $('p1-preparation-status').textContent = text; };
  render();
  try {
    if (loadRecovery) {
      const [device] = await navigator.hid.requestDevice({ filters: [preparation.hidFilter] });
      if (!device) { progress('No bootloader selected. Select the same P1 when it appears as USB download gadget.'); return; }
      await preparation.loadRecovery(device, { signal, progress, log });
      state.p1Stage = 'done';
      progress('Recovery boot requested. Wait for USB to reconnect, then click Connect above and select the P1 Air serial port. Choose your P1 .fwu file and click Flash.');
      log('P1 recovery loaded through WebHID; connect its new serial port to install firmware.');
    } else {
      const port = presetPort ?? await navigator.serial.requestPort({ filters: [preparation.serialFilter] });
      await preparation.enterBootloader(port, { signal });
      state.p1Stage = 'recovery';
      progress('Restart requested. Wait for USB download gadget, then select it with “Load P1 recovery”. If it stays as Sirius, allow stock firmware to finish starting and retry Restart stock P1.');
      log('Requested stock P1 USB bootloader through Web Serial.');
    }
  } catch (e) {
    const message = e.name === 'NotFoundError' ? 'No device selected. You can try again.'
      : `${e.message} If the P1 is still in USB download mode, retry Load P1 recovery; power-cycle it to return to its installed firmware.`;
    progress(message); log(`P1 preparation: ${message}`, 'warn');
  } finally { state.preparing = false; preparationAbort = null; render(); }
}

// --------------------------------------------------------------- firmware --

// An image as is, or the one inside a .zip / .xz / .gz / .tar.
async function loadFile(file) {
  if (!file || state.busy) return;
  state.unlockOverride = null;
  state.flashed = null;
  const current = { file, loading: 'Opening' };
  state.image = current;
  render();
  let opened;
  try {
    opened = await prepareFirmware(file, {
      profile: state.selectedProfile ?? state.profile,
      onProgress: (text) => {
        if (state.image !== current) return;
        current.loading = text;
        $('file-status').textContent = `${text}…`;
      },
    });
  } catch (e) {
    if (state.image !== current) return;
    state.image = { file, error: e.message };
    log(`file ${file.name}: ${e.message}`, 'error');
    render();
    return;
  }
  if (state.image !== current) return;   // another file was dropped meanwhile
  const { bytes, name, trail, parsed, md5 } = opened;
  state.image = { file, ...opened };
  log(`file ${[...trail, name].join(' > ')}: ${bytes.length} bytes, ${parsed.boardName ?? 'not an image'} `
    + `${parsed.versionText ?? ''}${md5 ? `, md5 ${md5}` : ''}`);
  render();
}

// Problems from the image and the unit together: [{level, text}]
function selection() {
  return state.operation?.plan ?? evaluateSelection({ info: state.info, profile: state.profile, image: state.image,
    selectedProfile: state.selectedProfile, unlockOverride: state.unlockOverride });
}

// ------------------------------------------------------------------ flash --

const STAGES = ['unlock', 'clean', 'upload', 'install', 'restart'];
let abort = null;

async function flash() {
  const img = state.image;
  if (!canFlash()) return;
  const profile = state.profile;
  const session = state.session, info = state.info, plan = selection();
  const unlock = plan.unlockSelected;
  const ok = await ask(`${unlock ? 'Unlock and flash' : 'Flash'} ${img.parsed.remoteName}?`,
    `${plan.bootstrapSelected ? 'Upload the experimental RAM updater, then select this VRX’s new USB port. Disconnect other VRXs. No backup export is performed. ' : ''}${unlock ? profile.meta.unlock.notice + ' ' : ''}${plan.executionProfile.meta.notices.flash} This flasher is experimental: use it at your own risk.`,
    unlock ? 'Unlock and flash' : 'Flash');
  if (!ok || !canFlash() || state.image !== img || state.profile !== profile || state.session !== session
    || state.info !== info || selection().unlockSelected !== unlock) return;

  state.operation = Object.freeze({ plan, session, info, image: img });
  state.flashed = null;
  abort = new AbortController();
  render();
  setProgress({ stage: 'clean', frac: 0, text: 'Starting' });
  const t0 = Date.now();
  try {
    const after = await flashFirmware(session, profile, img, {
      info, usbInfo: state.link.port.getInfo(),
      unlock,
      progress: setProgress, log, signal: abort.signal,
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    state.flashed = { ok: true, text: after
      ? `Flashed in ${secs} s. The device now reports ${after.firmware || after.name}.`
      : `Flashed in ${secs} s. The device is restarting; reconnect to check it.` };
    if (after) { state.info = after; state.profile = profileForDevice(after, state.link.port.getInfo()); state.unlockOverride = null; }
    log(state.flashed.text);
  } catch (e) {
    state.flashed = { ok: false, text: e.message };
    log(`flash failed: ${e.message}`, 'error');
    setProgress({ stage: 'failed', frac: null, text: 'Failed' });
  } finally {
    state.operation = null;
    abort = null;
    $('reselect').hidden = true;
    if (state.link?.writer) watchLink(state.link);
    else if (state.link) disconnected();
    render();
  }
}

function canFlash() {
  return !!state.session && !state.busy && !state.connecting && selection().canFlash;
}

let currentStage = null;

function setProgress({ stage, frac, text }) {
  currentStage = stage;
  if (frac != null) $('bar').style.width = `${(frac * 100).toFixed(1)}%`;
  $('bar').dataset.state = stage === 'failed' ? 'failed' : stage === 'done' ? 'done' : 'run';
  $('stage-text').textContent = text;
  $('cancel').hidden = !state.busy || !['unlock', 'clean', 'upload'].includes(stage);
  const idx = STAGES.indexOf(stage);
  document.querySelectorAll('#stages li').forEach((li, i) => {
    li.dataset.state = stage === 'done' || i < idx ? 'done' : i === idx ? 'active' : '';
  });
}

async function networkMode() {
  if (!state.session || !state.profile?.transport.protocol.networkMode || state.busy) return;
  if (!await ask('Enable USB network mode?', state.profile.meta.notices.network, 'Enable')) return;
  try {
    await state.profile.transport.protocol.networkMode(state.session);
  } catch (e) {
    if (!(e instanceof LinkLostError)) log(`network mode: ${e.message}`, 'warn');
  }
  log('asked the device to switch to network mode');
}

function ask(title, text, okLabel) {
  const d = $('ask');
  $('ask-title').textContent = title;
  $('ask-text').textContent = text;
  $('ask-ok').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
  });
}

// ----------------------------------------------------------------- render --

function render() {
  const plan = selection();
  const supported = 'serial' in navigator;
  $('unsupported').hidden = supported;
  if (!supported && !window.isSecureContext) {
    $('unsupported').textContent = `Chrome only allows USB serial on https:// pages and on localhost, and this page `
      + `was opened from ${location.origin}. Open it as http://localhost on the computer that serves it, or in `
      + `chrome://flags enable "Insecure origins treated as secure" for ${location.origin}, then relaunch Chrome.`;
  }

  // unit
  const info = state.info;
  $('connect').hidden = !!state.link;
  $('connect').disabled = !supported || state.busy || state.connecting;
  $('disconnect').hidden = !state.link;
  $('disconnect').disabled = state.busy || state.connecting;
  $('netmode').disabled = !state.session || !state.profile?.transport.protocol.networkMode || state.busy || state.connecting;
  $('profile').disabled = state.busy;
  const p1Available = supported && 'hid' in navigator;
  $('p1-browser-support').hidden = p1Available;
  $('p1-stock-confirm').disabled = state.busy;
  // Walk the two steps: exactly one is the lit, clickable action; the finished
  // step is greyed and ticked, and the later step stays blocked until its turn.
  const p1Ready = p1Available && $('p1-stock-confirm').checked && !state.busy && !state.connecting && !state.link;
  setP1Step($('p1-enter-bootloader'), p1Ready && state.p1Stage === 'restart', state.p1Stage === 'recovery' || state.p1Stage === 'done');
  setP1Step($('p1-load-recovery'), p1Ready && state.p1Stage === 'recovery', state.p1Stage === 'done');
  $('p1-preparation-cancel').hidden = !state.preparing;
  const unlockFeature = state.profile?.meta.unlock ?? state.selectedProfile?.meta.unlock;
  $('unlock-options').hidden = !unlockFeature;
  $('unlock-before-flash').disabled = state.busy || !plan.unlockAvailable;
  $('unlock-before-flash').checked = plan.unlockSelected;
  $('unlock-label').textContent = unlockFeature?.label ?? '';
  $('unlock-hint').textContent = !plan.unlockAvailable ? 'Connect a healthy normal-mode standard VRX with a valid reported firmware version to use preflash unlock.'
    : state.unlockOverride != null ? `Manually ${plan.unlockSelected ? 'enabled' : 'disabled'} for this selection. Signed firmware validation remains enabled.`
    : plan.automaticUnlock ? `Automatically selected for downgrade: ${state.image.parsed.versionText} < ${plan.currentVersion.join('.')}. One-shot RAM overlay; signed firmware validation remains enabled.`
    : !state.image?.md5 || state.image.parsed.profileId !== state.profile.meta.id ? 'Choose a valid matching image to compare with the connected firmware. You can also select unlock manually.'
    : 'Automatically off for equal/newer images. You can enable it manually; signed firmware validation remains enabled.';
  $('stage-unlock').hidden = !plan.unlockSelected;
  $('profile-hint').textContent = state.selectedProfile ? `Image target: ${state.selectedProfile.meta.name}.`
    : state.profile ? `Detected: ${state.profile.meta.name}.`
    : 'Connect a device to select its image from an archive, or choose a profile for offline checks.';
  $('unit-info').hidden = !info;
  if (info) {
    const rows = [
      ['Profile', state.profile?.meta.name ?? 'unsupported'],
      ['Firmware', info.firmware],
      ['Device', info.name],
      ['Hardware', info.hardware],
      ['Serial', info.serial],
      ['SDK', info.sdk],
      ['CPU temperature', info.cpuTemp != null ? `${info.cpuTemp} °C` : ''],
      ['Max chunk', info.maxChunk ? formatBytes(info.maxChunk) : ''],
    ].filter(([, v]) => v);
    $('unit-info').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', k), el('dd', v)]));
  }

  // firmware
  const img = state.image;
  $('drop').classList.toggle('loaded', !!img);
  $('drop').classList.toggle('disabled', state.busy);
  $('file').disabled = state.busy;
  $('file-info').hidden = !img;
  $('file-status').hidden = !img?.loading;
  $('file-status').textContent = img?.loading ? `${img.loading}…` : '';
  const p = img?.parsed;
  $('file-meta').hidden = !p;
  $('sections').hidden = !p?.sections.length;
  if (img) $('file-name').textContent = img.name ?? img.file.name;
  if (p) {
    const headings = $('sections').querySelectorAll('th');
    img.view.columns.forEach((text, i) => { headings[i].textContent = text; });
    $('file-meta').replaceChildren(...img.view.facts.flatMap(([k, v, cls]) => [el('dt', k), el('dd', v, cls)]));
    $('sections').querySelector('tbody').replaceChildren(...img.view.rows.map((row) => {
      const tr = document.createElement('tr');
      row.forEach((text, i) => tr.append(el('td', text, i === 1 || i === 2 ? 'num' : '')));
      return tr;
    }));
  }

  // checks
  const cs = plan.issues;
  $('checks').replaceChildren(...cs.map((c) => {
    const li = el('li', c.text);
    li.dataset.level = c.level;
    return li;
  }));
  $('checks').hidden = !cs.length;

  // flash
  $('flash').disabled = !canFlash();
  $('flash').textContent = state.operation ? 'Flashing…' : plan.unlockSelected ? 'Unlock and flash' : 'Flash';
  $('cancel').hidden = !state.operation || !['unlock', 'clean', 'upload'].includes(currentStage);
  $('progress').hidden = !state.operation && !state.flashed;
  $('result').hidden = !state.flashed;
  if (state.flashed) {
    $('result').dataset.ok = state.flashed.ok;
    $('result').textContent = state.flashed.text;
  }
  $('hint').textContent = !state.link ? 'Connect a device first.'
    : !img ? 'Choose a firmware image.'
    : img.loading ? 'Unpacking the firmware.'
    : cs.some((c) => c.level === 'error') ? 'Fix the problems above first.'
    : '';
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

// A preparation step is either the lit next action (enabled, lemon green),
// finished (greyed and ticked), or still blocked (plain greyed, not yet).
function setP1Step(btn, active, done) {
  btn.disabled = !active;
  btn.classList.toggle('step-active', active);
  btn.classList.toggle('step-done', !active && done);
}

// ------------------------------------------------------------------ wiring --

function init() {
  for (const p of PROFILES) {
    const option = el('option', p.meta.name); option.value = p.meta.id;
    $('profile').append(option);
  }
  $('profile').onchange = () => {
    state.unlockOverride = null;
    state.selectedProfile = getProfile($('profile').value);
    if (state.image?.file) loadFile(state.image.file);
    else render();
  };
  render();
  if (!('serial' in navigator)) return;

  $('connect').onclick = connect;
  $('p1-stock-confirm').onchange = () => {
    state.p1Stage = $('p1-stock-confirm').checked ? (state.p1Stage ?? 'restart') : null;
    render();
  };
  $('p1-enter-bootloader').onclick = () => prepareP1(false);
  $('p1-load-recovery').onclick = () => prepareP1(true);
  $('p1-preparation-cancel').onclick = () => preparationAbort?.abort();
  $('disconnect').onclick = disconnect;
  $('netmode').onclick = networkMode;
  $('reselect').onclick = reselect;
  $('flash').onclick = flash;
  $('unlock-before-flash').onchange = () => { state.unlockOverride = $('unlock-before-flash').checked; render(); };
  $('cancel').onclick = () => { abort?.abort(); log('cancelling after the current step', 'warn'); };
  // cleared after each pick: choosing the same file again fires no change
  // event otherwise, and the pick would be silently ignored
  $('file').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    loadFile(f);
  };
  $('verbose').onchange = () => {
    $('log').replaceChildren();
    logLines.forEach(showLogLine);
  };
  $('copy-log').onclick = () => navigator.clipboard.writeText(logText());
  $('save-log').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([logText()], { type: 'text/plain' }));
    a.download = `fpvos-flasher-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const drop = $('drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    loadFile(e.dataTransfer.files[0]);
  };

  window.addEventListener('beforeunload', (e) => { if (state.busy) e.preventDefault(); });
  // a file dropped outside the drop zone (or on it while flashing) would make
  // the browser open the file and leave the page
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // plug in = connect, for a unit this page was allowed before
  navigator.serial.addEventListener('connect', (e) => {
    if (!state.busy && isOurs(e.target)) openPort(e.target);
  });
  navigator.serial.getPorts().then((ports) => {
    const p = ports.find(isOurs);
    if (p) openPort(p);
  });
}

init();
