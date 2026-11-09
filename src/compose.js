// Building, validating and displaying outgoing messages.
//
// Outgoing mail is deliberately restricted:
//  * plain text only (no HTML → no tracking pixels, no hidden text, no remote images),
//  * no attachments (no file exfiltration),
//  * From is fixed by the configuration,
//  * invisible characters are stripped (no covert channel to smuggle data
//    past the human reviewer),
//  * recipients can be limited with an allow list.

import MailComposer from 'nodemailer/lib/mail-composer';
import addressparser from 'nodemailer/lib/addressparser';
import { randomBytes } from 'node:crypto';
import { stripInvisible } from './sanitize.js';

const ADDR_RE = /^[^\s@<>"(),;:\\[\]]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const MAX_SUBJECT = 300;
const MAX_BODY = 100_000;

function parseAddressList(values, field) {
  const out = [];
  for (const value of values || []) {
    if (/[\r\n]/.test(value)) throw new Error(`${field}: line breaks are not allowed in addresses`);
    const parsed = addressparser(value, { flatten: true });
    if (!parsed.length) throw new Error(`${field}: invalid address "${value}"`);
    for (const p of parsed) {
      const address = (p.address || '').trim();
      if (!ADDR_RE.test(address)) throw new Error(`${field}: invalid address "${value}"`);
      const name = stripInvisible(p.name || '').text.replace(/\s+/g, ' ').trim().slice(0, 100);
      out.push({ name, address: address.toLowerCase() });
    }
  }
  return out;
}

function patternToRegex(pattern) {
  let p = pattern.trim().toLowerCase();
  if (p.startsWith('@')) p = '*' + p;
  const re = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${re}$`);
}

export function isRecipientAllowed(address, allowList) {
  if (!allowList || !allowList.length) return true;
  return allowList.some((p) => patternToRegex(p).test(address.toLowerCase()));
}

/**
 * Validate the model-supplied input and produce a frozen outgoing message.
 * Throws with a readable reason if anything is not acceptable.
 */
export function buildOutgoing(account, input, replyHeaders = null) {
  const to = parseAddressList(input.to, 'to');
  const cc = parseAddressList(input.cc, 'cc');
  const bcc = parseAddressList(input.bcc, 'bcc');
  const all = [...to, ...cc, ...bcc];
  if (!to.length) throw new Error('At least one recipient in "to" is required');
  if (all.length > account.maxRecipients) {
    throw new Error(`Too many recipients (${all.length}), maximum is ${account.maxRecipients}`);
  }
  const denied = all.filter((r) => !isRecipientAllowed(r.address, account.allowedRecipients));
  if (denied.length) {
    throw new Error(`Recipients not permitted by allowedRecipients: ${denied.map((d) => d.address).join(', ')}`);
  }

  const subj = stripInvisible(input.subject || '');
  const subject = subj.text.replace(/\s+/g, ' ').trim();
  if (subject.length > MAX_SUBJECT) throw new Error(`Subject too long (max. ${MAX_SUBJECT} characters)`);

  const body = stripInvisible(input.body || '');
  const text = body.text.replace(/\t/g, '    ');
  if (text.length > MAX_BODY) throw new Error(`Body too long (max. ${MAX_BODY} characters)`);

  const fromAddr = account.from || account.imap.auth.user;
  const from = parseAddressList([fromAddr], 'from')[0];

  return Object.freeze({
    accountId: account.id,
    from,
    to,
    cc,
    bcc,
    subject,
    text,
    inReplyTo: replyHeaders?.messageId || null,
    references: replyHeaders?.references || [],
    strippedInvisible: subj.removed + body.removed,
  });
}

const fmt = (a) => (a.name ? `"${a.name.replace(/"/g, "'")}" <${a.address}>` : a.address);

/** Build the RFC 5322 message. */
export async function buildRaw(msg, { messageId } = {}) {
  const composer = new MailComposer({
    from: fmt(msg.from),
    to: msg.to.map(fmt),
    cc: msg.cc.length ? msg.cc.map(fmt) : undefined,
    bcc: msg.bcc.length ? msg.bcc.map(fmt) : undefined,
    subject: msg.subject,
    text: msg.text,
    inReplyTo: msg.inReplyTo || undefined,
    references: msg.references?.length ? msg.references : undefined,
    messageId: messageId || `<${randomBytes(16).toString('hex')}@${msg.from.address.split('@')[1]}>`,
    date: new Date(),
    keepBcc: true, // the copy in "Sent"/"Drafts" keeps Bcc; SMTP envelope is built separately
    headers: { 'X-Mailer': 'imap-mcp' },
  });
  return composer.compile().build();
}

function domainOf(addr) {
  return addr.split('@')[1] || '';
}

/** Findings shown to the human before approval. */
export function reviewWarnings(msg) {
  const warnings = [];
  const ownDomain = domainOf(msg.from.address);
  const external = [...msg.to, ...msg.cc, ...msg.bcc].filter((r) => domainOf(r.address) !== ownDomain);
  if (external.length) warnings.push(`External recipients: ${external.map((r) => r.address).join(', ')}`);
  if (msg.bcc.length) warnings.push(`BCC (hidden from other recipients): ${msg.bcc.map((r) => r.address).join(', ')}`);
  const urls = msg.text.match(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"']+/gi) || [];
  if (urls.length) {
    warnings.push(`Contains ${urls.length} link(s) – check that no data is hidden in them:\n    ${urls.map((u) => u.slice(0, 300)).join('\n    ')}`);
  }
  const long = msg.text.match(/[A-Za-z0-9+/=_-]{60,}/g);
  if (long) warnings.push(`Contains ${long.length} unusually long token(s) (possibly encoded data).`);
  if (msg.strippedInvisible) warnings.push(`${msg.strippedInvisible} invisible character(s) were removed.`);
  return warnings;
}

/** Complete human-readable rendering. The human sees exactly what will be sent. */
export function renderForReview(msg, accountLabel) {
  const lines = [];
  const warnings = reviewWarnings(msg);
  lines.push(`Account:   ${accountLabel}`);
  lines.push(`From:      ${fmt(msg.from)}`);
  lines.push(`To:        ${msg.to.map(fmt).join(', ')}`);
  if (msg.cc.length) lines.push(`Cc:        ${msg.cc.map(fmt).join(', ')}`);
  if (msg.bcc.length) lines.push(`Bcc:       ${msg.bcc.map(fmt).join(', ')}`);
  lines.push(`Subject:   ${msg.subject || '(no subject)'}`);
  if (msg.inReplyTo) lines.push(`Reply to:  ${msg.inReplyTo}`);
  lines.push(`Attachments: none (attachments are never supported)`);
  if (warnings.length) {
    lines.push('');
    lines.push('WARNINGS:');
    for (const w of warnings) lines.push(`  ! ${w}`);
  }
  lines.push('');
  lines.push(`----- Body (${msg.text.length} characters, complete) -----`);
  lines.push(msg.text);
  lines.push('----- End -----');
  return lines.join('\n');
}
