'use strict';

function describe(d) {
  const size = d.totalBytes ? `${formatBytes(d.receivedBytes)} of ${formatBytes(d.totalBytes)}` : formatBytes(d.receivedBytes);
  if (d.state === 'progressing') return `${d.paused ? 'Paused' : 'Downloading'}: ${size}`;
  if (d.state === 'completed') return `Done. ${formatBytes(d.receivedBytes)}. Kevin has scanned it (he has not).`;
  if (d.state === 'cancelled') return 'Cancelled.';
  return 'Failed. Have you tried a branch?';
}

function render(list) {
  $('empty').hidden = list.length > 0;
  $('list').replaceChildren(
    ...list.map((d) => {
      const percent = d.totalBytes ? Math.round((d.receivedBytes / d.totalBytes) * 100) : null;
      const info = el(
        'span',
        { class: 'grow' },
        el('strong', { text: d.filename }),
        d.isPrivate ? el('span', { class: 'badge', text: 'Incognito*' }) : null,
        el('br'),
        el('span', { class: 'muted', text: describe(d) }),
        d.state === 'progressing'
          ? el('div', { class: 'progress' }, el('div', { style: `width:${percent ?? 5}%` }))
          : null,
      );
      const button = (label, method, track) =>
        el('button', { type: 'button', class: 'btn-small', 'data-track': track, text: label, onclick: () => call(method, d.id) });
      const actions =
        d.state === 'progressing'
          ? [button(d.paused ? 'resume' : 'pause', 'downloads:pause', 'download_pause'), button('cancel', 'downloads:cancel', 'download_cancel')]
          : d.state === 'completed'
            ? [button('open', 'downloads:open', 'download_open'), button('show in folder', 'downloads:show', 'download_show')]
            : [];
      return el('li', {}, info, ...actions);
    }),
  );
}

async function main() {
  const info = await initPage('downloads');
  $('where').textContent = `Saved to ${info.downloadsDir}`;
  render(await call('downloads:list'));
  sb.on('downloads', render);
  $('clear').addEventListener('click', () => call('downloads:clear'));
}

main();
