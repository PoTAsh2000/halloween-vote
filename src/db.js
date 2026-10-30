import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';

// Access codes are always exactly 6 digits.
const CODE_LENGTH = 6;
export const CODE_PATTERN = /^\d{6}$/;

// The one admin account, created on every start with a fixed login code.
const ADMIN_NAME = 'Admin';
const ADMIN_CODE = '123456';

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
    allow_vote  INTEGER NOT NULL DEFAULT 1,
    copied_at   TEXT,
    is_admin    INTEGER NOT NULL DEFAULT 0
  );
`);

// Bring databases from older versions up to the current columns.
const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
if (!columns.has('is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
// Invites used to go out by SMS; now the admin copies them by hand.
if (columns.has('sms_sent_at')) db.exec('ALTER TABLE users RENAME COLUMN sms_sent_at TO copied_at');
if (columns.has('phone')) db.exec('ALTER TABLE users DROP COLUMN phone');

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
  db.prepare('INSERT INTO users (guid, name, access_code, allow_vote, is_admin) VALUES (?, ?, ?, ?, 1)')
    .run(guid, ADMIN_NAME, ADMIN_CODE, isVotingClosed() ? 0 : 1);
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

// Closing sets allow_vote to 0 for everyone, so a single 0 means voting is closed.
export function isVotingClosed() {
  return Boolean(db.prepare('SELECT 1 FROM users WHERE allow_vote = 0 LIMIT 1').get());
}

export function createUser(name) {
  const guid = randomUUID();
  db.prepare('INSERT INTO users (guid, name, access_code, allow_vote) VALUES (?, ?, ?, ?)')
    .run(guid, name, newAccessCode(), isVotingClosed() ? 0 : 1);
  return findUserByGuid(guid);
}

export function deleteUser(guid) {
  return db.prepare('DELETE FROM users WHERE guid = ? AND is_admin = 0').run(guid).changes > 0;
}

export function setVote(voterGuid, targetGuid) {
  return db
    .prepare('UPDATE users SET vote = ? WHERE guid = ? AND allow_vote = 1')
    .run(targetGuid, voterGuid).changes > 0;
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

export function closeVoting() {
  db.exec('UPDATE users SET allow_vote = 0');
}

// Everyone who shares the highest vote count wins.
export function getWinners() {
  return db.prepare(`
    WITH tally AS (
      SELECT vote AS guid, COUNT(*) AS votes FROM users WHERE vote IS NOT NULL GROUP BY vote
    )
    SELECT u.name, t.votes
    FROM tally t JOIN users u ON u.guid = t.guid
    WHERE t.votes = (SELECT MAX(votes) FROM tally)
    ORDER BY u.name COLLATE NOCASE
  `).all();
}
