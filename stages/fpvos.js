// fpvOS uses the same framing, but different ACK text, completion and reboot rules.
import { CMD, rebootPayload, encodeFileStart, parseFileAck, parseUpgradeStatus,
  sendFileChunks, sleep, withTimeout, TimeoutError } from '../transports/ascent.js';
import { AR9311_BOOTSTRAP } from './ar9311-bootstrap.js';

async function control(ctx, cmd, payload) {
  const f = await ctx.session.request(cmd, payload, { retryMs: 0, timeoutMs: 30000 });
  if (!f.crcOk || f.payload.length !== 68 || new DataView(f.payload.buffer, f.payload.byteOffset).getInt32(0, true) !== 0) {
    throw new Error('fpvOS control request rejected or damaged.');
  }
  return new TextDecoder().decode(f.payload.subarray(4)).replace(/\0.*$/s, '');
}

async function reconnect(ctx, usb = ctx.profile.meta.usb, matches = ctx.profile.meta.identity.matches) {
  const { session, profile } = ctx;
  await withTimeout(session.link.closed, profile.transport.timeouts.reboot, 'fpvOS did not disconnect for reboot.');
  session.reset();
  await session.link.reopen({ timeoutMs: profile.transport.timeouts.normalBoot, filters: usb,
    acceptDevice: async () => {
      session.reset();
      session.attach(session.link);
      return matches(await session.deviceInfo({ timeoutMs: 3000 }));
    },
    acceptPort: (info) => usb.some((u) => u.usbVendorId === info.usbVendorId && u.usbProductId === info.usbProductId) });
  session.attach(session.link);
  return session.deviceInfo({ timeoutMs: 15000 });
}

export async function FPVOS_PREPARE(ctx) {
  if (ctx.plan.bootstrapSelected) await AR9311_BOOTSTRAP(ctx);
  ctx.step('clean', 0.02, 'Preparing fpvOS RAM recovery');
  const detail = await control(ctx, CMD.REBOOT, rebootPayload('clean'));
  const info = detail.startsWith('rebooting into ') ? await reconnect(ctx) : await ctx.session.deviceInfo();
  if (!ctx.profile.meta.identity.matches(info) || info.detail !== 'clean RAM mode') throw new Error('fpvOS clean recovery identity was not verified.');
  ctx.runtime.updateInfo = info;
  ctx.runtime.updateVerified = true;
  if (!Number.isInteger(info.maxChunk) || info.maxChunk < 1) throw new Error('Invalid recovery transfer chunk limit.');
  ctx.runtime.chunkSize = Math.min(info.maxChunk, ctx.profile.transport.maxChunk);
}

export async function FPVOS_TRANSFER(ctx) {
  await control(ctx, CMD.REMOTE_UPGRADE);
  ctx.checkCancelled();
  const legacy = ctx.runtime.updateInfo.name === 'fpvOS AR9311 updater';
  await control(ctx, CMD.FILE_START, encodeFileStart({ md5hex: ctx.image.md5, length: ctx.image.bytes.length,
    remotePath: legacy ? '/tmp/pc/fpvos-ar9311.fwu' : '/tmp/pc/fpvos.fwu', localPath: '/fpvos-flasher/fpvos.fwu' }));
  await sendFileChunks(ctx.session, { bytes: ctx.image.bytes, chunkSize: ctx.runtime.chunkSize,
    timeoutMs: ctx.profile.transport.timeouts.data, signal: ctx.signal, strictCrc: true,
    onChunk: ({ sent }) => ctx.step('upload', 0.08 + 0.72 * sent / ctx.image.bytes.length, 'Sending fpvOS bundle') });
  ctx.checkCancelled();
  ctx.runtime.updateTriggered = true;
  // Single-shot: the ACK is not installation completion and may be lost after writes begin.
  let f;
  try {
    f = await ctx.session.request(CMD.FILE_END, undefined, { timeoutMs: 120000, retryMs: 0 });
  } catch (e) {
    if (!(e instanceof TimeoutError)) throw e;
    ctx.report.log('Finalization ACK was lost; querying installation status without resending FileEnd.', 'warn');
    return;
  }
  const ack = parseFileAck(f.payload);
  if (!f.crcOk || f.payload.length !== 80 || ack.status !== 0
    || ack.cursize !== ctx.image.bytes.length || ack.totalsize !== ctx.image.bytes.length) throw new Error(`fpvOS rejected bundle finalization: ${ack.detail || 'invalid ACK'}`);
}

export async function FPVOS_INSTALL(ctx) {
  const deadline = Date.now() + ctx.profile.transport.timeouts.install;
  for (;;) {
    const f = await ctx.session.request(CMD.UPGRADE_STATUS, undefined, { retryMs: 0 });
    const s = parseUpgradeStatus(f.payload);
    if (!f.crcOk || f.payload.length !== 72 || !Number.isInteger(s.percent) || s.percent < 0 || s.percent > 100) throw new Error('Invalid fpvOS installation status.');
    if (s.status < 0) throw new Error(`fpvOS installation failed (${s.status}): ${s.detail}`);
    if (s.status === 4 && s.percent === 100) { ctx.runtime.installComplete = true; return; }
    if (s.status !== 3) throw new Error(`fpvOS has not installed the bundle (state ${s.status}): ${s.detail}`);
    if (Date.now() >= deadline) throw new Error('fpvOS installation timed out; retain power and inspect recovery status.');
    ctx.step('install', 0.8 + 0.18 * s.percent / 100, s.detail);
    await sleep(ctx.profile.transport.timeouts.poll);
  }
}

export async function FPVOS_REBOOT_VERIFY(ctx) {
  ctx.step('restart', 0.98, 'Rebooting and verifying installed firmware');
  await control(ctx, CMD.REBOOT, rebootPayload('reboot'));
  const after = await reconnect(ctx, ctx.image.parsed.kind === 1 ? [{ usbVendorId: 0x1d75, usbProductId: 0x0101 }] : ctx.profile.meta.usb,
    ctx.image.parsed.kind === 1 ? (info) => info.name === 'Ascent_VRX' : ctx.profile.meta.identity.matches);
  if (ctx.image.parsed.kind === 1) {
    // Restoration keeps the stock root and data. No package hash is reported by stock.
    if (after.name !== 'Ascent_VRX' || !/^Ascent_G_Gnd_\d+_\d+_\d+$/.test(after.firmware)
      || !/^FPV-Ascent-Gnd-485-V\d+\.\d+-\d+\.\d+$/.test(after.hardware)
      || !after.serial || after.status !== 0) throw new Error('Original-stock restoration completed, but stock boot identity was not verified.');
  } else if (!ctx.profile.meta.identity.matches(after) || after.firmware !== ctx.image.parsed.sha256) {
    throw new Error('fpvOS installed package SHA-256 was not verified after reboot.');
  }
  ctx.runtime.finalInfo = after;
  ctx.runtime.postflashVerified = true;
}
