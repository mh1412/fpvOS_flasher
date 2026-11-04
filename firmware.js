// Shared container/version helpers, independent of any device transport.
export function aswBoard(bytes) {
  if (bytes.length < 0x80 || bytes[0] !== 0x41 || bytes[1] !== 0x53 || bytes[2] !== 0x57 || bytes[3] !== 0) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
}

// Both current profiles report product_<major>_<minor>_<patch> firmware names.
export function firmwareVersion(fw) {
  const m = /(\d+)_(\d+)_(\d+)$/.exec(fw ?? '');
  return m ? m.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
