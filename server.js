const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { JsonStore } = require('./src/store');
const { makeMockCode } = require('./src/mock-events');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || './data/state.json';
const store = new JsonStore(DATA_FILE);
const clients = new Set();
const telegramClients = new Map();
const pendingAuth = new Map();

const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = String(process.env.TELEGRAM_API_HASH || '');
const ENC_SECRET = String(process.env.SESSION_ENCRYPTION_KEY || '');

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'local-demo-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  if (req.session?.user) return next();
  return res.status(401).json({ error: 'UNAUTHENTICATED' });
}

function audit(state, title, text) {
  state.audit.unshift({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    title,
    text
  });
  state.audit = state.audit.slice(0, 100);
}

function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}

function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function safeError(err) {
  const text = String(err?.errorMessage || err?.message || err || 'UNKNOWN_ERROR');
  return text.replace(/\b\d{4,10}\b/g, '[redacted]').slice(0, 240);
}

function telegramConfigured() {
  return Number.isInteger(API_ID) && API_ID > 0 && API_HASH.length >= 8 && ENC_SECRET.length >= 32;
}

function encryptionKey() {
  return crypto.createHash('sha256').update(ENC_SECRET).digest();
}

function encryptSession(plain) {
  if (!telegramConfigured()) throw new Error('TELEGRAM_CONFIG_REQUIRED');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map(x => x.toString('base64url')).join('.');
}

function decryptSession(blob) {
  if (!telegramConfigured()) throw new Error('TELEGRAM_CONFIG_REQUIRED');
  const [ivB64, tagB64, dataB64] = String(blob || '').split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('INVALID_ENCRYPTED_SESSION');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivB64, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final()
  ]);
  return plain.toString('utf8');
}

function publicState() {
  const state = store.read();
  return {
    ...state,
    accounts: state.accounts.map(({ telegramSession, ...rest }) => rest)
  };
}

function makeTelegramClient(sessionString = '') {
  if (!telegramConfigured()) throw new Error('TELEGRAM_CONFIG_REQUIRED');
  return new TelegramClient(
    new StringSession(sessionString),
    API_ID,
    API_HASH,
    { connectionRetries: 5 }
  );
}

async function waitForInput(flow, stage) {
  if (flow.cancelled) throw new Error('AUTH_CANCELLED');
  flow.stage = stage;
  flow.updatedAt = new Date().toISOString();

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (flow.waiting?.reject === reject) flow.waiting = null;
      reject(new Error('AUTH_INPUT_TIMEOUT'));
    }, 10 * 60 * 1000);
    timer.unref?.();

    flow.waiting = {
      stage,
      resolve: (value) => {
        clearTimeout(timer);
        flow.waiting = null;
        flow.stage = 'PROCESSING';
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        flow.waiting = null;
        reject(err);
      }
    };
  });
}

function getFlow(id) {
  const flow = pendingAuth.get(id);
  if (!flow) return null;
  if (Date.now() - flow.createdMs > 15 * 60 * 1000) {
    try { flow.client?.disconnect(); } catch {}
    pendingAuth.delete(id);
    return null;
  }
  return flow;
}

function authStatus(flow) {
  return {
    authId: flow.id,
    stage: flow.stage,
    error: flow.error || null,
    accountId: flow.accountId || null,
    updatedAt: flow.updatedAt
  };
}

async function restoreTelegramClient(account) {
  if (!account?.telegramSession) return null;
  const existing = telegramClients.get(account.id);
  if (existing) return existing;

  const sessionString = decryptSession(account.telegramSession);
  const client = makeTelegramClient(sessionString);
  await client.connect();
  const ok = await client.checkAuthorization();
  if (!ok) {
    await client.disconnect().catch(() => {});
    return null;
  }
  telegramClients.set(account.id, client);
  return client;
}

async function setAccountHealth(accountId) {
  let account = store.read().accounts.find(a => a.id === accountId);
  if (!account) return null;

  let status = account.status;
  if (account.authMode === 'REAL_TELEGRAM') {
    try {
      const client = await restoreTelegramClient(account);
      status = client && await client.checkAuthorization() ? 'ACTIVE' : 'REAUTH_REQUIRED';
    } catch {
      status = 'REAUTH_REQUIRED';
    }
  }

  store.update(state => {
    const found = state.accounts.find(a => a.id === accountId);
    if (found) {
      found.status = status;
      found.lastHealthCheck = new Date().toISOString();
      audit(state, 'Health check completed', `${found.name}: ${found.status}.`);
    }
    return state;
  });

  return store.read().accounts.find(a => a.id === accountId);
}

app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'telegram-session-vault',
  telegramConfigured: telegramConfigured(),
  time: new Date().toISOString()
}));

app.post('/api/login', (req, res) => {
  const expectedUser = process.env.ADMIN_USERNAME || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD || 'change-this-password';
  const { username, password } = req.body || {};
  if (username !== expectedUser || password !== expectedPass) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }
  req.session.user = { username };
  res.json({ ok: true, username });
});

app.post('/api/logout', auth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => res.json({
  authenticated: !!req.session?.user,
  user: req.session?.user || null
}));

app.get('/api/state', auth, (_req, res) => res.json(publicState()));

app.get('/api/config', auth, (_req, res) => res.json({
  telegramConfigured: telegramConfigured(),
  realTelegramAuth: true
}));

// Real Telegram authorization: code and 2FA are entered by the account owner.
// They are never stored in state, audit logs, or returned by the API.
app.post('/api/telegram/auth/start', auth, async (req, res) => {
  try {
    if (!telegramConfigured()) {
      return res.status(503).json({ error: 'TELEGRAM_CONFIG_REQUIRED' });
    }

    const b = req.body || {};
    if (!b.consent) return res.status(400).json({ error: 'CONSENT_REQUIRED' });

    const phone = String(b.phone || '').trim();
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      return res.status(400).json({ error: 'PHONE_E164_REQUIRED' });
    }

    const id = crypto.randomUUID();
    const client = makeTelegramClient('');
    const flow = {
      id,
      client,
      phone,
      name: String(b.name || '').trim().slice(0, 80),
      country: String(b.country || 'IN').slice(0, 8),
      region: String(b.region || 'Mumbai').slice(0, 40),
      stage: 'STARTING',
      error: null,
      accountId: null,
      createdMs: Date.now(),
      updatedAt: new Date().toISOString(),
      waiting: null,
      cancelled: false
    };
    pendingAuth.set(id, flow);

    (async () => {
      try {
        flow.stage = 'CONNECTING';
        flow.updatedAt = new Date().toISOString();

        await withTimeout(client.start({
          phoneNumber: async () => {
            flow.stage = 'REQUESTING_CODE';
            flow.updatedAt = new Date().toISOString();
            return phone;
          },
          phoneCode: async () => {
            flow.error = null;
            return await waitForInput(flow, 'CODE_REQUIRED');
          },
          password: async () => {
            flow.error = null;
            return await waitForInput(flow, 'PASSWORD_REQUIRED');
          },
          onError: (err) => {
            flow.error = safeError(err);
            flow.updatedAt = new Date().toISOString();
          }
        }), 45000, 'TELEGRAM_CONNECT_TIMEOUT');

        if (!await client.checkAuthorization()) {
          throw new Error('TELEGRAM_AUTH_NOT_AUTHORIZED');
        }

        const me = await client.getMe();
        const telegramId = String(me?.id ?? '');
        const username = me?.username ? `@${me.username}` : '';
        const displayName = flow.name ||
          [me?.firstName, me?.lastName].filter(Boolean).join(' ') ||
          username ||
          flow.phone;
        const avatar = displayName.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase() || 'TG';
        const encrypted = encryptSession(client.session.save());
        let accountId;

        store.update(state => {
          let account = state.accounts.find(a =>
            a.authMode === 'REAL_TELEGRAM' &&
            (String(a.telegramId || '') === telegramId || a.phone === flow.phone)
          );

          if (!account) {
            account = { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
            state.accounts.push(account);
          }

          Object.assign(account, {
            name: displayName,
            username,
            phone: flow.phone,
            telegramId,
            premium: !!me?.premium,
            avatar,
            status: 'ACTIVE',
            country: flow.country,
            region: flow.region,
            networkMode: 'Railway Egress',
            egressLabel: 'RAILWAY-RUNTIME',
            egressIp: 'managed-by-host',
            worker: 'web',
            lastHealthCheck: new Date().toISOString(),
            lastAuthorizedAt: new Date().toISOString(),
            consent: true,
            authMode: 'REAL_TELEGRAM',
            telegramSession: encrypted
          });

          accountId = account.id;
          audit(state, 'Telegram account authorized', `${account.name} connected with explicit user consent.`);
          return state;
        });

        telegramClients.set(accountId, client);
        flow.stage = 'AUTHORIZED';
        flow.accountId = accountId;
        flow.error = null;
        flow.updatedAt = new Date().toISOString();
        broadcast('state', { reason: 'telegram-authorized' });
      } catch (err) {
        flow.stage = flow.cancelled ? 'CANCELLED' : 'ERROR';
        flow.error = safeError(err);
        flow.updatedAt = new Date().toISOString();
        console.error('[telegram-auth]', flow.error);
        try { await client.disconnect(); } catch {}
      }
    })();

    res.status(202).json(authStatus(flow));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

app.get('/api/telegram/auth/:id/status', auth, (req, res) => {
  const flow = getFlow(req.params.id);
  if (!flow) return res.status(404).json({ error: 'AUTH_FLOW_NOT_FOUND' });
  res.json(authStatus(flow));
});

app.post('/api/telegram/auth/:id/code', auth, (req, res) => {
  const flow = getFlow(req.params.id);
  if (!flow) return res.status(404).json({ error: 'AUTH_FLOW_NOT_FOUND' });
  if (flow.stage !== 'CODE_REQUIRED' || flow.waiting?.stage !== 'CODE_REQUIRED') {
    return res.status(409).json({ error: 'CODE_NOT_REQUESTED' });
  }

  const code = String(req.body?.code || '').trim();
  if (!/^\d{3,10}$/.test(code)) {
    return res.status(400).json({ error: 'INVALID_CODE_FORMAT' });
  }

  flow.waiting.resolve(code);
  res.json({ ok: true, stage: flow.stage });
});

app.post('/api/telegram/auth/:id/password', auth, (req, res) => {
  const flow = getFlow(req.params.id);
  if (!flow) return res.status(404).json({ error: 'AUTH_FLOW_NOT_FOUND' });
  if (flow.stage !== 'PASSWORD_REQUIRED' || flow.waiting?.stage !== 'PASSWORD_REQUIRED') {
    return res.status(409).json({ error: 'PASSWORD_NOT_REQUESTED' });
  }

  const password = String(req.body?.password || '');
  if (!password || password.length > 256) {
    return res.status(400).json({ error: 'INVALID_2FA_PASSWORD' });
  }

  flow.waiting.resolve(password);
  res.json({ ok: true, stage: flow.stage });
});

app.post('/api/telegram/auth/:id/cancel', auth, async (req, res) => {
  const flow = getFlow(req.params.id);
  if (!flow) return res.status(404).json({ error: 'AUTH_FLOW_NOT_FOUND' });

  flow.cancelled = true;
  flow.stage = 'CANCELLED';
  flow.error = null;
  flow.waiting?.reject?.(new Error('AUTH_CANCELLED'));
  try { await flow.client.disconnect(); } catch {}
  res.json({ ok: true });
});

// Legacy demo profile route kept for existing test data / compatibility.
app.post('/api/accounts', auth, (req, res) => {
  const b = req.body || {};
  if (!b.consent) return res.status(400).json({ error: 'CONSENT_REQUIRED' });
  if (!b.name || !b.phone) return res.status(400).json({ error: 'NAME_AND_PHONE_REQUIRED' });

  const account = {
    id: crypto.randomUUID(),
    name: String(b.name).slice(0, 80),
    username: String(b.username || '').slice(0, 80),
    phone: String(b.phone).slice(0, 40),
    telegramId: String(b.telegramId || ''),
    premium: !!b.premium,
    avatar: String(b.avatar || b.name.split(/\s+/).map(x => x[0]).join('').slice(0, 2)).toUpperCase().slice(0, 2),
    status: 'DEMO',
    country: String(b.country || 'IN').slice(0, 8),
    region: String(b.region || 'Mumbai').slice(0, 40),
    networkMode: 'Demo',
    egressLabel: 'DEMO',
    egressIp: '203.0.113.1',
    worker: 'demo',
    createdAt: new Date().toISOString(),
    lastHealthCheck: new Date().toISOString(),
    consent: true,
    authMode: 'DEMO'
  };

  store.update(state => {
    state.accounts.push(account);
    audit(state, 'Demo profile added', `Demo profile created for ${account.name}.`);
    return state;
  });

  broadcast('state', { reason: 'account-added' });
  res.status(201).json(account);
});

app.post('/api/accounts/:id/health', auth, async (req, res) => {
  const found = await setAccountHealth(req.params.id);
  if (!found) return res.status(404).json({ error: 'NOT_FOUND' });
  broadcast('state', { reason: 'health-check' });
  const { telegramSession, ...publicAccount } = found;
  res.json(publicAccount);
});

app.post('/api/accounts/:id/simulate-revoke', auth, (req, res) => {
  let found;
  store.update(state => {
    found = state.accounts.find(a => a.id === req.params.id);
    if (found) {
      found.status = 'REAUTH_REQUIRED';
      found.lastHealthCheck = new Date().toISOString();
      audit(state, 'Authorization invalidated (simulation)', `${found.name} moved to REAUTH_REQUIRED.`);
    }
    return state;
  });
  if (!found) return res.status(404).json({ error: 'NOT_FOUND' });
  broadcast('state', { reason: 'revoke-simulated' });
  const { telegramSession, ...publicAccount } = found;
  res.json(publicAccount);
});

app.delete('/api/accounts/:id', auth, async (req, res) => {
  const client = telegramClients.get(req.params.id);
  if (client) {
    try { await client.disconnect(); } catch {}
    telegramClients.delete(req.params.id);
  }

  let removed;
  store.update(state => {
    const i = state.accounts.findIndex(a => a.id === req.params.id);
    if (i >= 0) removed = state.accounts.splice(i, 1)[0];
    if (removed) {
      state.codes = state.codes.filter(c => c.accountId !== removed.id);
      audit(state, 'Session disconnected', `${removed.name} removed by the console user.`);
    }
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
  const target = req.body?.accountId
    ? active.find(a => a.id === req.body.accountId)
    : active[Math.floor(Math.random() * active.length)];
  if (!target) return res.status(404).json({ error: 'ACCOUNT_NOT_ACTIVE' });

  const code = makeMockCode(target);
  store.update(s => {
    s.codes.unshift(code);
    s.codes = s.codes.slice(0, 50);
    audit(s, 'Mock login-code event', `Simulated event mapped to ${target.name}.`);
    return s;
  });
  broadcast('code', code);
  res.status(201).json(code);
});

app.delete('/api/codes', auth, (_req, res) => {
  store.update(s => {
    s.codes = [];
    audit(s, 'Mock code inbox cleared', 'All simulated code events removed.');
    return s;
  });
  broadcast('state', { reason: 'codes-cleared' });
  res.json({ ok: true });
});

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
    store.update(s => {
      s.codes.unshift(code);
      s.codes = s.codes.slice(0, 50);
      audit(s, 'Automatic mock login-code event', `Simulated event mapped to ${target.name}.`);
      return s;
    });
    broadcast('code', code);
  }, interval).unref();
}

app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Session Vault listening on :${PORT}`);

  // Best-effort reconnect of encrypted, previously authorized sessions.
  if (telegramConfigured()) {
    const accounts = store.read().accounts.filter(a =>
      a.authMode === 'REAL_TELEGRAM' && a.telegramSession
    );

    for (const account of accounts) {
      restoreTelegramClient(account)
        .then(client => {
          if (!client) {
            store.update(state => {
              const found = state.accounts.find(a => a.id === account.id);
              if (found) found.status = 'REAUTH_REQUIRED';
              return state;
            });
          }
        })
        .catch(() => {
          store.update(state => {
            const found = state.accounts.find(a => a.id === account.id);
            if (found) found.status = 'REAUTH_REQUIRED';
            return state;
          });
        });
    }
  }
});