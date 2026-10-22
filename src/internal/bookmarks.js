'use strict';

const SMUG = 'Southbag bookmarks are a permanent feature of your workspace. Removing them is not permitted by Southbag policy.';

function row(bookmark) {
  const icon = bookmark.southbag
    ? el('img', { src: 'mark.png', alt: '' })
    : bookmark.favicon
      ? el('img', { src: bookmark.favicon, alt: '' })
      : el('span', { style: 'width:16px' });
  const title = el('a', { href: bookmark.url, text: bookmark.title });
  const actions = [];
  if (bookmark.southbag) {
    // The remove button exists only so it can be disabled at you.
    const remove = el('button', { type: 'button', class: 'btn-small', disabled: true, title: SMUG, text: 'remove' });
    actions.push(el('span', { title: SMUG }, remove));
  } else {
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn-small',
        'data-track': 'bookmark_rename',
        text: 'rename',
        onclick: () => {
          const input = el('input', { type: 'text', value: bookmark.title, size: 30 });
          const save = () => call('bookmarks:rename', bookmark.id, input.value.trim() || bookmark.title);
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') save();
            if (event.key === 'Escape') call('bookmarks:list').then(render);
          });
          input.addEventListener('blur', save);
          title.replaceWith(input);
          input.focus();
          input.select();
        },
      }),
      el('button', {
        type: 'button',
        class: 'btn-small',
        'data-track': 'bookmark_remove',
        text: 'remove',
        onclick: () => call('bookmarks:remove', bookmark.id),
      }),
    );
  }
  return el('li', {}, icon, el('span', { class: 'grow' }, title, ' ', el('span', { class: 'url', text: bookmark.url })), ...actions);
}

function render({ southbag, user }) {
  $('southbag').replaceChildren(...southbag.map(row));
  $('mine').replaceChildren(...user.map(row));
  $('empty').hidden = user.length > 0;
}

async function main() {
  await initPage('bookmarks');
  render(await call('bookmarks:list'));
  sb.on('bookmarks', render);
  $('addForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    let url = $('addUrl').value.trim();
    if (url && !/^[a-z]+:/i.test(url)) url = `https://${url}`;
    const result = await call('bookmarks:add', { title: $('addTitle').value.trim() || url, url });
    $('addResult').textContent = result.ok ? (result.existing ? 'Already bookmarked.' : 'Added.') : result.error;
    if (result.ok) {
      $('addTitle').value = '';
      $('addUrl').value = '';
    }
  });
}

main();
