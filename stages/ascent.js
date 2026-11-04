// Predefined sequential operations for the shared Ascent updater protocol.
import { CMD, encodeFileStart, parseFileAck, parseUpgradeStatus, sendFileChunks,
  rebootIntoUpdateMode, sleep, withTimeout, LinkLostError, TimeoutError } from '../transports/ascent.js';

export async function ASCENT_ENTER_UPDATE(ctx) {
  ctx.runtime.updateMode = 'clean';
  ctx.runtime.updateInfo = await rebootIntoUpdateMode(ctx.session, {
    timeoutMs: ctx.profile.transport.timeouts.updateBoot, signal: ctx.signal,
    progress: ctx.report.progress, log: ctx.report.log,
  });
}

export function VERIFY_UPDATE_MODE(ctx) {
  const { identity } = ctx.profile.meta;
  const current = ctx.runtime.updateInfo;
  // The update-mode predicate owns the complete identity check: a clean
  // updater can report a different model name from its normal-mode firmware.
  if (!current || !identity.updateMatches(current, ctx.originalDevice, ctx.runtime.updateMode)) {
    throw new Error('The reconnected device does not match the original hardware profile/identity.');
  }
  ctx.runtime.updateVerified = true;
  ctx.runtime.critical = false;
  if (ctx.runtime.updateMode === 'unlock') {
    ctx.report.log(`Verified ${ctx.profile.meta.name} preflash unlock and clean-mode identity.`);
    ctx.step('unlock', 0.05, `Verified unlocked update daemon (version ${current.sdk})`);
  } else if (!identity.normalMatches(current, ctx.originalDevice)) {
    ctx.report.log('Clean updater uses placeholder factory fields; matched the documented profile identity.', 'warn');
  }
  ctx.checkCancelled();
}

export async function ASCENT_START_FIRMWARE(ctx) {
  ctx.step('clean', 0.06, 'Starting the update');
  await ctx.session.request(CMD.REMOTE_UPGRADE, undefined, { timeoutMs: 30000 });
  ctx.checkCancelled();
  const { bytes, md5, parsed } = ctx.image;
  const remotePath = `/tmp/pc/${parsed.remoteName}`;
  ctx.step('upload', 0.08, 'Sending the firmware');
  ctx.report.log(`file ${remotePath}, ${bytes.length} bytes, md5 ${md5}`);
  await ctx.session.request(CMD.FILE_START, encodeFileStart({ md5hex: md5, length: bytes.length,
    remotePath, localPath: `/fpvos-flasher/${parsed.remoteName}` }));
  await sleep(100);
}

export async function ASCENT_SEND_FIRMWARE(ctx) {
  await sendFileChunks(ctx.session, { bytes: ctx.image.bytes, chunkSize: ctx.plan.chunkSize,
    timeoutMs: ctx.options.dataTimeoutMs ?? ctx.profile.transport.timeouts.data, signal: ctx.signal,
    allowZeroLength: ctx.profile.transport.allowZeroDataAckLength === true,
    onChunk: ({ index, sent, ack }) => {
      ctx.report.log(`chunk ${index}: length ${ack.length}, unit has ${ack.cursize}/${ack.totalsize}, status ${ack.status} ${ack.detail}`, 'debug');
      ctx.step('upload', 0.08 + 0.72 * sent / ctx.image.bytes.length,
        `Sending the firmware (${Math.round(100 * sent / ctx.image.bytes.length)}%)`);
    } });
}

export async function ASCENT_FINALIZE_FIRMWARE(ctx) {
  ctx.checkCancelled();
  // FileEnd can start programming before its acknowledgment. Disable further
  // cancellation before sending it, not only after the reply arrives.
  ctx.runtime.updateTriggered = true;
  ctx.step('upload', 0.8, 'Unit is checking the file');
  const end = parseFileAck((await ctx.session.request(CMD.FILE_END, undefined, { timeoutMs: 30000, retryMs: 5000 })).payload);
  ctx.report.log(`file end: status ${end.status}, "${end.detail}"`);
  if (end.status !== 0 || end.detail !== 'OK') throw new Error(`The unit rejected the file: ${end.detail || `status ${end.status}`}`);
}

export async function ASCENT_WAIT_INSTALL(ctx) {
  ctx.step('install', 0.82, 'Writing the firmware to flash');
  const started = Date.now();
  let last = '', percent = -1;
  for (;;) {
    let s;
    try {
      await sleep(ctx.profile.transport.timeouts.poll);
      s = parseUpgradeStatus((await ctx.session.request(CMD.UPGRADE_STATUS)).payload);
    } catch (e) {
      if (e instanceof LinkLostError && percent >= 90) { ctx.report.log(`unit restarted at ${percent}%`, 'warn'); break; }
      throw e;
    }
    const now = `${s.percent}% status ${s.status} ${s.detail}`;
    if (now !== last) { ctx.report.log(`install: ${now}`); last = now; }
    if (!Number.isInteger(s.percent) || !Number.isInteger(s.status)) throw new Error('The unit sent a malformed update-status reply.');
    if (s.status < 0) throw new Error(`The unit reports update failure (status ${s.status})${s.detail ? `: ${s.detail}` : '.'}`);
    percent = s.percent;
    if (/fail|error|err\b/i.test(s.detail)) throw new Error(`The unit reports: ${s.detail}`);
    if (s.percent > 99) break;
    if (Date.now() - started > ctx.profile.transport.timeouts.install) throw new TimeoutError('The install did not finish within 10 minutes.');
    ctx.step('install', 0.82 + 0.16 * Math.max(0, Math.min(99, s.percent)) / 100,
      `Writing the firmware to flash (${Math.max(0, s.percent)}%)`);
  }
  ctx.runtime.installComplete = true;
}

export async function ASCENT_RECONNECT(ctx) {
  ctx.step('restart', 0.98, 'Unit is restarting');
  const link = ctx.session.link;
  try {
    await withTimeout(link.closed, ctx.profile.transport.timeouts.reboot, 'The unit did not restart after the update.');
    ctx.session.reset();
    await link.reopen({ timeoutMs: ctx.profile.transport.timeouts.normalBoot });
    ctx.session.attach(link);
    await sleep(500);
    ctx.runtime.finalInfo = await ctx.session.deviceInfo({ timeoutMs: 15000 });
    ctx.report.log(`unit reports firmware "${ctx.runtime.finalInfo.firmware}"`);
  } catch (e) {
    ctx.report.log(`could not read the unit after the update: ${e.message}`, 'warn');
    ctx.runtime.finalInfo = null;
  }
}

export function VERIFY_INSTALLED_FIRMWARE(ctx) {
  const after = ctx.runtime.finalInfo;
  if (after) {
    if (!ctx.profile.meta.identity.matches(after) || !ctx.profile.meta.identity.normalMatches(after, ctx.originalDevice)) {
      const identity = ({ name, hardware, serial }) => JSON.stringify({ name, hardware, serial });
      throw new Error(`The reconnected device does not match the original hardware profile/identity. Before: ${identity(ctx.originalDevice)}; after: ${identity(after)}.`);
    }
    if (after.firmware !== ctx.image.parsed.remoteName.replace(/\.img$/, '')) {
      throw new Error(`Installed firmware does not match the requested image: ${after.firmware || 'unknown'}.`);
    }
  }
  ctx.runtime.postflashVerified = true;
}

export const ASCENT_FLASH_STEPS = Object.freeze([ASCENT_START_FIRMWARE, ASCENT_SEND_FIRMWARE, ASCENT_FINALIZE_FIRMWARE, ASCENT_WAIT_INSTALL]);
export const ASCENT_POSTFLASH_STEPS = Object.freeze([ASCENT_RECONNECT, VERIFY_INSTALLED_FIRMWARE]);
