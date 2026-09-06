const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { JsonStore } = require('./src/store');
const { makeMockCode } = require('./src/mock-events');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || './data/state.json';
const store = new JsonStore(DATA_FILE);
const clients = new Set();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'local-demo-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  if (req.session?.user) return next();
  return res.status(401).json({ error: 'UNAUTHENTICATED' });
}
function audit(state, title, text) {
  state.audit.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), title, text });
  state.audit = state.audit.slice(0, 100);
}
function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'telegram-session-vault-safe-demo', time: new Date().toISOString() }));
app.post('/api/login', (req, res) => {
  const expectedUser = process.env.ADMIN_USERNAME || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD || 'change-this-password';
  const { username, password } = req.body || {};
  if (username !== expectedUser || password !== expectedPass) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  req.session.user = { username };
  res.json({ ok: true, username });
});
app.post('/api/logout', auth, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ authenticated: !!req.session?.user, user: req.session?.user || null }));
app.get('/api/state', auth, (_req, res) => res.json(store.read()));

app.post('/api/accounts', auth, (req, res) => {
  const b = req.body || {};
  if (!b.consent) return res.status(400).json({ error: 'CONSENT_REQUIRED' });
  if (!b.name || !b.phone) return res.status(400).json({ error: 'NAME_AND_PHONE_REQUIRED' });
  const account = {
    id: crypto.randomUUID(),
    name: String(b.name).slice(0, 80),
    username: String(b.username || '').slice(0, 80),
    phone: String(b.phone).slice(0, 40),
    telegramId: String(b.telegramId || Math.floor(7000000000 + Math.random() * 999999999)),
    premium: !!b.premium,
    avatar: String(b.avatar || b.name.split(/\s+/).map(x => x[0]).join('').slice(0,2)).toUpperCase().slice(0,2),
    status: 'ACTIVE',
    country: String(b.country || 'IN').slice(0, 8),
    region: String(b.region || 'Mumbai').slice(0, 40),
    networkMode: 'Sticky Static Egress',
    egressLabel: `${String(b.country || 'IN').toUpperCase()}-${String(b.region || 'Mumbai').toUpperCase().replace(/\W+/g,'-')}-DEMO`,
    egressIp: `203.0.113.${20 + Math.floor(Math.random() * 150)}`,
    worker: `wrk-${String(b.country || 'IN').toLowerCase()}-${String(b.region || 'mumbai').toLowerCase().replace(/\W+/g,'-')}-${Math.floor(10+Math.random()*90)}`,
    createdAt: new Date().toISOString(),
    lastHealthCheck: new Date().toISOString(),
    consent: true
  };
  store.update(state => { state.accounts.push(account); audit(state, 'Session profile added', `Consent-based demo profile created for ${account.name}.`); return state; });
  broadcast('state', { reason: 'account-added' });
  res.status(201).json(account);
});

app.post('/api/accounts/:id/health', auth, (req, res) => {
  let found;
  store.update(state => {
    found = state.accounts.find(a => a.id === req.params.id);
    if (found) { found.lastHealthCheck = new Date().toISOString(); audit(state, 'Health check completed', `${found.name}: ${found.status}.`); }
    return state;
  });
  if (!found) return res.status(404).json({ error: 'NOT_FOUND' });
  broadcast('state', { reason: 'health-check' });
  res.json(found);
});

app.post('/api/accounts/:id/simulate-revoke', auth, (req, res) => {
  let found;
  store.update(state => {
    found = state.accounts.find(a => a.id === req.params.id);
    if (found) { found.status = 'REAUTH_REQUIRED'; found.lastHealthCheck = new Date().toISOString(); audit(state, 'Authorization invalidated (simulation)', `${found.name} moved to REAUTH_REQUIRED.`); }
    return state;
  });
  if (!found) return res.status(404).json({ error: 'NOT_FOUND' });
  broadcast('state', { reason: 'revoke-simulated' });
  res.json(found);
});

app.post('/api/accounts/:id/reauth', auth, (req, res) => {
  let found;
  store.update(state => {
    found = state.accounts.find(a => a.id === req.params.id);
    if (found) { found.status = 'ACTIVE'; found.lastHealthCheck = new Date().toISOString(); audit(state, 'Re-authentication completed (simulation)', `${found.name} restored after user-approved re-auth.`); }
    return state;
  });
  if (!found) return res.status(404).json({ error: 'NOT_FOUND' });
  broadcast('state', { reason: 'reauth' });
  res.json(found);
});

app.delete('/api/accounts/:id', auth, (req, res) => {
  let removed;
  store.update(state => {
    const i = state.accounts.findIndex(a => a.id === req.params.id);
    if (i >= 0) removed = state.accounts.splice(i, 1)[0];
    if (removed) { state.codes = state.codes.filter(c => c.accountId !== removed.id); audit(state, 'Session disconnected', `${removed.name} removed by the console user.`); }
    return state;
  });
  if (!removed) return res.status(404).json({ error: 'NOT_FOUND' });
  broadcast('state', { reason: 'account-deleted' });
  res.json({ ok: true });
});

app.post('/api/mock-code', auth, (req, res) => {
  const state = store.read();
  const active = state.accounts.filter(a => a.status === 'ACTIVE');
  if (!active.length) return res.status(400).json({ error: 'NO_ACTIVE_ACCOUNT' });
  const target = req.body?.accountId ? active.find(a => a.id === req.body.accountId) : active[Math.floor(Math.random() * active.length)];
  if (!target) return res.status(404).json({ error: 'ACCOUNT_NOT_ACTIVE' });
  const code = makeMockCode(target);
  store.update(s => { s.codes.unshift(code); s.codes = s.codes.slice(0, 50); audit(s, 'Mock login-code event', `Simulated private code event mapped to ${target.name}.`); return s; });
  broadcast('code', code);
  res.status(201).json(code);
});
app.delete('/api/codes', auth, (_req, res) => { store.update(s => { s.codes = []; audit(s, 'Mock code inbox cleared', 'All simulated code events removed.'); return s; }); broadcast('state', { reason: 'codes-cleared' }); res.json({ ok: true }); });

app.get('/api/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`event: ready\ndata: {"ok":true}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

const auto = String(process.env.AUTO_MOCK_EVENTS || '').toLowerCase() === 'true';
if (auto) {
  const interval = Math.max(10000, Number(process.env.AUTO_MOCK_EVENT_INTERVAL_MS || 30000));
  setInterval(() => {
    const state = store.read();
    const active = state.accounts.filter(a => a.status === 'ACTIVE');
    if (!active.length) return;
    const target = active[Math.floor(Math.random() * active.length)];
    const code = makeMockCode(target);
    store.update(s => { s.codes.unshift(code); s.codes = s.codes.slice(0, 50); audit(s, 'Automatic mock login-code event', `Simulated event mapped to ${target.name}.`); return s; });
    broadcast('code', code);
  }, interval).unref();
}

app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Session Vault demo listening on :${PORT}`));

