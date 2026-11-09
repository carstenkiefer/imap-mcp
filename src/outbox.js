// Local queue of outgoing messages that still await human approval.
// Files are only readable by the current user. Nothing in here is ever
// sent without a human confirming it (see approval.js / cli.js).

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const ID_RE = /^[a-f0-9]{16}$/;

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not fatal on exotic file systems */
  }
}

export function newId() {
  return randomBytes(8).toString('hex');
}

const encodeItem = (i) => ({ ...i, raw: i.raw.toString('base64'), sentCopy: i.sentCopy && i.sentCopy !== i.raw ? i.sentCopy.toString('base64') : null });
const decodeItem = (i) => {
  const raw = Buffer.from(i.raw, 'base64');
  return { ...i, raw, sentCopy: i.sentCopy ? Buffer.from(i.sentCopy, 'base64') : raw };
};

/** Store a prepared operation (exact bytes + review text) until a human decides. */
export function savePending(dir, prepared, ttlHours) {
  ensureDir(dir);
  const id = newId();
  const now = Date.now();
  const entry = {
    id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlHours * 3600_000).toISOString(),
    prepared: { ...prepared, items: prepared.items.map(encodeItem) },
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
  return { ...entry, prepared };
}

export function loadPending(dir, id) {
  if (!ID_RE.test(id)) throw new Error('Invalid id');
  let entry;
  try {
    entry = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
  } catch {
    throw new Error(`No pending message with id ${id}`);
  }
  if (Date.parse(entry.expiresAt) < Date.now()) {
    removePending(dir, id);
    throw new Error(`Pending message ${id} has expired and was discarded`);
  }
  if (!entry.prepared?.items) throw new Error(`Pending message ${id} has an unknown format`);
  entry.prepared.items = entry.prepared.items.map(decodeItem);
  return entry;
}

export function listPending(dir) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^[a-f0-9]{16}\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push(loadPending(dir, f.slice(0, 16)));
    } catch {
      /* expired or broken */
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function removePending(dir, id) {
  if (!ID_RE.test(id)) return;
  rmSync(join(dir, `${id}.json`), { force: true });
}
