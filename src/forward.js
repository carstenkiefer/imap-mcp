// Forwarding existing messages (e.g. invoices to an accounting inbox).
//
// The assistant only chooses WHICH messages go WHERE. The forwarded content is
// the original message – the model cannot add attachments or alter the
// originals; it can only add a short plain-text note that the human sees in
// full. Forwarding:
//  * is off by default (allowForward) and limited to an explicit allow list
//    of recipients (forwardRecipients, mandatory),
//  * always needs human approval of the complete batch (see approval.js),
//  * marks forwarded messages with $Forwarded so they are not sent twice.

import { simpleParser } from 'mailparser';
import { getSources } from './imap.js';
import { stripInvisible, htmlToSafeText, sanitizeLine } from './sanitize.js';
import { assertPolicy, buildRaw, externalRecipients, fmtAddress, newMessageId, parseAddressList, senderOf, textWarnings } from './compose.js';

export const MAX_FORWARD_BATCH = 50;
const MAX_NOTE = 2000;

const line = (v, max = 200) => sanitizeLine(v || '', { urlMode: 'keep', maxLength: max });
const addrs = (field) => (field?.value || []).map((a) => (a.name ? `${line(a.name, 100)} <${line(a.address, 320)}>` : line(a.address, 320))).join(', ');

function safeFilename(name, fallback) {
  const clean = stripInvisible(name || '').text.replace(/[\r\n\t"\\/:*?<>|]+/g, '_').trim().slice(0, 150);
  return clean || fallback;
}

function originalText(parsed) {
  if (parsed.text && parsed.text.trim()) return stripInvisible(parsed.text).text;
  if (parsed.html) return htmlToSafeText(parsed.html).text;
  return '';
}

function kb(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Build a batch of forwards, one outgoing mail per original message.
 * @param {'inline'|'attachment'} mode inline = original text + original attachments;
 *        attachment = original message attached unchanged as .eml
 */
export async function prepareForward(account, config, { folder = 'INBOX', uids, to, note = '', mode = 'inline' }, accountLabel) {
  const unique = [...new Set(uids)];
  if (!unique.length) throw new Error('No messages selected');
  if (unique.length > MAX_FORWARD_BATCH) throw new Error(`At most ${MAX_FORWARD_BATCH} messages per forward request`);

  const recipients = parseAddressList(to, 'to');
  assertPolicy(account, 'forward', recipients.map((r) => r.address));

  const noteClean = stripInvisible(note);
  const noteText = noteClean.text.trim();
  if (noteText.length > MAX_NOTE) throw new Error(`Note too long (max. ${MAX_NOTE} characters)`);

  const from = senderOf(account);
  const sources = await getSources(account, { folder, uids: unique, maxBytes: config.security.maxMessageBytes });

  const items = [];
  const listing = [];
  let total = 0;
  for (const [i, { uid, source }] of sources.entries()) {
    const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
    const subjectOrig = line(parsed.subject, 250);
    const subject = /^(fwd?|wg):/i.test(subjectOrig) ? subjectOrig : `Fwd: ${subjectOrig}`;
    const header = [
      '---------- Forwarded message ----------',
      `From: ${addrs(parsed.from)}`,
      `Date: ${parsed.date ? parsed.date.toUTCString() : '?'}`,
      `Subject: ${subjectOrig}`,
      `To: ${addrs(parsed.to)}`,
      parsed.cc ? `Cc: ${addrs(parsed.cc)}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    let text;
    let attachments;
    if (mode === 'attachment') {
      text = `${noteText ? noteText + '\n\n' : ''}${header}\n\nThe original message is attached unchanged.`;
      attachments = [{ filename: safeFilename(`${subjectOrig || 'message'}.eml`, 'message.eml'), content: source, contentType: 'message/rfc822' }];
    } else {
      text = `${noteText ? noteText + '\n\n' : ''}${header}\n\n${originalText(parsed)}`;
      attachments = (parsed.attachments || [])
        .filter((a) => !a.related) // skip inline logos/signature images
        .map((a, n) => ({
          filename: safeFilename(a.filename, `attachment-${n + 1}`),
          content: a.content,
          contentType: a.contentType || 'application/octet-stream',
        }));
    }

    const messageId = newMessageId(from);
    const references = [parsed.messageId].filter((r) => r && /^<[^<>\s]+>$/.test(r));
    const raw = await buildRaw({ from, to: recipients, cc: [], bcc: [], subject, text, references }, { messageId, attachments });
    if (raw.length > config.security.maxMessageBytes) throw new Error(`Forward of UID ${uid} would exceed ${config.security.maxMessageBytes} bytes`);
    total += raw.length;

    items.push({ label: `UID ${uid}: ${subject}`, messageId, envelope: { from: from.address, to: recipients.map((r) => r.address) }, raw, sentCopy: raw, forwardOf: { folder, uid } });
    const attLine = attachments.length ? attachments.map((a) => `${line(a.filename, 150)} (${kb(a.content.length)})`).join(', ') : 'none';
    listing.push(
      `  ${i + 1}. UID ${uid} | ${parsed.date ? parsed.date.toISOString().slice(0, 10) : '?'} | From: ${addrs(parsed.from)}\n` +
        `     Subject: ${subjectOrig || '(no subject)'}\n` +
        `     Attachments: ${attLine}`,
    );
  }

  const warnings = [];
  const external = externalRecipients(from, recipients);
  if (external.length) warnings.push(`External recipients: ${external.map((r) => r.address).join(', ')}`);
  warnings.push(...textWarnings(noteText));
  if (noteClean.removed) warnings.push(`${noteClean.removed} invisible character(s) were removed from the note.`);

  const review = [
    `Account:   ${accountLabel}`,
    `From:      ${fmtAddress(from)}`,
    `To:        ${recipients.map(fmtAddress).join(', ')}`,
    `Mode:      ${mode === 'attachment' ? 'original attached unchanged as .eml' : 'original text + original attachments'}, one email per message`,
    `Total:     ${items.length} email(s), ${kb(total)}`,
    warnings.length ? `\nWARNINGS:\n${warnings.map((w) => `  ! ${w}`).join('\n')}` : null,
    '',
    `Messages to forward (${items.length}):`,
    ...listing,
    '',
    noteText ? `----- Note added at the top of each email (complete) -----\n${noteText}\n----- End -----` : 'Note: none',
  ]
    .filter((l) => l !== null)
    .join('\n');

  return {
    kind: 'forward',
    accountId: account.id,
    summary: `forward ${items.length} message(s) from ${folder} to ${recipients.map((r) => r.address).join(', ')}`,
    intro: `An AI assistant wants to FORWARD ${items.length} email(s) including their attachments on your behalf.`,
    confirmTitle: `Yes, forward these ${items.length} email(s) now`,
    review,
    items,
  };
}
