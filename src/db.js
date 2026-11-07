import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';

// Access codes are always exactly 6 digits.
const CODE_LENGTH = 6;
export const CODE_PATTERN = /^\d{6}$/;

// The one admin account, created on every start with a fixed login code from the environment.
const ADMIN_NAME = process.env.ADMIN_NAME?.trim() || 'Admin';
const ADMIN_CODE = process.env.ADMIN_CODE?.trim() ?? '';
if (!CODE_PATTERN.test(ADMIN_CODE)) {
  throw new Error('ADMIN_CODE must be set to exactly 6 digits (see .env.example).');
}

const dbPath = process.env.DB_PATH ?? 'data/halloween.db';
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    guid        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    access_code TEXT NOT NULL UNIQUE,
    vote        TEXT REFERENCES users(guid) ON DELETE SET NULL,
    copied_at   TEXT,
    is_admin    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Bring databases from older versions up to the current columns.
const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
if (!columns.has('is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
// Invites used to go out by SMS; now the admin copies them by hand.
if (columns.has('sms_sent_at')) db.exec('ALTER TABLE users RENAME COLUMN sms_sent_at TO copied_at');
if (columns.has('phone')) db.exec('ALTER TABLE users DROP COLUMN phone');
// Voting state used to live in allow_vote on every user (a single 0 meant closed).
// Now it is one setting the admin controls; an old open database starts as "not started".
if (columns.has('allow_vote')) {
  const closed = db.prepare('SELECT 1 FROM users WHERE allow_vote = 0 LIMIT 1').get();
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('voting', closed ? 'closed' : 'pending');
  db.exec('ALTER TABLE users DROP COLUMN allow_vote');
}

function newAccessCode() {
  const taken = db.prepare('SELECT 1 FROM users WHERE access_code = ?');
  for (;;) {
    const code = String(randomInt(10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    if (code !== ADMIN_CODE && !taken.get(code)) return code;
  }
}

// Creates or repairs the admin so the fixed code always works.
export function ensureAdmin() {
  const holder = db.prepare('SELECT * FROM users WHERE access_code = ?').get(ADMIN_CODE);
  const admin = db.prepare('SELECT * FROM users WHERE is_admin = 1').get()
    ?? db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(ADMIN_NAME);
  if (holder && holder.guid !== admin?.guid) renewAccessCode(holder.guid);
  if (admin) {
    db.prepare('UPDATE users SET is_admin = 1, access_code = ?, copied_at = NULL WHERE guid = ?')
      .run(ADMIN_CODE, admin.guid);
    return;
  }
  const guid = randomUUID();
  db.prepare('INSERT INTO users (guid, name, access_code, is_admin) VALUES (?, ?, ?, 1)')
    .run(guid, ADMIN_NAME, ADMIN_CODE);
}

// Codes from before the digits-only rule would lock their guest out; give them a new one.
export function renewLegacyCodes() {
  const legacy = db.prepare("SELECT guid FROM users WHERE access_code NOT GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'").all();
  for (const { guid } of legacy) renewAccessCode(guid);
}

export function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all();
}

export function listCandidates(voterGuid) {
  return db
    .prepare('SELECT guid, name FROM users WHERE guid <> ? ORDER BY name COLLATE NOCASE')
    .all(voterGuid);
}

export function findUserByGuid(guid) {
  return db.prepare('SELECT * FROM users WHERE guid = ?').get(guid);
}

export function findUserByCode(code) {
  return db.prepare('SELECT * FROM users WHERE access_code = ?').get(code);
}

export function nameExists(name) {
  return Boolean(db.prepare('SELECT 1 FROM users WHERE name = ? COLLATE NOCASE').get(name));
}

// pending: guests can log in but not vote yet. open: voting. closed: nobody votes, results are shown.
export function getVotingState() {
  return db.prepare("SELECT value FROM settings WHERE key = 'voting'").get()?.value ?? 'pending';
}

export function setVotingState(state) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('voting', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(state);
}

export function createUser(name) {
  const guid = randomUUID();
  db.prepare('INSERT INTO users (guid, name, access_code) VALUES (?, ?, ?)')
    .run(guid, name, newAccessCode());
  return findUserByGuid(guid);
}

export function deleteUser(guid) {
  return db.prepare('DELETE FROM users WHERE guid = ? AND is_admin = 0').run(guid).changes > 0;
}

export function setVote(voterGuid, targetGuid) {
  db.prepare('UPDATE users SET vote = ? WHERE guid = ?').run(targetGuid, voterGuid);
}

// A new code invalidates the old one, so the invite has to go out again.
export function renewAccessCode(guid) {
  db.prepare('UPDATE users SET access_code = ?, copied_at = NULL WHERE guid = ?').run(newAccessCode(), guid);
  return findUserByGuid(guid);
}

export function markCopied(guid) {
  const copiedAt = new Date().toISOString();
  db.prepare('UPDATE users SET copied_at = ? WHERE guid = ?').run(copiedAt, guid);
  return copiedAt;
}

// Every user with their vote count, most votes first. Everyone who shares the highest count
// (and has at least one vote) is a winner, so a tie shows several winners.
export function getResults() {
  const rows = db.prepare(`
    SELECT u.name, COUNT(v.guid) AS votes
    FROM users u LEFT JOIN users v ON v.vote = u.guid
    GROUP BY u.guid
    ORDER BY votes DESC, u.name COLLATE NOCASE
  `).all();
  const top = rows[0]?.votes ?? 0;
  return rows.map((r) => ({ name: r.name, votes: r.votes, winner: top > 0 && r.votes === top }));
}
