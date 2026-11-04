// Pure selection planning plus one sequential, profile-configured stage runner.
import { PROFILES, getProfile, profileForFileName, profileForImage, profileForDevice } from './devices/index.js';
import { compareVersions } from './firmware.js';
import { openFirmware } from './archive.js';
import { md5hex } from './transports/ascent.js';
import { formatBytes } from './devices/common.js';
import { supportsAr9311Bootstrap } from './stages/ar9311-bootstrap.js';

export async function prepareFirmware(file, { profile = null, onProgress = () => {} } = {}) {
  const opened = await openFirmware(file, {
    wanted: (name) => profile ? profile.meta.image.pattern.test(name)
      || profile.meta.id === 'ascent-vrx' && getProfile('fpvos-ar9311').meta.image.pattern.test(name) : PROFILES.some((p) => p.meta.image.pattern.test(name)),
    family: (name) => profileForFileName(name)?.meta.id, onProgress,
  });
  const imageProfile = profileForImage(opened.bytes);
  const parsed = imageProfile ? await imageProfile.meta.image.parse(opened.bytes, opened.name)
    : { errors: [`No supported hardware profile for this firmware image. Supported targets: ${PROFILES.map((p) => p.meta.name).join(', ')}.`], warnings: [], sections: [] };
  parsed.profileId = imageProfile?.meta.id ?? null;
  const image = { ...opened, parsed, md5: parsed.errors.length ? null : md5hex(opened.bytes) };
  image.view = {
    facts: [['From', opened.trail.join(' › ')], ['Image', parsed.boardName ?? 'unknown'],
      ['Profile', imageProfile?.meta.name ?? 'unsupported'], ['Version', parsed.versionText ?? ''],
      ['Size', formatBytes(opened.bytes.length)], ...(imageProfile?.meta.image.checks(parsed) ?? []),
      ['MD5', image.md5 ?? ''], ['Sent as', parsed.remoteName ?? '']].filter(([, value]) => value),
    columns: imageProfile?.meta.image.columns ?? ['Section', 'Size', 'Offset', 'Update flag'],
    rows: parsed.sections.map((s) => [s.name, formatBytes(s.length), s.offset == null ? '—' : `0x${s.offset.toString(16)}`, s.upgrade ? 'yes' : 'no']),
  };
  return image;
}

export function evaluateSelection({ info = null, profile = null, image = null, selectedProfile = null, unlockOverride = null } = {}) {
  const parsed = image?.parsed;
  const issues = [];
  if (image?.error) issues.push({ level: 'error', text: image.error });
  for (const text of image?.notes ?? []) issues.push({ level: 'info', text });
  for (const text of parsed?.errors ?? []) issues.push({ level: 'error', text });
  for (const text of parsed?.warnings ?? []) issues.push({ level: 'warn', text });
  if (info && !profile) issues.push({ level: 'error', text: `Unsupported device identity: ${info.name || info.firmware || 'unknown'}. Supported targets: ${PROFILES.map((p) => p.meta.name).join(', ')}. Selecting a profile cannot override device identity.` });
  if (profile && selectedProfile && profile !== selectedProfile) issues.push({ level: 'error', text: `The selected profile (${selectedProfile.meta.name}) does not match the connected ${profile.meta.name}.` });
  const target = selectedProfile ?? profile;
  const bootstrapRequested = profile?.meta.id === 'ascent-vrx' && parsed?.profileId === 'fpvos-ar9311' && parsed.kind === 0;
  const bootstrapSelected = bootstrapRequested && supportsAr9311Bootstrap(info);
  if (bootstrapRequested) {
    issues.push(bootstrapSelected
      ? { level: 'warn', text: 'Experimental stock-to-fpvOS bootstrap: stages the bundled RAM updater and changes USB identity. Disconnect other VRXs and explicitly select this unit’s RAM updater. Shared kernel/DTB writes are not power-loss atomic. No backup export is performed.' }
      : { level: 'error', text: 'The bundled bootstrap requires a healthy normal-mode standard VRX on stock 17.5.3, 17.5.8 or 18.21.10.' });
  }
  if (target && parsed?.profileId && target.meta.id !== parsed.profileId && !(bootstrapRequested && target === profile)) issues.push({ level: 'error', text: `This image is for ${getProfile(parsed.profileId).meta.name}, not ${target.meta.name}.` });
  const have = info && profile ? profile.meta.deviceVersion(info) : null;
  const matching = !!profile && (parsed?.profileId === profile.meta.id || bootstrapSelected) && !parsed.errors.length;
  const comparison = matching && have && parsed.version ? compareVersions(parsed.version, have) : null;
  const downgrade = comparison != null && comparison < 0;
  if (downgrade) issues.push({ level: 'warn', text: `The image (${parsed.versionText}) is older than the device's ${have.join('.')}. The device may refuse it.` });
  if (comparison === 0) issues.push({ level: 'info', text: `Same version number as the device (${have.join('.')}).` });
  const unlockAvailable = !bootstrapRequested && !!profile?.meta.unlock?.supported(info);
  const automaticUnlock = unlockAvailable && matching && downgrade && (!selectedProfile || selectedProfile === profile);
  const unlockSelected = unlockAvailable && (unlockOverride ?? automaticUnlock);
  const maxChunk = profile?.transport.maxChunk ?? 0;
  const executionProfile = bootstrapSelected ? getProfile('fpvos-ar9311') : profile;
  return Object.freeze({ profile, executionProfile, bootstrapSelected, issues: Object.freeze(issues), downgrade, unlockAvailable, automaticUnlock, unlockSelected,
    currentVersion: have, canFlash: !!(info && profile && matching && image.md5 && !issues.some((c) => c.level === 'error')),
    chunkSize: info?.maxChunk > 0 ? Math.min(info.maxChunk, maxChunk) : maxChunk });
}

export async function flashFirmware(session, profile, image, { info, usbInfo, unlock = false,
  progress = () => {}, log = () => {}, signal, ...options } = {}) {
  const plan = evaluateSelection({ info, profile, image, unlockOverride: unlock });
  if (!plan.canFlash || profileForDevice(info, usbInfo)?.meta !== profile?.meta) throw new Error('A validated image and matching connected hardware profile are required.');
  if (unlock && !plan.unlockAvailable) throw new Error('Preflash unlock is not supported for this connected hardware/firmware.');
  profile = plan.executionProfile;
  for (const name of ['preflash', 'flash', 'postflash']) {
    if (!Array.isArray(profile.stages[name]) || !profile.stages[name].length || profile.stages[name].some((step) => typeof step !== 'function')) {
      throw new Error(`Invalid ${name} stage array.`);
    }
  }
  const runtime = { critical: false, updateTriggered: false, updateVerified: false, installComplete: false, postflashVerified: false };
  const ctx = Object.freeze({
    session, profile, image: Object.freeze({ ...image }), originalDevice: Object.freeze({ ...info }), plan,
    options, signal, runtime, report: { progress, log },
    step: (stage, frac, text) => progress({ stage, frac, text }),
    checkCancelled: () => { if (signal?.aborted && !runtime.critical && !runtime.updateTriggered) throw new Error('Cancelled.'); },
  });
  try {
    for (const phase of ['preflash', 'flash', 'postflash']) {
      for (const step of profile.stages[phase]) { ctx.checkCancelled(); await step(ctx); }
      if (phase === 'preflash' && !runtime.updateVerified) throw new Error('Preflash stage did not verify update-mode identity.');
      if (phase === 'flash' && (!runtime.updateTriggered || !runtime.installComplete)) throw new Error('Flash stage did not confirm installation completion.');
      if (phase === 'postflash' && !runtime.postflashVerified) throw new Error('Postflash stage did not verify the result.');
    }
    if (!runtime.finalInfo) await session.link.close();
    ctx.step('done', 1, 'Done');
    return runtime.finalInfo;
  } catch (e) {
    await session.link.close();
    throw e;
  }
}
