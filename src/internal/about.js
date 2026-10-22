'use strict';

const SHORTCUTS = [
  ['New tab', '⌘T', 'Ctrl+T'],
  ['New window', '⌘N', 'Ctrl+N'],
  ['New Incognito* window', '⌘⇧N', 'Ctrl+Shift+N'],
  ['Close tab', '⌘W', 'Ctrl+W'],
  ['Reopen closed tab', '⌘⇧T', 'Ctrl+Shift+T'],
  ['Next / previous tab', '⌘⇧] / ⌘⇧[', 'Ctrl+Tab / Ctrl+Shift+Tab'],
  ['Go to tab 1–8 / last tab', '⌘1–8 / ⌘9', 'Ctrl+1–8 / Ctrl+9'],
  ['Address bar', '⌘L', 'Ctrl+L / Alt+D / F6'],
  ['Back / forward', '⌘[ / ⌘]', 'Alt+← / Alt+→'],
  ['Reload / force reload', '⌘R / ⌘⇧R', 'Ctrl+R or F5 / Ctrl+Shift+R'],
  ['Stop loading', 'Esc', 'Esc'],
  ['Find in page / next / previous', '⌘F / ⌘G / ⌘⇧G', 'Ctrl+F / Ctrl+G / Ctrl+Shift+G'],
  ['Zoom in / out / reset', '⌘= / ⌘- / ⌘0', 'Ctrl+= / Ctrl+- / Ctrl+0'],
  ['Print to branch', '⌘P', 'Ctrl+P'],
  ['Bookmark this page', '⌘D', 'Ctrl+D'],
  ['Show bookmarks bar', '⌘⇧B', 'Ctrl+Shift+B'],
  ['Bookmark manager', '⌥⌘B', 'Ctrl+Shift+O'],
  ['History', '⌘Y', 'Ctrl+H'],
  ['Downloads', '⌘⇧J', 'Ctrl+J'],
  ['Kevin sidebar', '⌘⇧K', 'Ctrl+Shift+K'],
  ['Settings', '⌘,', 'Ctrl+,'],
  ['Full screen', '⌃⌘F', 'F11'],
  ['Developer tools', '⌥⌘I', 'Ctrl+Shift+I / F12'],
];

async function main() {
  const info = await initPage('about');
  $('version').textContent = info.version;
  $('versions').replaceChildren(
    ...[
      ['Electron', info.electron],
      ['Chromium', info.chrome],
      ['Node.js', info.node],
      ['Platform', `${info.platform} ${info.arch}`],
      ['Southbag Identity', info.identity],
      ['Southbag Online Banking', info.banking],
      ['Palantir', info.palantir ? 'Watching' : 'Disabled (SOUTHBAG_PALANTIR_DISABLED)'],
    ].map(([k, v]) => el('li', {}, el('strong', { text: k }), el('span', { class: 'grow', text: v }))),
  );
  const mac = info.platform === 'darwin';
  $('keys').replaceChildren(
    ...SHORTCUTS.map(([action, macKeys, linuxKeys]) =>
      el('li', {}, el('span', { class: 'grow', text: action }), el('code', { text: mac ? macKeys : linuxKeys })),
    ),
  );
  $('update').addEventListener('click', () => {
    $('updateResult').textContent = 'Checking…';
    setTimeout(() => {
      $('updateResult').textContent = 'Southbag Browser is up to date. It always will be. Please do not ask again.';
    }, 2500);
  });
}

main();
