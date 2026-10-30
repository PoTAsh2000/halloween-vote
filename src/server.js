import express from 'express';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';

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

// The text the admin copies and sends to a guest by hand. The link prefills the code on the login page.
function inviteText(user) {
  const link = `${PUBLIC_URL}/?code=${user.access_code}`;
  return [
    `Hoi ${user.name}! 🎃 Stem vanavond op de beste Halloween-outfit.`,
    `1. Open ${link}`,
    `2. Je code staat al ingevuld (anders typ je ${user.access_code}), tik op Inloggen.`,
    '3. Kies je favoriete outfit. Op jezelf stemmen kan niet, wisselen mag zolang de stemming open is.',
    `Je toegangscode: ${user.access_code}`,
  ].join('\n');
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
    users: db.listUsers().map((u) => ({
      guid: u.guid,
      name: u.name,
      access_code: u.access_code,
      has_voted: u.vote !== null,
      is_admin: Boolean(u.is_admin),
      copied_at: u.copied_at,
      invite: inviteText(u),
    })),
  });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > 40) return res.status(400).json({ error: 'Vul een naam in (max 40 tekens).' });
  if (db.nameExists(name)) {
    return res.status(409).json({ error: `${name} staat al op de lijst. Maak de naam uniek, bv. "${name} B."` });
  }
  res.status(201).json(db.createUser(name));
});

app.delete('/api/admin/users/:guid', requireAdmin, (req, res) => {
  if (!db.deleteUser(req.params.guid)) return res.status(404).json({ error: 'Gast niet gevonden.' });
  res.status(204).end();
});

// The admin marks an invite as copied, so the list shows who still needs one. Copying again just updates the time.
app.post('/api/admin/users/:guid/copied', requireAdmin, requireOpenVoting, (req, res) => {
  const target = db.findUserByGuid(req.params.guid);
  if (!target) return res.status(404).json({ error: 'Gast niet gevonden.' });
  res.json({ copied_at: db.markCopied(target.guid) });
});

// A new code makes the old invite useless, so the admin has to copy and send a fresh one.
app.post('/api/admin/users/:guid/renew-code', requireAdmin, requireOpenVoting, (req, res) => {
  const target = db.findUserByGuid(req.params.guid);
  if (!target) return res.status(404).json({ error: 'Gast niet gevonden.' });
  if (target.is_admin) return res.status(400).json({ error: 'De code van de admin staat vast.' });
  const user = db.renewAccessCode(target.guid);
  res.json({ name: user.name, access_code: user.access_code });
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
});
