import { aswBoard, firmwareVersion } from '../firmware.js';
import { ASCENT_TRANSPORT } from '../transports/ascent.js';

export const sameFactoryIdentity = (current, before) => (!before.serial || current.serial === before.serial)
  && (!before.hardware || current.hardware === before.hardware);
export const formatBytes = (n) => n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(2)} MiB` : `${(n / 1024).toFixed(1)} KiB`;
export const formatHex = (n) => `0x${n.toString(16).padStart(8, '0')}`;

export function aswImage({ prefix, board, parse, checks, capacity = false }) {
  return Object.freeze({ prefix, pattern: new RegExp(`^${prefix}_\\d+_\\d+_\\d+\\.img$`, 'i'),
    detect: (bytes) => aswBoard(bytes) === board, parse, checks,
    columns: Object.freeze(['Section', capacity ? 'Capacity' : 'Size', capacity ? 'First file offset' : 'Offset', 'Update flag']) });
}

export function defineDevice({ meta, transport = ASCENT_TRANSPORT, stages }) {
  return Object.freeze({
    meta: Object.freeze({ ...meta, deviceVersion: meta.deviceVersion ?? ((info) => firmwareVersion(info.firmware)) }),
    transport,
    stages: Object.freeze(Object.fromEntries(['preflash', 'flash', 'postflash'].map((name) => [name, Object.freeze([...stages[name]])]))),
  });
}
