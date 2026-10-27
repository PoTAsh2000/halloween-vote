import express from 'express';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { sendSms, smsDryRun } from './sms.js';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

db.renewLegacyCodes();
db.ensureAdmin();

const USER_COOKIE = 'hv_user';
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: PUBLIC_URL.startsWith('https://'),
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const MAX_FAILED_LOGINS = 20;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const failedLogins = new Map();

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function isLockedOut(key) {
  const entry = failedLogins.get(key);
  if (entry && entry.resetAt < Date.now()) failedLogins.delete(key);
  return (failedLogins.get(key)?.count ?? 0) >= MAX_FAILED_LOGINS;
}

function recordFailedLogin(key) {
  const entry = failedLogins.get(key) ?? { count: 0, resetAt: Date.now() + FAILED_LOGIN_WINDOW_MS };
  entry.count++;
  failedLogins.set(key, entry);
}

// Dutch numbers like 06-12345678 become +31612345678; the gateway wants E.164.
function normalizePhone(raw) {
  let phone = String(raw ?? '').replace(/[\s\-().]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  else if (phone.startsWith('0')) phone = `+31${phone.slice(1)}`;
  return /^\+\d{8,15}$/.test(phone) ? phone : null;
}

async function sendAccess(user) {
  const link = `${PUBLIC_URL}/?code=${user.access_code}`;
  await sendSms(user.phone, `Hoi ${user.name}! Stem op de beste Halloween-outfit: ${link} Je toegangscode: ${user.access_code}`);
  db.markSmsSent(user.guid);
}

const app = express();
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.get('/admin', (req, res) => res.sendFile('admin.html', { root: PUBLIC_DIR }));

// ---- Guests ----

function requireUser(req, res, next) {
  const user = db.findUserByCode(readCookie(req, USER_COOKIE));
  if (!user) return res.status(401).json({ error: 'Niet ingelogd.' });
  if (!user.allow_vote) return res.status(403).json({ error: 'De stemming is gesloten.' });
  req.user = user;
  next();
}

// Looks the code up and counts a miss against the caller's IP. Sends the error itself and returns null on failure.
function loginWithCode(req, res) {
  const limitKey = `login:${req.ip}`;
  if (isLockedOut(limitKey)) {
    res.status(429).json({ error: 'Te veel foute pogingen. Probeer het over een kwartier opnieuw.' });
    return null;
  }
  const code = String(req.body?.code ?? '').trim();
  const user = db.CODE_PATTERN.test(code) ? db.findUserByCode(code) : undefined;
  if (!user) {
    recordFailedLogin(limitKey);
    res.status(401).json({ error: 'Deze code klopt niet.' });
    return null;
  }
  return user;
}

app.post('/api/login', (req, res) => {
  const user = loginWithCode(req, res);
  if (!user) return;
  if (!user.allow_vote) return res.status(403).json({ error: 'De stemming is gesloten.' });
  res.cookie(USER_COOKIE, user.access_code, COOKIE_OPTIONS);
  res.json({ name: user.name });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(USER_COOKIE, COOKIE_OPTIONS);
  res.status(204).end();
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({ name: req.user.name, vote: req.user.vote, candidates: db.listCandidates(req.user.guid) });
});

app.put('/api/vote', requireUser, (req, res) => {
  const target = db.findUserByGuid(String(req.body?.guid ?? ''));
  if (!target || target.guid === req.user.guid) {
    return res.status(400).json({ error: 'Op deze persoon kun je niet stemmen.' });
  }
  db.setVote(req.user.guid, target.guid);
  res.json({ vote: target.guid });
});

// ---- Admin ----

// The admin is the one user with is_admin set. Unlike guests, the admin keeps access after voting closes.
function requireAdmin(req, res, next) {
  const user = db.findUserByCode(readCookie(req, USER_COOKIE));
  if (!user?.is_admin) return res.status(401).json({ error: 'Niet ingelogd als admin.' });
  next();
}

function requireOpenVoting(req, res, next) {
  if (db.isVotingClosed()) return res.status(409).json({ error: 'De stemming is gesloten.' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const user = loginWithCode(req, res);
  if (!user) return;
  if (!user.is_admin) return res.status(403).json({ error: 'Deze code heeft geen adminrechten.' });
  res.cookie(USER_COOKIE, user.access_code, COOKIE_OPTIONS);
  res.status(204).end();
});

// Admin sees whether someone voted, never on whom.
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({
    closed: db.isVotingClosed(),
    smsDryRun,
    users: db.listUsers().map((u) => ({
      guid: u.guid,
      name: u.name,
      phone: u.phone,
      access_code: u.access_code,
      has_voted: u.vote !== null,
      is_admin: Boolean(u.is_admin),
      sms_sent_at: u.sms_sent_at,
    })),
  });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const phone = normalizePhone(req.body?.phone);
  if (!name || name.length > 40) return res.status(400).json({ error: 'Vul een naam in (max 40 tekens).' });
  if (!phone) return res.status(400).json({ error: 'Ongeldig telefoonnummer. Gebruik 06... of +31...' });
  if (db.nameExists(name)) {
    return res.status(409).json({ error: `${name} staat al op de lijst. Maak de naam uniek, bv. "${name} B."` });
  }
  res.status(201).json(db.createUser(name, phone));
});

app.delete('/api/admin/users/:guid', requireAdmin, (req, res) => {
  if (!db.deleteUser(req.params.guid)) return res.status(404).json({ error: 'Gast niet gevonden.' });
  res.status(204).end();
});

// New access code first; only when that succeeds the SMS goes out again.
app.post('/api/admin/users/:guid/resend', requireAdmin, requireOpenVoting, async (req, res) => {
  const target = db.findUserByGuid(req.params.guid);
  if (!target) return res.status(404).json({ error: 'Gast niet gevonden.' });
  if (target.is_admin) return res.status(400).json({ error: 'De code van de admin staat vast.' });
  const user = db.renewAccessCode(req.params.guid);
  try {
    await sendAccess(user);
  } catch (err) {
    return res.status(502).json({ error: `Nieuwe code ${user.access_code} gemaakt, maar de SMS mislukte: ${err.message}` });
  }
  res.json({ name: user.name });
});

let sendingAccess = false;

// Sends to every guest without a sent SMS, so latecomers and failed sends are picked up on the next click.
app.post('/api/admin/send-access', requireAdmin, requireOpenVoting, async (req, res) => {
  if (sendingAccess) return res.status(409).json({ error: 'Er worden al berichten verstuurd.' });
  sendingAccess = true;
  let sent = 0;
  const failed = [];
  try {
    for (const { guid } of db.listUsers().filter((u) => !u.is_admin && !u.sms_sent_at)) {
      // Re-read: the guest may be deleted or have a new code while earlier SMS were sending.
      const user = db.findUserByGuid(guid);
      if (!user || user.is_admin || user.sms_sent_at) continue;
      try {
        await sendAccess(user);
        sent++;
      } catch (err) {
        failed.push({ name: user.name, error: err.message });
      }
    }
  } finally {
    sendingAccess = false;
  }
  res.json({ sent, failed });
});

app.post('/api/admin/close', requireAdmin, (req, res) => {
  db.closeVoting();
  res.status(204).end();
});

app.get('/api/admin/winner', requireAdmin, (req, res) => {
  if (!db.isVotingClosed()) return res.status(409).json({ error: 'Sluit eerst de stemming.' });
  res.json({ winners: db.getWinners() });
});

app.use((err, req, res, next) => {
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Er ging iets mis op de server.' : 'Ongeldig verzoek.' });
});

app.listen(PORT, () => {
  console.log(`Halloween vote running on port ${PORT}, links point to ${PUBLIC_URL}`);
  if (smsDryRun) console.log('SMS_GATEWAY_URL is not set: SMS messages are only logged, not sent.');
});
