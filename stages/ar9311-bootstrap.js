// Versioned, hash-pinned assets. Stock receives staging files, never FileEnd.
import { canUnlockVrx } from '../devices/ascent-vrx.js';
import { sameFactoryIdentity } from '../devices/common.js';
import { uploadBootstrapBinary, uploadUnfinalized, CMD, rebootPayload, withTimeout, LinkLostError, TimeoutError } from '../transports/ascent.js';

export const BOOTSTRAP_BASE = new URL('../assets/ar9311-updater/v2/', import.meta.url);
export const BOOTSTRAP_MANIFEST_SHA256 = 'b36526ef40808055d4823b1a181af9a9f712eaa9a992393cb666678e476d28f8';
export const BOOTSTRAP_STOCK_VERSIONS = Object.freeze(['17.5.3', '17.5.8', '18.21.10']);
export const BOOTSTRAP_USB = Object.freeze([{ usbVendorId: 0x1d6b, usbProductId: 0x0104 }]);
const allowsUsb = (info) => BOOTSTRAP_USB.some((u) => u.usbVendorId === info?.usbVendorId && u.usbProductId === info?.usbProductId);
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

export const supportsAr9311Bootstrap = (info) => canUnlockVrx(info)
  && BOOTSTRAP_STOCK_VERSIONS.includes(info.firmware.slice('Ascent_G_Gnd_'.length).replaceAll('_', '.'));

async function fetchBytes(name, limit, fetcher, signal) {
  const response = await fetcher(new URL(name, BOOTSTRAP_BASE), { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Cannot load AR9311 bootstrap asset ${name}: HTTP ${response.status}.`);
  const reader = response.body.getReader(), parts = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error(`AR9311 bootstrap asset ${name} exceeds its size limit.`);
      parts.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

export async function loadAr9311Bootstrap({ fetcher = globalThis.fetch, signal } = {}) {
  const raw = await fetchBytes('manifest.json', 8192, fetcher, signal);
  if (await sha256(raw) !== BOOTSTRAP_MANIFEST_SHA256) throw new Error('AR9311 bootstrap manifest SHA-256 mismatch.');
  const manifest = JSON.parse(new TextDecoder().decode(raw));
  if (manifest.format !== 1 || manifest.version !== 'v2' || manifest.board !== 'ar9311' || manifest.board_id !== 485
    || JSON.stringify(manifest.supported_stock_firmware) !== JSON.stringify(BOOTSTRAP_STOCK_VERSIONS)) throw new Error('Unsupported AR9311 bootstrap manifest.');
  const files = await Promise.all(['fpvos-update-ar9311', 'bootstrap.sh'].map(async (name) => {
    const entry = manifest.files[name];
    const limit = name === 'bootstrap.sh' ? 4096 : 2 << 20;
    if (!Number.isInteger(entry?.size) || entry.size < 1 || entry.size > limit || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid bootstrap asset metadata.');
    const bytes = await fetchBytes(name, entry.size, fetcher, signal);
    if (bytes.length !== entry.size || await sha256(bytes) !== entry.sha256) throw new Error(`AR9311 bootstrap asset ${name} size/SHA-256 mismatch.`);
    return { bytes, remotePath: name === 'bootstrap.sh' ? '/usrdata/fpvos-bootstrap.sh' : '/usrdata/fpvos-update' };
  }));
  return { manifest, binary: files[0], launcher: files[1] };
}

export async function AR9311_BOOTSTRAP(ctx) {
  const { session, originalDevice: before } = ctx;
  if (!supportsAr9311Bootstrap(before)) throw new Error('Stock firmware/identity is not eligible for the bundled AR9311 bootstrap.');
  if (typeof session.link.onNeedPort !== 'function') throw new Error('Stock bootstrap requires a browser link with explicit port selection.');
  ctx.step('clean', 0.005, 'Checking the bundled AR9311 RAM updater');
  const assets = await loadAr9311Bootstrap({ fetcher: ctx.options.bootstrapFetch, signal: ctx.signal });
  ctx.checkCancelled();
  const current = await session.deviceInfo();
  if (!supportsAr9311Bootstrap(current) || !sameFactoryIdentity(current, before) || current.firmware !== before.firmware) throw new Error('Stock VRX identity changed before bootstrap staging.');
  const chunkSize = Math.min(65536, before.maxChunk > 0 ? before.maxChunk : 65536);
  ctx.step('clean', 0.01, 'Staging the RAM updater (without starting installation)');
  await uploadBootstrapBinary(session, assets.binary, { signal: ctx.signal, chunkSize });
  await uploadUnfinalized(session, assets.launcher, { signal: ctx.signal, chunkSize });
  ctx.checkCancelled();
  ctx.runtime.critical = true;
  await uploadUnfinalized(session, { remotePath: '/factory/sirius-clean-system-flag',
    bytes: new TextEncoder().encode('web:/usrdata/fpvos-bootstrap.sh\n') }, { chunkSize });
  ctx.report.log(`Armed AR9311 RAM updater ${assets.manifest.source_commit}; no staging FileEnd sent.`);
  // An ordinary reboot preserves the web selector. Finish this once armed,
  // even if cancellation was requested; cancellation resumes before firmware.
  try {
    await session.request(CMD.REBOOT, rebootPayload('normal'), { retryMs: 0 });
  } catch (e) {
    if (!(e instanceof LinkLostError || e instanceof TimeoutError)) throw e;
    ctx.report.log('Bootstrap reboot ACK was lost; waiting for the new updater without resending reboot.', 'warn');
  }
  await withTimeout(session.link.closed, ctx.profile.transport.timeouts.reboot, 'Stock VRX did not restart into the RAM updater.');
  session.reset();
  session.settings = ctx.profile.transport;
  ctx.step('clean', 0.025, 'Select this VRX’s RAM updater port; disconnect other VRXs');
  await session.link.reopen({ timeoutMs: ctx.profile.transport.timeouts.updateBoot,
    filters: BOOTSTRAP_USB, acceptPort: allowsUsb, requireSelection: true });
  session.attach(session.link);
  const usb = session.link.port?.getInfo?.() ?? session.link.device?.usbInfo;
  if (!allowsUsb(usb)) throw new Error('Selected port is not the AR9311 RAM updater USB identity.');
  const info = await session.deviceInfo({ timeoutMs: 30000 });
  if (!ctx.profile.meta.identity.matches(info) || info.detail !== 'clean RAM mode') throw new Error('AR9311 RAM updater identity/readiness was not verified.');
  ctx.runtime.critical = false;
  ctx.runtime.bootstrapVerified = true;
  ctx.checkCancelled();
}
