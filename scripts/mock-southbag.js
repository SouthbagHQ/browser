// A stand-in for identity.southbag.cc and banking.southbag.cc, for development and UI testing
// without a real Southbag account. Run it, then start the browser pointed at it:
//
//   node scripts/mock-southbag.js            # listens on 127.0.0.1:47700
//   SOUTHBAG_IDENTITY_URL=http://127.0.0.1:47700 SOUTHBAG_BANKING_URL=http://127.0.0.1:47700 npm start
//
// Identity approves anyone who presses the button. Banking keeps one account in memory.
const crypto = require('node:crypto');
const http = require('node:http');

const PORT = Number(process.env.PORT || 47700);
const codes = new Map();
const tokens = new Set();
const refreshTokens = new Set();
const user = { sub: 'mock-user-1', email: 'kevin.tester@southbag.cc', name: 'Kevin Tester' };
const account = {
  balance: 1_000_000,
  transactions: [
    { id: 2, amount: -7, kind: 'fee', description: 'Balance awareness surcharge', created_at: Date.now() - 60_000 },
    { id: 1, amount: 1_000_000, kind: 'deposit', description: 'Opening balance', created_at: Date.now() - 86_400_000 },
  ],
};
const replies = [
  'Have you tried turning it off and on again? No? Classic.',
  'Kevin here. That sounds like a you problem. Visit a branch.',
  'Did you check your account balance first? Always check your balance.',
];

const random = () => crypto.randomBytes(24).toString('base64url');

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function authed(req) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  return token && tokens.has(token);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let body = '';
  for await (const chunk of req) body += chunk;
  console.log(req.method, url.pathname);

  switch (url.pathname) {
    case '/api/auth/oauth2/register':
      return json(res, 200, { client_id: `mock-client-${random().slice(0, 8)}` });
    case '/api/auth/oauth2/authorize': {
      if (req.method === 'POST') {
        const params = new URLSearchParams(body);
        const code = random();
        codes.set(code, params.get('code_challenge'));
        const back = new URL(params.get('redirect_uri'));
        back.searchParams.set('code', code);
        back.searchParams.set('state', params.get('state'));
        back.searchParams.set('iss', `http://127.0.0.1:${PORT}`);
        res.writeHead(302, { location: back.toString(), 'set-cookie': 'mock_identity_session=1; Path=/; HttpOnly' });
        return res.end();
      }
      const fields = ['redirect_uri', 'state', 'code_challenge']
        .map((name) => `<input type="hidden" name="${name}" value="${String(url.searchParams.get(name) || '').replace(/"/g, '&quot;')}">`)
        .join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html><head><title>Mock Southbag Identity</title>
<style>body{font-family:"Times New Roman",serif;padding:30px}h1{color:#0d6efd;text-shadow:2px 2px 4px rgba(0,0,0,.5)}
button{font-size:24px;padding:15px 30px;background:#0d6efd;color:#fff;border:none;border-radius:50px;box-shadow:0 10px 20px rgba(0,0,0,.3)}</style>
</head><body><h1>Mock Southbag Identity™</h1><p>Southbag Browser wants to access your Southbag account (${user.email}).</p>
<form method="post">${fields}<button id="approve" type="submit">Approve</button></form>
<p><small>This is the development mock in scripts/mock-southbag.js, not the real Identity.</small></p></body></html>`);
    }
    case '/api/auth/oauth2/token': {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'authorization_code') {
        const challenge = codes.get(params.get('code'));
        const expected = crypto.createHash('sha256').update(params.get('code_verifier') || '').digest('base64url');
        if (!challenge || challenge !== expected) return json(res, 400, { error: 'invalid_grant' });
        codes.delete(params.get('code'));
      } else if (params.get('grant_type') === 'refresh_token') {
        if (!refreshTokens.has(params.get('refresh_token'))) return json(res, 400, { error: 'invalid_grant' });
      } else return json(res, 400, { error: 'unsupported_grant_type' });
      const access = random();
      const refresh = random();
      tokens.add(access);
      refreshTokens.add(refresh);
      return json(res, 200, { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: 'Bearer' });
    }
    case '/api/auth/oauth2/userinfo':
      return authed(req) ? json(res, 200, user) : json(res, 401, {});
    case '/api/auth/oauth2/revoke':
      refreshTokens.delete(new URLSearchParams(body).get('token'));
      return json(res, 200, {});
    case '/api/auth/sign-out':
      return json(res, 200, { success: true });
    case '/api/account':
      if (!authed(req)) return json(res, 401, { error: 'Authentication required' });
      return json(res, 200, { user: { id: user.sub, ...user }, balance: account.balance, transactions: account.transactions.slice(0, 20) });
    case '/api/economy': {
      if (!authed(req)) return json(res, 401, { error: 'Authentication required' });
      const request = JSON.parse(body || '{}');
      if (request.action !== 'fee') return json(res, 200, { ok: false, error: 'unknown', text: 'Kevin has not approved this form.' });
      const cents = Math.max(1, Math.round(Number(request.amount || 0.01) * 100));
      account.balance -= cents;
      account.transactions.unshift({ id: Date.now(), amount: -cents, kind: 'fee', description: String(request.reason || 'Fee'), created_at: Date.now() });
      return json(res, 200, { ok: true, text: `Charged $${(cents / 100).toFixed(2)}.`, balance: account.balance });
    }
    case '/api/chat': {
      if (!authed(req)) return json(res, 401, { error: 'Authentication required' });
      const request = JSON.parse(body || '{}');
      const summary = request.messages?.some((m) => m.role === 'user' && m.content.startsWith('Summarise this page'));
      const content = summary
        ? 'This page has words on it. Several. None of them are Southbag. Read it yourself, or visit a branch.'
        : replies[Math.floor(Math.random() * replies.length)];
      return json(res, 200, { choices: [{ message: { role: 'assistant', content } }] });
    }
    default:
      return json(res, 404, { error: 'Not found' });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Mock Southbag Identity + Banking on http://127.0.0.1:${PORT}`));
