// Regenerates build/icon.png (the app icon) and src/renderer/mark.png (the small square mark used
// for tabs and bookmarks) from src/renderer/logo.png. Needs a display:
//
//   npx electron scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icons-'));
const logo = pathToFileURL(path.join(root, 'src/renderer/logo.png')).toString();

const ICON = `<!DOCTYPE html><html><body style="margin:0;width:1024px;height:1024px;overflow:hidden;background:transparent">
<div style="position:absolute;left:40px;top:40px;width:944px;height:944px;box-sizing:border-box;border:36px solid #0d6efd;border-radius:170px;background:#fff;overflow:hidden">
  <img src="${logo}" style="position:absolute;left:62px;top:190px;width:748px">
  <svg viewBox="0 0 100 100" style="position:absolute;left:286px;top:500px;width:300px;height:300px">
    <circle cx="50" cy="50" r="44" fill="none" stroke="#0d6efd" stroke-width="5"/>
    <ellipse cx="50" cy="50" rx="20" ry="44" fill="none" stroke="#0d6efd" stroke-width="4"/>
    <line x1="6" y1="50" x2="94" y2="50" stroke="#0d6efd" stroke-width="4"/>
    <path d="M12 28 Q50 38 88 28 M12 72 Q50 62 88 72" fill="none" stroke="#0d6efd" stroke-width="4"/>
    <circle cx="80" cy="20" r="13" fill="#ff9800" stroke="#fff" stroke-width="3"/>
    <circle cx="80" cy="20" r="4" fill="#fff"/>
  </svg>
</div></body></html>`;

// The "s" of the wordmark, on its own: the logo's first letter fills a small square.
const MARK = `<!DOCTYPE html><html><body style="margin:0;width:128px;height:128px;overflow:hidden;background:transparent">
<div style="position:absolute;inset:0;border-radius:28px;background:#fff;border:8px solid #0d6efd;box-sizing:border-box;overflow:hidden">
  <div style="position:absolute;left:30px;top:0;width:52px;height:112px;overflow:hidden"><img src="${logo}" style="position:absolute;left:-40px;top:-46px;height:200px"></div>
</div></body></html>`;

async function render(html, size, file) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    useContentSize: true,
    enableLargerThanScreen: true,
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  win.setContentSize(size, size);
  const page = path.join(dir, `${path.basename(file, '.png')}.html`);
  fs.writeFileSync(page, html);
  await win.loadFile(page);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  fs.writeFileSync(path.join(root, file), image.resize({ width: size, height: size }).toPNG());
  console.log('wrote', file);
}

app.whenReady().then(async () => {
  await render(MARK, 128, 'src/renderer/mark.png');
  await render(ICON, 1024, 'build/icon.png');
  app.quit();
});
