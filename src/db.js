import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';

// No 0/O or 1/I, so a code read from an SMS cannot be misread.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const dbPath = process.env.DB_PATH ?? 'data/halloween.db';
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    guid        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    access_code TEXT NOT NULL UNIQUE,
    vote        TEXT REFERENCES users(guid) ON DELETE SET NULL,
    allow_vote  INTEGER NOT NULL DEFAULT 1,
    sms_sent_at TEXT
  );
`);

function newAccessCode() {
  const taken = db.prepare('SELECT 1 FROM users WHERE access_code = ?');
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!taken.get(code)) return code;
  }
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

export function createUser(name, phone) {
  const guid = randomUUID();
  db.prepare('INSERT INTO users (guid, name, phone, access_code, allow_vote) VALUES (?, ?, ?, ?, ?)')
    .run(guid, name, phone, newAccessCode(), isVotingClosed() ? 0 : 1);
  return findUserByGuid(guid);
}

export function deleteUser(guid) {
  return db.prepare('DELETE FROM users WHERE guid = ?').run(guid).changes > 0;
}

export function setVote(voterGuid, targetGuid) {
  return db
    .prepare('UPDATE users SET vote = ? WHERE guid = ? AND allow_vote = 1')
    .run(targetGuid, voterGuid).changes > 0;
}

// A new code invalidates the old one, so the SMS has to go out again.
export function renewAccessCode(guid) {
  db.prepare('UPDATE users SET access_code = ?, sms_sent_at = NULL WHERE guid = ?').run(newAccessCode(), guid);
  return findUserByGuid(guid);
}

export function markSmsSent(guid) {
  db.prepare('UPDATE users SET sms_sent_at = ? WHERE guid = ?').run(new Date().toISOString(), guid);
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
