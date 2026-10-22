/**
 * Things that touch the operating system: launching Southbag Terminal, and becoming the
 * default browser (http/https handlers plus, on Linux, xdg's default-web-browser).
 */

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_MAC = process.platform === 'darwin';
const TERMINAL_RELEASES = 'https://github.com/SouthbagHQ/terminal/releases';

function onPath(command) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, command);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

/** Where Southbag Terminal might be installed. First hit wins. */
function findTerminal() {
  if (process.env.SOUTHBAG_TERMINAL_PATH && fs.existsSync(process.env.SOUTHBAG_TERMINAL_PATH)) {
    return { kind: 'exec', path: process.env.SOUTHBAG_TERMINAL_PATH };
  }
  if (IS_MAC) {
    for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      const app = path.join(dir, 'Southbag Terminal.app');
      if (fs.existsSync(app)) return { kind: 'mac-app', path: app };
    }
    return null;
  }
  const command = onPath('southbag-terminal');
  if (command) return { kind: 'exec', path: command };
  for (const candidate of ['/opt/Southbag Terminal/southbag-terminal', '/usr/lib/southbag-terminal/southbag-terminal']) {
    if (fs.existsSync(candidate)) return { kind: 'exec', path: candidate };
  }
  for (const dir of [path.join(os.homedir(), 'Applications'), path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), '.local/bin')]) {
    try {
      const image = fs.readdirSync(dir).find((name) => /^southbag-terminal.*\.AppImage$/i.test(name));
      if (image) return { kind: 'exec', path: path.join(dir, image) };
    } catch {}
  }
  for (const dir of [path.join(os.homedir(), '.local/share/applications'), '/usr/share/applications', '/usr/local/share/applications']) {
    if (fs.existsSync(path.join(dir, 'southbag-terminal.desktop')) && onPath('gtk-launch')) {
      return { kind: 'desktop', path: 'southbag-terminal' };
    }
  }
  return null;
}

/** Resolves { ok: true } once launched, or { ok: false, reason } with a link to the releases. */
function launchTerminal() {
  const found = findTerminal();
  if (!found) return Promise.resolve({ ok: false, reason: 'not_installed', releases: TERMINAL_RELEASES });
  return new Promise((resolve) => {
    let child;
    try {
      if (found.kind === 'mac-app') child = spawn('open', ['-a', found.path], { detached: true, stdio: 'ignore' });
      else if (found.kind === 'desktop') child = spawn('gtk-launch', [found.path], { detached: true, stdio: 'ignore' });
      else child = spawn(found.path, [], { detached: true, stdio: 'ignore', cwd: os.homedir() });
    } catch (error) {
      resolve({ ok: false, reason: 'spawn_failed', message: error.message, releases: TERMINAL_RELEASES });
      return;
    }
    child.once('error', (error) =>
      resolve({ ok: false, reason: 'spawn_failed', message: error.message, releases: TERMINAL_RELEASES }),
    );
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, kind: found.kind });
    });
  });
}

const DESKTOP_FILE = 'southbag-browser.desktop';

/** The protocol client registration needs the script path when running unpackaged (`electron .`). */
function protocolArgs(app) {
  if (process.defaultApp && process.argv.length >= 2) return [process.execPath, [path.resolve(process.argv[1])]];
  return [];
}

function isDefaultBrowser(app) {
  const args = protocolArgs(app);
  return app.isDefaultProtocolClient('https', ...args) && app.isDefaultProtocolClient('http', ...args);
}

/**
 * macOS: asks LaunchServices (the system shows its own "change default browser?" prompt).
 * Linux: xdg-mime for the schemes (what Electron does), plus xdg-settings and text/html so
 * desktop environments that ask "which browser" also get the right answer.
 */
async function setDefaultBrowser(app) {
  const args = protocolArgs(app);
  const http = app.setAsDefaultProtocolClient('http', ...args);
  const https = app.setAsDefaultProtocolClient('https', ...args);
  if (process.platform === 'linux') {
    const run = (cmd, cmdArgs) =>
      new Promise((resolve) => execFile(cmd, cmdArgs, { timeout: 5000 }, (error) => resolve(!error)));
    await run('xdg-settings', ['set', 'default-web-browser', DESKTOP_FILE]);
    await run('xdg-mime', ['default', DESKTOP_FILE, 'text/html', 'application/xhtml+xml']);
  }
  return { ok: http && https, isDefault: isDefaultBrowser(app) };
}

/** URLs and HTML files we were asked to open on the command line (default-browser launches). */
function urlsFromArgv(argv, cwd = process.cwd()) {
  const urls = [];
  // Skip the executable, and the app path when running unpackaged.
  const start = process.defaultApp ? 2 : 1;
  for (const arg of argv.slice(start)) {
    if (!arg || arg.startsWith('-')) continue;
    if (/^(https?|file):\/\//i.test(arg)) {
      urls.push(arg);
      continue;
    }
    if (/\.(x?html?|shtml|svg|pdf|txt)$/i.test(arg)) {
      const full = path.resolve(cwd, arg);
      if (fs.existsSync(full)) urls.push(require('node:url').pathToFileURL(full).toString());
    }
  }
  return urls;
}

module.exports = { findTerminal, launchTerminal, isDefaultBrowser, setDefaultBrowser, urlsFromArgv, TERMINAL_RELEASES };
