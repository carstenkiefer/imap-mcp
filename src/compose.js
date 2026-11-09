// Building, validating and displaying outgoing messages.
//
// Mail written by the assistant is deliberately restricted:
//  * plain text only (no HTML → no tracking pixels, no hidden text, no remote images),
//  * no attachments of its own (no file exfiltration; only forwards carry the
//    original message's attachments, see forward.js),
//  * From is fixed by the configuration,
//  * invisible characters are stripped (no covert channel to smuggle data
//    past the human reviewer),
//  * recipients can be limited with an allow list.
//
// Every outgoing operation is turned into a "prepared" object: the final RFC 5322
// bytes plus the human-readable review text. The human approves exactly that
// object, and delivery sends exactly those bytes.

import MailComposer from 'nodemailer/lib/mail-composer';
import addressparser from 'nodemailer/lib/addressparser';
import { randomBytes } from 'node:crypto';
import { stripInvisible } from './sanitize.js';

const ADDR_RE = /^[^\s@<>"(),;:\\[\]]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const MAX_SUBJECT = 300;
const MAX_BODY = 100_000;

export function parseAddressList(values, field) {
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
 * Policy check for one kind of outgoing operation. Called when a message is
 * prepared and again right before delivery.
 * @param {'compose'|'forward'} kind
 */
export function assertPolicy(account, kind, addresses) {
  if (!account.smtp) throw new Error(`No SMTP configured for account "${account.id}"`);
  if (kind === 'compose' && !account.allowSend) {
    throw new Error(`Sending is disabled for account "${account.id}" (allowSend). Use create_draft instead.`);
  }
  if (kind === 'forward' && !account.allowForward) {
    throw new Error(`Forwarding is disabled for account "${account.id}" (allowForward).`);
  }
  if (!addresses.length) throw new Error('At least one recipient is required');
  if (addresses.length > account.maxRecipients) {
    throw new Error(`Too many recipients (${addresses.length}), maximum is ${account.maxRecipients}`);
  }
  const allowList = kind === 'forward' ? account.forwardRecipients : account.allowedRecipients;
  const denied = addresses.filter((a) => !isRecipientAllowed(a, allowList));
  if (denied.length) {
    const key = kind === 'forward' ? 'forwardRecipients' : 'allowedRecipients';
    throw new Error(`Recipients not permitted by ${key}: ${denied.join(', ')}`);
  }
}

export function senderOf(account) {
  return parseAddressList([account.from || account.imap.auth.user], 'from')[0];
}

/**
 * Validate the model-supplied input and produce a frozen outgoing message.
 * Throws with a readable reason if anything is not acceptable.
 */
export function buildOutgoing(account, input, replyHeaders = null) {
  const to = parseAddressList(input.to, 'to');
  const cc = parseAddressList(input.cc, 'cc');
  const bcc = parseAddressList(input.bcc, 'bcc');
  if (!to.length) throw new Error('At least one recipient in "to" is required');
  // Recipient rules also apply to drafts, which need neither SMTP nor allowSend.
  assertPolicy({ ...account, smtp: account.smtp || {}, allowSend: true }, 'compose', [...to, ...cc, ...bcc].map((r) => r.address));

  const subj = stripInvisible(input.subject || '');
  const subject = subj.text.replace(/\s+/g, ' ').trim();
  if (subject.length > MAX_SUBJECT) throw new Error(`Subject too long (max. ${MAX_SUBJECT} characters)`);

  const body = stripInvisible(input.body || '');
  const text = body.text.replace(/\t/g, '    ');
  if (text.length > MAX_BODY) throw new Error(`Body too long (max. ${MAX_BODY} characters)`);

  return Object.freeze({
    accountId: account.id,
    from: senderOf(account),
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

export const fmtAddress = (a) => (a.name ? `"${a.name.replace(/"/g, "'")}" <${a.address}>` : a.address);

export function newMessageId(from) {
  return `<${randomBytes(16).toString('hex')}@${from.address.split('@')[1]}>`;
}

/**
 * Build the RFC 5322 message. `attachments` is internal only (forwarding of
 * original attachments) and never taken from model input.
 */
export async function buildRaw(msg, { messageId, attachments } = {}) {
  const composer = new MailComposer({
    from: fmtAddress(msg.from),
    to: msg.to.map(fmtAddress),
    cc: msg.cc?.length ? msg.cc.map(fmtAddress) : undefined,
    bcc: msg.bcc?.length ? msg.bcc.map(fmtAddress) : undefined,
    subject: msg.subject,
    text: msg.text,
    attachments: attachments?.length ? attachments : undefined,
    inReplyTo: msg.inReplyTo || undefined,
    references: msg.references?.length ? msg.references : undefined,
    messageId: messageId || newMessageId(msg.from),
    date: new Date(),
    keepBcc: true, // only for the copy in "Sent"/"Drafts"; the SMTP copy is built without Bcc
    headers: { 'X-Mailer': 'imap-mcp' },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return composer.compile().build();
}

function domainOf(addr) {
  return addr.split('@')[1] || '';
}

export function externalRecipients(from, recipients) {
  const own = domainOf(from.address);
  return recipients.filter((r) => domainOf(r.address) !== own);
}

/** Findings shown to the human before approval. */
export function reviewWarnings(msg) {
  const warnings = [];
  const external = externalRecipients(msg.from, [...msg.to, ...msg.cc, ...msg.bcc]);
  if (external.length) warnings.push(`External recipients: ${external.map((r) => r.address).join(', ')}`);
  if (msg.bcc.length) warnings.push(`BCC (hidden from other recipients): ${msg.bcc.map((r) => r.address).join(', ')}`);
  warnings.push(...textWarnings(msg.text));
  if (msg.strippedInvisible) warnings.push(`${msg.strippedInvisible} invisible character(s) were removed.`);
  return warnings;
}

export function textWarnings(text) {
  const warnings = [];
  const urls = text.match(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"']+/gi) || [];
  if (urls.length) {
    warnings.push(`Contains ${urls.length} link(s) – check that no data is hidden in them:\n    ${urls.map((u) => u.slice(0, 300)).join('\n    ')}`);
  }
  const long = text.match(/[A-Za-z0-9+/=_-]{60,}/g);
  if (long) warnings.push(`Contains ${long.length} unusually long token(s) (possibly encoded data).`);
  return warnings;
}

/** Complete human-readable rendering. The human sees exactly what will be sent. */
export function renderForReview(msg, accountLabel) {
  const lines = [];
  const warnings = reviewWarnings(msg);
  lines.push(`Account:   ${accountLabel}`);
  lines.push(`From:      ${fmtAddress(msg.from)}`);
  lines.push(`To:        ${msg.to.map(fmtAddress).join(', ')}`);
  if (msg.cc.length) lines.push(`Cc:        ${msg.cc.map(fmtAddress).join(', ')}`);
  if (msg.bcc.length) lines.push(`Bcc:       ${msg.bcc.map(fmtAddress).join(', ')}`);
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

/** Turn a validated message into a prepared, approvable send operation. */
export async function prepareCompose(account, msg, accountLabel) {
  const messageId = newMessageId(msg.from);
  const sentCopy = await buildRaw(msg, { messageId });
  // Bcc must not appear in the transmitted headers.
  const raw = msg.bcc.length ? await buildRaw({ ...msg, bcc: [] }, { messageId }) : sentCopy;
  const recipients = [...msg.to, ...msg.cc, ...msg.bcc].map((r) => r.address);
  return {
    kind: 'compose',
    accountId: account.id,
    summary: `send to ${recipients.join(', ')}: "${msg.subject}"`,
    intro: 'An AI assistant wants to SEND the following email on your behalf.',
    confirmTitle: 'Yes, send this email now',
    review: renderForReview(msg, accountLabel),
    items: [{ label: msg.subject || '(no subject)', messageId, envelope: { from: msg.from.address, to: recipients }, raw, sentCopy, forwardOf: null }],
  };
}
