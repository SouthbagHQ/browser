'use strict';

const TOGGLES = ['adBlock', 'browsingFees', 'askDefaultBrowser', 'dark', 'showBookmarksBar', 'askDownloadLocation'];

function render(settings) {
  for (const key of TOGGLES) $(key).checked = Boolean(settings[key]);
  $('engine').value = settings.searchEngine;
  $('customRow').hidden = settings.searchEngine !== 'custom';
  if (document.activeElement !== $('custom')) $('custom').value = settings.customSearch || '';
}

function renderStatus(status) {
  $('points').textContent = status.rewards.points.toLocaleString();
  const fees = status.fees;
  if (fees) {
    $('feeSummary').textContent =
      `This session: ${money(fees.sessionCents)}. Lifetime: ${money(fees.lifetimeCents)} over ${fees.pageLoads.toLocaleString()} page loads. ` +
      `Charged to the bank: ${money(fees.chargedCents)}. Pending: ${money(fees.pendingCents)}.` +
      (fees.lastError ? ` Last attempt failed: ${fees.lastError}.` : '');
  }
}

async function main() {
  const info = await initPage('settings');
  $('account').textContent = info.user
    ? `Logged in as ${info.user.name || 'a Southbag customer'}${info.user.email ? ` (${info.user.email})` : ''}.`
    : 'Not logged in.';
  $('downloadsDir').textContent = info.downloadsDir;
  $('palantirNote').textContent += info.palantir
    ? ' It cannot be turned off here. (Developers: SOUTHBAG_PALANTIR_DISABLED=1.)'
    : ' It is currently disabled by SOUTHBAG_PALANTIR_DISABLED. Kevin is furious.';
  $('palantir').checked = info.palantir;
  const showDefault = (isDefault) => {
    $('defaultStatus').textContent = isDefault
      ? 'Southbag Browser is your default browser. Excellent.'
      : 'Southbag Browser is not your default browser. This has been noted.';
    $('makeDefault').disabled = isDefault;
  };
  showDefault(info.isDefault);

  const engines = await call('engines');
  for (const [id, engine] of Object.entries(engines)) $('engine').append(el('option', { value: id, text: engine.name }));
  $('engine').append(el('option', { value: 'custom', text: 'Custom…' }));

  render(await call('settings:get'));
  sb.on('settings', render);

  for (const key of TOGGLES) {
    $(key).addEventListener('change', () => call('settings:set', { [key]: $(key).checked }));
  }
  $('engine').addEventListener('change', () => call('settings:set', { searchEngine: $('engine').value }));
  $('saveCustom').addEventListener('click', async () => {
    const value = $('custom').value.trim();
    const next = await call('settings:set', { customSearch: value });
    $('custom').style.borderColor = next.customSearch === value ? '' : 'red';
  });
  $('makeDefault').addEventListener('click', async () => {
    const result = await call('default:set');
    showDefault(result.isDefault);
    if (!result.isDefault) $('defaultStatus').textContent = 'We asked your operating system. If it showed a prompt, please say yes.';
  });
  $('logout').addEventListener('click', () => call('logout'));

  const clear = (what, label) => async () => {
    await call('data:clear', what);
    $('clearResult').textContent = `${label} cleared. Kevin kept a copy.`;
  };
  $('clearHistory').addEventListener('click', clear({ history: true }, 'History'));
  $('clearCookies').addEventListener('click', clear({ cookies: true }, 'Cookies and site data'));
  $('clearCache').addEventListener('click', clear({ cache: true }, 'Cache'));

  $('redeem').addEventListener('click', async () => {
    const result = await call('rewards:redeem');
    $('redeemResult').textContent = `Redeemed ${result.points.toLocaleString()} points for nothing. You still have ${result.points.toLocaleString()} points.`;
  });

  renderStatus(await call('status'));
  sb.on('status', renderStatus);
}

main();
