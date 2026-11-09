// SMTP delivery. Only ever called after a human approved the exact prepared
// operation (see approval.js and the CLI) – there is no other code path to it.

import nodemailer from 'nodemailer';
import { resolveAuth } from './config.js';
import { assertPolicy } from './compose.js';
import { appendSent, markForwarded, safeError } from './imap.js';

function transportFor(account) {
  const { smtp } = account;
  const secure = smtp.secure !== false;
  const auth = resolveAuth(smtp.auth);
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port || (secure ? 465 : 587),
    secure,
    requireTLS: !secure && !smtp.allowInsecure,
    auth: auth.accessToken ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken } : auth,
    tls: { rejectUnauthorized: smtp.rejectUnauthorized !== false, minVersion: 'TLSv1.2' },
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
  });
}

/**
 * Send all items of an approved operation.
 * @returns {Promise<{results: Array<{label, ok, messageId?, accepted?, rejected?, error?}>, sentFolder: string|null, markedForwarded: number}>}
 */
export async function deliverPrepared(account, prepared) {
  // Re-check policy at send time (the configuration may have changed since approval was requested).
  for (const item of prepared.items) assertPolicy(account, prepared.kind, item.envelope.to);

  const transport = transportFor(account);
  const results = [];
  const sent = [];
  try {
    for (const item of prepared.items) {
      try {
        const info = await transport.sendMail({ envelope: item.envelope, raw: item.raw });
        results.push({ label: item.label, ok: true, messageId: item.messageId, accepted: info.accepted || [], rejected: info.rejected || [] });
        sent.push(item);
      } catch (err) {
        results.push({ label: item.label, ok: false, error: `SMTP delivery failed: ${safeError(err)}` });
      }
    }
  } finally {
    transport.close();
  }

  // Best effort follow-ups: delivery already happened.
  let sentFolder = null;
  if (account.saveToSent && sent.length) {
    try {
      sentFolder = (await appendSent(account, sent.map((i) => i.sentCopy || i.raw))).folder;
    } catch {
      /* ignore */
    }
  }
  let markedForwarded = 0;
  if (account.markForwarded) {
    const byFolder = new Map();
    for (const i of sent.filter((i) => i.forwardOf)) {
      byFolder.set(i.forwardOf.folder, [...(byFolder.get(i.forwardOf.folder) || []), i.forwardOf.uid]);
    }
    for (const [folder, uids] of byFolder) {
      try {
        await markForwarded(account, folder, uids);
        markedForwarded += uids.length;
      } catch {
        /* server may not allow keywords */
      }
    }
  }
  return { results, sentFolder, markedForwarded };
}

export function formatResults({ results, sentFolder, markedForwarded }) {
  const ok = results.filter((r) => r.ok).length;
  const lines = [`${ok} of ${results.length} email(s) sent after explicit approval by the user.`];
  for (const r of results) {
    lines.push(
      r.ok
        ? `  ✔ ${r.label} – ${r.messageId}${r.rejected?.length ? ` (rejected: ${r.rejected.join(', ')})` : ''}`
        : `  ✘ ${r.label} – ${r.error}`,
    );
  }
  if (sentFolder) lines.push(`Copies saved to: ${sentFolder}`);
  if (markedForwarded) lines.push(`${markedForwarded} original(s) marked as $Forwarded.`);
  return lines.join('\n');
}
