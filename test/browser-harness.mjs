// Shared CDP/browser/server plumbing. Native Web Serial is the default;
// simulated tests explicitly install their own initialization script.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

export const PUBLIC_ASSETS = new Set(['index.html', 'app.js', 'flasher.js', 'firmware.js',
  'devices/index.js', 'devices/common.js', 'devices/ascent-air.js', 'devices/ascent-vrx.js', 'devices/fpvos-ar9311.js', 'devices/fpvos-p1-air.js', 'devices/fpvos-bundle.js',
  'stages/ascent.js', 'stages/vrx-unlock.js', 'stages/fpvos.js', 'stages/ar9311-bootstrap.js', 'stages/p1-bootstrap.js', 'transports/p1-hid.js', 'transports/ascent.js', 'transports/web-serial.js',
  'assets/ar9311-updater/2026.10.31-ascent-vrx.1/manifest.json', 'assets/ar9311-updater/2026.10.31-ascent-vrx.1/fpvos-update-ar9311',
  'assets/ar9311-updater/2026.10.31-ascent-vrx.1/bootstrap.sh', 'assets/ar9311-updater/COPYING',
  'assets/p1-updater/browser-v1/manifest.json', 'assets/p1-updater/browser-v1/kernel.img', 'assets/p1-updater/browser-v1/betafpv-p1-air.dtb', 'assets/p1-updater/browser-v1/recovery-initrd.img', 'assets/p1-updater/README.txt', 'assets/p1-updater/COPYING',
  'archive.js', 'xz.js', 'checksum.js', 'fonts/ChakraPetch-Medium.ttf', 'fonts/ChakraPetch-SemiBold.ttf']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openBrowser({ root, out, permission, headless = true, onProblem = () => {} }) {
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!PUBLIC_ASSETS.has(name)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.html') ? 'text/html'
      : name.endsWith('.json') ? 'application/json' : name.endsWith('.ttf') ? 'font/ttf' : 'application/octet-stream' });
    fs.createReadStream(path.join(root, name)).on('error', (e) => res.destroy(e)).pipe(res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(out, 'chromium-'));
  if (permission) {
    fs.mkdirSync(path.join(profile, 'Default'));
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
      profile: { content_settings: { exceptions: { serial_chooser_data: {
        [`${origin},*`]: { setting: { 'chosen-objects': (Array.isArray(permission) ? permission : [permission]).map((p) =>
          ({ name: 'Sirius', vendor_id: p.vendorId, product_id: p.productId, serial_number: p.usbSerial })) },
        last_modified: String(BigInt(Date.now()) * 1000n + 11644473600000000n) },
      } } } },
    }));
  }
  let browser, socket, sessionId, nextId = 0;
  const pending = new Map(), problems = [];
  const rejectPending = (message) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    pending.clear();
  };
  const stop = () => {
    rejectPending('Browser harness stopped');
    socket?.close(); browser?.kill(); server.close();
  };
  const close = async () => {
    stop();
    if (browser?.pid && browser.exitCode == null && browser.signalCode == null) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); browser.removeListener('exit', done); resolve(); };
        const timer = setTimeout(done, 3000);
        browser.once('exit', done);
      });
    }
    if (!browser?.pid || browser.exitCode != null || browser.signalCode != null) {
      // Chromium children can finish writing just after the parent exits.
      await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };
  const cdp = (method, params = {}, page = true) => new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) { reject(new Error(`Browser unavailable: ${method}`)); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(page ? { sessionId } : {}) }));
  });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, ms, label) => {
    const deadline = Date.now() + ms;
    let last;
    while (Date.now() < deadline) {
      try { if (await evaluate(expression)) return; } catch (e) { last = e.message; }
      await sleep(100);
    }
    throw new Error(`Timed out: ${label ?? expression}${last ? ` (${last})` : ''}`);
  };
  const click = async (selector) => {
    const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const chooseFile = async (file) => {
    const { root: doc } = await cdp('DOM.getDocument');
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: '#file' });
    await cdp('DOM.setFileInputFiles', { nodeId, files: file ? [file] : [] });
  };
  const screenshot = async (name) => {
    await evaluate('window.scrollTo(0, 0)'); await sleep(50);
    const { cssContentSize: s } = await cdp('Page.getLayoutMetrics');
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(s.width), height: Math.ceil(s.height), scale: 1 } });
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
  };
  try {
    browser = spawn(process.env.CHROME ?? 'google-chrome', [...(headless ? ['--headless=new'] : []), '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      // Disposable profiles must not wait for an interactive desktop keyring.
      '--password-store=basic', '--use-mock-keychain',
      '--disable-renderer-backgrounding', '--window-size=1100,1600', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`Browser startup failed: ${text}`)), 15000);
      browser.once('error', (e) => { clearTimeout(timer); reject(e); });
      browser.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Browser exited during startup (${signal ?? code}): ${text}`)); });
      browser.stderr.on('data', (data) => {
        text += data;
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onclose = () => rejectPending('Browser connection closed');
    socket.onmessage = (event) => {
      const d = JSON.parse(event.data);
      if (d.id && pending.has(d.id)) {
        const p = pending.get(d.id); pending.delete(d.id); clearTimeout(p.timer);
        if (d.error) p.reject(new Error(d.error.message)); else p.resolve(d.result);
      } else if (d.method === 'Runtime.exceptionThrown' || d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
        const text = d.method === 'Runtime.exceptionThrown' ? d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text
          : d.params.args.map((a) => a.value ?? a.description).join(' ');
        problems.push(text); onProblem(text);
      }
    };
    const version = await cdp('Browser.getVersion', {}, false);
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' }, false);
    ({ sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true }, false));
    await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('DOM.enable');
    return { origin, browserPid: browser.pid, version, problems, cdp, evaluate, until, click, chooseFile, screenshot, stop, close };
  } catch (e) { await close(); throw e; }
}
