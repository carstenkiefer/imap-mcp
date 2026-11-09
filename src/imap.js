// Thin, read-mostly IMAP layer on top of imapflow.
// A fresh connection is opened per operation: simple, robust, no stale state.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { resolveAuth } from './config.js';

function clientFor(account) {
  const { imap } = account;
  const secure = imap.secure !== false;
  return new ImapFlow({
    host: imap.host,
    port: imap.port || (secure ? 993 : 143),
    secure,
    doSTARTTLS: secure ? undefined : imap.allowInsecure ? undefined : true,
    auth: resolveAuth(imap.auth),
    tls: { rejectUnauthorized: imap.rejectUnauthorized !== false, minVersion: 'TLSv1.2' },
    logger: false, // IMPORTANT: imapflow logs to stdout by default, which would corrupt the MCP stdio stream
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
    disableAutoIdle: true,
    clientInfo: { name: 'imap-mcp' },
  });
}

export async function withImap(account, fn) {
  const client = clientFor(account);
  client.on('error', () => {}); // errors surface through the awaited calls
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`IMAP connection for account "${account.id}" failed: ${safeError(err)}`);
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

/** Never leak credentials or protocol dumps in error messages. */
export function safeError(err) {
  const msg = err?.responseText || err?.message || String(err);
  return msg.replace(/(pass(word)?|token|auth)[^\s]*\s*[:=]\s*\S+/gi, '$1=***').slice(0, 300);
}

export async function listFolders(account) {
  return withImap(account, async (client) => {
    const list = await client.list({ statusQuery: { messages: true, unseen: true } });
    return list.map((f) => ({
      path: f.path,
      specialUse: f.specialUse || null,
      messages: f.status?.messages ?? null,
      unseen: f.status?.unseen ?? null,
    }));
  });
}

function summarize(msg) {
  const env = msg.envelope || {};
  return {
    uid: msg.uid,
    date: (env.date || msg.internalDate)?.toISOString?.() ?? null,
    from: env.from || [],
    to: env.to || [],
    cc: env.cc || [],
    subject: env.subject || '',
    flags: [...(msg.flags || [])],
    size: msg.size ?? null,
    attachments: attachmentNames(msg.bodyStructure),
  };
}

/** File names of attachments according to BODYSTRUCTURE (no download needed). */
function attachmentNames(node, out = []) {
  if (!node) return out;
  const filename = node.dispositionParameters?.filename || node.parameters?.name;
  const isAttachment = node.disposition === 'attachment' || (filename && !/^text\/(plain|html)$/i.test(node.type || ''));
  if (isAttachment && !(node.childNodes || []).length) out.push(filename || '(unnamed)');
  for (const child of node.childNodes || []) attachmentNames(child, out);
  return out;
}

export const FORWARDED_FLAG = '$Forwarded';
const ATTACHMENT_SCAN_LIMIT = 500;
const SUMMARY_QUERY = { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true };

/** Newest messages first. */
export async function listMessages(account, { folder = 'INBOX', limit = 20, offset = 0, unseenOnly = false }) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      let uids;
      if (unseenOnly) {
        uids = (await client.search({ seen: false }, { uid: true })) || [];
      } else {
        uids = (await client.search({ all: true }, { uid: true })) || [];
      }
      const total = uids.length;
      uids.sort((a, b) => b - a);
      const page = uids.slice(offset, offset + limit);
      const messages = page.length ? await fetchSummaries(client, page) : [];
      return { folder, total, offset, messages };
    } finally {
      lock.release();
    }
  });
}

export async function searchMessages(account, { folder = 'INBOX', limit = 20, ...criteria }) {
  const query = {};
  if (criteria.from) query.from = criteria.from;
  if (criteria.to) query.to = criteria.to;
  if (criteria.subject) query.subject = criteria.subject;
  if (criteria.text) query.body = criteria.text;
  if (criteria.since) query.since = new Date(criteria.since);
  if (criteria.before) query.before = new Date(criteria.before);
  if (criteria.unseen === true) query.seen = false;
  if (criteria.flagged === true) query.flagged = true;
  if (criteria.excludeForwarded === true) query.unKeyword = FORWARDED_FLAG;
  if (!Object.keys(query).length) query.all = true;

  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const uids = ((await client.search(query, { uid: true })) || []).sort((a, b) => b - a);
      if (!criteria.hasAttachments) {
        const page = uids.slice(0, limit);
        const messages = page.length ? await fetchSummaries(client, page) : [];
        return { folder, total: uids.length, messages };
      }
      // IMAP SEARCH cannot filter by attachments: check BODYSTRUCTURE of the newest hits.
      const scanned = uids.slice(0, ATTACHMENT_SCAN_LIMIT);
      const withAtt = scanned.length ? (await fetchSummaries(client, scanned)).filter((m) => m.attachments.length) : [];
      return {
        folder,
        total: withAtt.length,
        messages: withAtt.slice(0, limit),
        note: uids.length > scanned.length ? `Only the newest ${scanned.length} of ${uids.length} matches were checked for attachments; narrow the search (e.g. with since/before).` : null,
      };
    } finally {
      lock.release();
    }
  });
}

async function fetchSummaries(client, uids) {
  const out = [];
  for await (const msg of client.fetch(uids.join(','), SUMMARY_QUERY, { uid: true })) out.push(summarize(msg));
  return out.sort((a, b) => b.uid - a.uid);
}

/** Fetch and parse one message without setting \Seen (folder opened read-only, BODY.PEEK). */
export async function getMessage(account, { folder = 'INBOX', uid, maxBytes }) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const meta = await client.fetchOne(String(uid), { uid: true, size: true, flags: true }, { uid: true });
      if (!meta) throw new Error(`Message UID ${uid} not found in ${folder}`);
      if (meta.size > maxBytes) throw new Error(`Message too large (${meta.size} bytes, limit ${maxBytes})`);
      const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      const parsed = await simpleParser(full.source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
      return { uid: meta.uid, flags: [...(meta.flags || [])], parsed };
    } finally {
      lock.release();
    }
  });
}

/** Raw RFC 5322 source of several messages (for forwarding). Missing UIDs are reported. */
export async function getSources(account, { folder = 'INBOX', uids, maxBytes }) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const found = new Map();
      for await (const m of client.fetch(uids.join(','), { uid: true, size: true }, { uid: true })) found.set(m.uid, m.size);
      const missing = uids.filter((u) => !found.has(u));
      if (missing.length) throw new Error(`Message UID(s) not found in ${folder}: ${missing.join(', ')}`);
      const tooBig = uids.filter((u) => found.get(u) > maxBytes);
      if (tooBig.length) throw new Error(`Message(s) larger than ${maxBytes} bytes: UID ${tooBig.join(', ')}`);
      const out = [];
      for (const uid of uids) {
        const m = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        out.push({ uid, source: m.source });
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

/** Set the standard $Forwarded keyword (shown as "forwarded" by mail clients). */
export async function markForwarded(account, folder, uids) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageFlagsAdd(uids.join(','), [FORWARDED_FLAG], { uid: true });
    } finally {
      lock.release();
    }
  });
}

/** Headers needed to thread a reply correctly. */
export async function getReplyHeaders(account, { folder = 'INBOX', uid }) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, headers: ['references'] }, { uid: true });
      if (!msg) throw new Error(`Message UID ${uid} not found in ${folder}`);
      const refsHeader = msg.headers ? msg.headers.toString('utf8').replace(/^references:\s*/i, '').replace(/\r?\n\s+/g, ' ').trim() : '';
      const messageId = msg.envelope?.messageId || null;
      const references = [...refsHeader.split(/\s+/).filter((r) => /^<[^<>\s]+>$/.test(r)), ...(messageId ? [messageId] : [])];
      return { messageId, references: [...new Set(references)].slice(-20) };
    } finally {
      lock.release();
    }
  });
}

async function findSpecialFolder(client, specialUse, configured, fallbacks) {
  if (configured) return configured;
  const list = await client.list();
  const hit = list.find((f) => f.specialUse === specialUse);
  if (hit) return hit.path;
  const byName = list.find((f) => fallbacks.includes(f.path.toLowerCase()) || fallbacks.includes(f.name.toLowerCase()));
  return byName ? byName.path : null;
}

export async function appendDraft(account, raw) {
  return withImap(account, async (client) => {
    const folder = await findSpecialFolder(client, '\\Drafts', account.draftsFolder, ['drafts', 'entwürfe', 'inbox.drafts']);
    if (!folder) throw new Error('No drafts folder found – set "draftsFolder" in the configuration.');
    const res = await client.append(folder, raw, ['\\Draft', '\\Seen']);
    return { folder, uid: res?.uid ?? null };
  });
}

export async function appendSent(account, raws) {
  return withImap(account, async (client) => {
    const folder = await findSpecialFolder(client, '\\Sent', account.sentFolder, ['sent', 'gesendet', 'sent items', 'gesendete elemente', 'inbox.sent']);
    if (!folder) return { folder: null };
    for (const raw of raws) await client.append(folder, raw, ['\\Seen']);
    return { folder };
  });
}
