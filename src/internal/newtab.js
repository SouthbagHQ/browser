'use strict';

const APP_BLURBS = {
  Southbag: 'The mothership',
  Banking: 'Where money goes to die',
  Drive: 'Files, inspected',
  Office: 'Documents, monitored',
  Git: 'Code, reviewed by Kevin',
  Social: 'You already have an account',
  Code: 'AI, escalated',
  Support: 'Help is not guaranteed',
  Lore: 'Everything we want you to know',
  Docs: 'Under construction since launch',
  'Branch Locator': 'Find a branch. Any branch.',
  Identity: 'Who you are, officially',
};

function greeting(name) {
  const hour = new Date().getHours();
  const part = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = (name || '').split(' ')[0];
  return `${part}${first ? `, ${first}` : ''}. Kevin has been expecting you.`;
}

async function loadAccount() {
  const result = await call('account');
  const balance = $('balance');
  const note = $('accountNote');
  const list = $('transactions');
  list.innerHTML = '';
  if (!result.ok) {
    balance.textContent = '$—';
    note.textContent =
      result.status === 401
        ? 'The bank does not recognise you. Have you tried logging in to Banking?'
        : `The bank is not answering (${result.error}). Your money is probably fine. Probably.`;
    return;
  }
  balance.textContent = money(result.balance);
  balance.classList.toggle('negative', result.balance < 0);
  note.textContent = result.balance < 0 ? 'You are in debt. This is normal at Southbag.' : 'Fees apply to looking at this number.';
  for (const txn of result.transactions) {
    list.append(
      el('li', {}, el('span', { class: 'grow', text: txn.description || txn.kind }), el('strong', { text: money(txn.amount) })),
    );
  }
}

function renderStatus(status) {
  $('points').textContent = status.rewards.points.toLocaleString();
  const fees = status.fees;
  $('fees').textContent = !fees?.enabled
    ? 'Browsing fees are waived. Kevin has noticed.'
    : `${money(fees.perPageCents)} per page load. This session: ${money(fees.sessionCents)}. Lifetime: ${money(fees.lifetimeCents)} (${fees.pageLoads.toLocaleString()} pages).` +
      (fees.lastError ? ' The bank is unreachable, so we are keeping count for later.' : '');
  const promo = status.promo;
  $('promo').hidden = !promo;
  if (promo) {
    $('promoText').textContent = promo.text;
    $('promoLink').textContent = `${promo.cta} →`;
    $('promoLink').href = promo.url;
  }
}

async function main() {
  const info = await initPage('newtab');
  $('incognito').hidden = !info.isPrivate;
  $('greeting').textContent = greeting(info.user?.name);

  const settings = await call('settings:get');
  const engines = await call('engines');
  const engineName = (s) => (s.searchEngine === 'custom' ? 'a custom search engine' : engines[s.searchEngine]?.name || 'DuckDuckGo');
  $('engineName').textContent = engineName(settings);
  sb.on('settings', (s) => {
    $('engineName').textContent = engineName(s);
  });

  $('searchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const query = $('searchInput').value.trim();
    if (query) call('search', query);
  });
  $('unlucky').addEventListener('click', () => {
    location.href = 'https://branch-locator.southbag.cc/';
  });

  const { southbag } = await call('bookmarks:list');
  for (const app of southbag) {
    $('apps').append(
      el('a', { class: 'app-tile', href: app.url }, el('img', { src: 'logo.png', alt: '' }), el('strong', { text: app.title }), el('small', { text: APP_BLURBS[app.title] || '' })),
    );
  }

  $('redeem').addEventListener('click', async () => {
    const result = await call('rewards:redeem');
    $('redeemResult').hidden = false;
    $('redeemResult').textContent =
      result.redemptions === 1
        ? `You redeemed ${result.points.toLocaleString()} points for nothing. Congratulations. You keep the points.`
        : `Redeemed for nothing again (${result.redemptions} times now). Kevin is concerned.`;
  });
  $('promoDismiss').addEventListener('click', () => call('promo:dismiss'));

  renderStatus(await call('status'));
  sb.on('status', renderStatus);
  loadAccount();
}

main();
