'use strict';

let entries = [];

function dayLabel(time) {
  const date = new Date(time);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function render() {
  const query = $('filter').value.trim().toLowerCase();
  const shown = query
    ? entries.filter((entry) => `${entry.title} ${entry.url}`.toLowerCase().includes(query))
    : entries;
  $('count').textContent = `${shown.length.toLocaleString()} of ${entries.length.toLocaleString()} visits`;
  const days = $('days');
  days.innerHTML = '';
  let list;
  let current;
  for (const entry of shown.slice(0, 1500)) {
    const label = dayLabel(entry.visitedAt);
    if (label !== current) {
      current = label;
      list = el('ul', { class: 'list' });
      days.append(el('section', { class: 'card' }, el('h3', { text: label }), list));
    }
    const time = new Date(entry.visitedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    list.append(
      el(
        'li',
        {},
        el('span', { class: 'muted', text: time }),
        el(
          'span',
          { class: 'grow' },
          el('a', { href: entry.url, text: entry.title || entry.url }),
          ' ',
          el('span', { class: 'url', text: entry.url }),
        ),
        el('button', {
          type: 'button',
          class: 'btn-small',
          'data-track': 'history_remove',
          text: 'remove',
          onclick: async () => {
            await call('history:remove', entry.visitedAt);
            entries = entries.filter((e) => e !== entry);
            render();
          },
        }),
      ),
    );
  }
  if (!shown.length) days.append(el('p', { class: 'muted', text: query ? 'Nothing matches. Kevin has checked.' : 'No history yet. Go outside (browse the web).' }));
}

async function main() {
  await initPage('history');
  entries = await call('history:list');
  render();
  $('filter').addEventListener('input', render);
  $('clearAll').addEventListener('click', async () => {
    if (!confirm('Clear all browsing history? Kevin will pretend he did not see it.')) return;
    await call('history:clear');
    entries = [];
    render();
  });
}

main();
