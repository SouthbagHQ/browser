'use strict';

async function launch() {
  $('title').textContent = 'Opening Southbag Terminal…';
  const result = await call('terminal:launch');
  if (result.ok) {
    $('title').textContent = 'Southbag Terminal is open.';
    $('detail').textContent = 'It should be in front of you now. Kevin is watching both of them.';
    $('download').hidden = true;
  } else {
    $('title').textContent = 'Southbag Terminal is not installed.';
    $('detail').textContent =
      result.reason === 'not_installed'
        ? 'We looked everywhere a sensible person would install it. Download it, then come back here.'
        : `It would not start: ${result.message || result.reason}.`;
    $('download').hidden = false;
  }
}

async function main() {
  await initPage('terminal');
  $('again').addEventListener('click', launch);
  launch();
}

main();
