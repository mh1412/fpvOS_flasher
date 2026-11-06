// Fetch and verify all recovery assets before any bootloader RAM modification.
import { P1HidRecovery, P1_RAM_FILES, p1Bootloader, sha256 } from '../transports/p1-hid.js';
export { enterP1Bootloader, P1_STOCK_USB, P1_HID_FILTER, P1_STOCK_VERSIONS } from '../transports/p1-hid.js';
export const P1_RECOVERY_BASE = new URL('../assets/p1-updater/browser-v1/', import.meta.url);
export const P1_RECOVERY_MANIFEST_SHA256 = '3bc35e4d9851218a37c682a80c5033c607574aefea6e8deb1c9f3ca0ff0a3fbe';
async function fetchBytes(name, limit, fetcher, signal) {
  const response = await fetcher(new URL(name, P1_RECOVERY_BASE), { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Cannot load P1 recovery ${name}: HTTP ${response.status}.`);
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) throw new Error(`P1 recovery ${name} exceeds its size limit.`);
      parts.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
export async function loadP1Recovery({ fetcher = globalThis.fetch, signal } = {}) {
  const raw = await fetchBytes('manifest.json', 8192, fetcher, signal);
  if (await sha256(raw) !== P1_RECOVERY_MANIFEST_SHA256) throw new Error('P1 recovery manifest SHA-256 mismatch.');
  const manifest = JSON.parse(new TextDecoder().decode(raw));
  if (manifest.format !== 1 || manifest.board_id !== 1345409867 || manifest.version !== 'browser-v1') throw new Error('Unsupported P1 recovery manifest.');
  const files = [];
  for (const [name, [address, limit]] of Object.entries(P1_RAM_FILES)) {
    const entry = manifest.files[name];
    if (!Number.isInteger(entry?.size) || entry.size < 1 || entry.size > limit || entry.address !== address || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid P1 recovery asset metadata.');
    const bytes = await fetchBytes(name, entry.size, fetcher, signal);
    if (bytes.length !== entry.size || await sha256(bytes) !== entry.sha256) throw new Error(`P1 recovery ${name} size/SHA-256 mismatch.`);
    files.push({ name, bytes });
  }
  return { manifest, files };
}
export async function prepareP1Recovery(device, { stockVersion, signal, fetcher, progress = () => {}, log = () => {} } = {}) {
  const { id } = p1Bootloader(stockVersion);
  progress('Downloading and checking P1 recovery…');
  const assets = await loadP1Recovery({ fetcher, signal });
  const link = new P1HidRecovery(device, { stockVersion, signal, log,
    progress: ({ bytes, total }) => progress(`Loading P1 recovery: ${Math.round(bytes * 100 / total)}%`) });
  try {
    await link.open(); progress('Checking the P1 bootloader…');
    await link.identify(assets.manifest.bootloaders[id].fingerprints);
    for (const { name, bytes } of assets.files) { progress(`Loading ${name} into RAM…`); await link.upload(name, bytes); }
    progress('Starting P1 recovery…'); await link.boot();
  } finally { await link.close(); }
}
