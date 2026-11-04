// Profile-specific one-shot RAM version overlay, using the stock clean script
// hook. Only staged text is uploaded; no FileEnd is sent until the real image.
import { uploadUnfinalized, rebootIntoUpdateMode } from '../transports/ascent.js';
import { ASCENT_ENTER_UPDATE } from './ascent.js';

export const VRX_UNLOCK_VERSION = '0.0.0';

export function buildVrxUnlock(token = crypto.randomUUID().replaceAll('-', '')) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Invalid unlock token.');
  const name = `fpvos-unlock-${token}.sh`;
  const remotePath = `/usrdata/${name}`;
  const ramPath = `/tmp/${name}`;
  const script = `#!/bin/sh
# fpvOS one-shot standard VRX preflash: preserve board/custom/build metadata.
staged='${remotePath}'
ram='${ramPath}'
version='/tmp/fpvos-version-${token}'
overlay=0
fail() {
  echo "fpvOS unlock failed: $*" >&2
  if [ "$overlay" = 1 ]; then umount /etc/app.version; fi
  rm -f "$staged" "$ram"
  sync
  /bin/sh /etc/sys_reboot.sh >/tmp/fpvos-unlock-recovery.log 2>&1 &
  exit 1
}
[ "$(id -u)" = 0 ] || exit 1
if [ "\${1:-}" != '--ram' ]; then
  [ "\${upgrade_mode:-}" = web ] || exit 1
  [ "\${flagfile:-}" = /factory/sirius-clean-system-flag ] || exit 1
  case "$(tr '\\000' ' ' </proc/$$/cmdline)" in
    */etc/init.d/start_clean_system.sh*) ;;
    *) exit 1 ;;
  esac
  # exec releases the sourced file on usrdata before OTA unmounts storage.
  cp "$staged" "$ram" || fail 'RAM script copy'
  rm -f "$staged" || fail 'staged script cleanup'
  exec /bin/sh "$ram" --ram
  exit 1
fi
[ "$0" = "$ram" ] || exit 1
[ ! -e /factory/sirius-clean-system-flag ] || fail 'selector not consumed'
[ "$(sed -n 's/^BOARD_TYPE=//p' /etc/app.version)" = Gnd485 ] || fail 'not board Gnd485'
[ -r /etc/init.d/start_clean_system_fpv_upgrade.sh ] || fail 'missing vendor update initializer'
umask 077
sed 's/^APP_VERSION=.*/APP_VERSION=${VRX_UNLOCK_VERSION}/' /etc/app.version >"$version" || fail 'version copy'
[ "$(sed -n 's/^APP_VERSION=//p' "$version")" = '${VRX_UNLOCK_VERSION}' ] || fail 'invalid version copy'
mount --bind "$version" /etc/app.version || fail 'version overlay'
overlay=1
[ "$(sed -n 's/^APP_VERSION=//p' /etc/app.version)" = '${VRX_UNLOCK_VERSION}' ] || fail 'overlay verification'
# Unmount persistent storage, then use the vendor GPIO/driver/USB/daemon setup.
/bin/sh /etc/ota-prepare.sh real_do || fail 'OTA preparation'
rtfs_dir=/tmp
set -- 1
. /etc/init.d/start_clean_system_fpv_upgrade.sh
rm -f "$ram"
exit 0
`;
  const encode = (s) => new TextEncoder().encode(s);
  return { script, remotePath, ramPath,
    files: [{ remotePath, bytes: encode(script) },
      { remotePath: '/factory/sirius-clean-system-flag', bytes: encode(`web:${remotePath}\n`) }] };
}

export async function VRX_UNLOCK(ctx) {
  const { session, originalDevice: info, signal } = ctx;
  if (!ctx.profile.meta.unlock.supported(info)) throw new Error('Unlock requires a healthy normal-mode standard VRX with a valid firmware version.');
  const plan = buildVrxUnlock();
  const chunkSize = info.maxChunk > 0 ? Math.min(65536, info.maxChunk) : 65536;
  ctx.step('unlock', 0.005, 'Staging the one-shot VRX unlock script');
  await uploadUnfinalized(session, plan.files[0], { signal, chunkSize });
  ctx.checkCancelled();
  ctx.runtime.critical = true;
  ctx.step('unlock', 0.015, 'Arming the one-shot clean-mode selector');
  // Once armed, finish the ordinary reboot even if cancellation was requested.
  // An abort is honored after the selector is consumed, before image upload.
  await uploadUnfinalized(session, plan.files[1], { chunkSize });
  ctx.report.log(`armed one-shot VRX unlock script ${plan.remotePath}`);
  ctx.runtime.updateMode = 'unlock';
  ctx.runtime.updateInfo = await rebootIntoUpdateMode(session, { mode: 'normal', stage: 'unlock',
    timeoutMs: ctx.profile.transport.timeouts.updateBoot, progress: ctx.report.progress, log: ctx.report.log });
}

export async function VRX_PREPARE_UPDATE_MODE(ctx) {
  if (ctx.plan.unlockSelected) await VRX_UNLOCK(ctx);
  else await ASCENT_ENTER_UPDATE(ctx);
}
