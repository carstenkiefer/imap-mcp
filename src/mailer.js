// SMTP delivery. Only ever called after a human approved the exact message
// (see approval.js and cli.js) – there is no other code path to it.

import nodemailer from 'nodemailer';
import { randomBytes } from 'node:crypto';
import { resolveAuth } from './config.js';
import { buildRaw, isRecipientAllowed } from './compose.js';
import { appendSent, safeError } from './imap.js';

export async function deliver(account, msg) {
  if (!account.allowSend || !account.smtp) throw new Error(`Sending is disabled for account "${account.id}"`);
  // Re-check policy at send time (config may have changed since the message was queued).
  const all = [...msg.to, ...msg.cc, ...msg.bcc];
  if (all.length > account.maxRecipients) throw new Error('Too many recipients');
  const denied = all.filter((r) => !isRecipientAllowed(r.address, account.allowedRecipients));
  if (denied.length) throw new Error(`Recipients not permitted: ${denied.map((d) => d.address).join(', ')}`);

  const { smtp } = account;
  const secure = smtp.secure !== false;
  const auth = resolveAuth(smtp.auth);
  const transport = nodemailer.createTransport({
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

  const messageId = `<${randomBytes(16).toString('hex')}@${msg.from.address.split('@')[1]}>`;
  const raw = await buildRaw(msg, { messageId });
  // Bcc must not appear in the transmitted headers.
  const rawForSmtp = msg.bcc.length ? await buildRaw({ ...msg, bcc: [] }, { messageId }) : raw;

  let info;
  try {
    info = await transport.sendMail({
      envelope: { from: msg.from.address, to: all.map((r) => r.address) },
      raw: rawForSmtp,
    });
  } catch (err) {
    throw new Error(`SMTP delivery failed: ${safeError(err)}`);
  } finally {
    transport.close();
  }

  let sentFolder = null;
  if (account.saveToSent) {
    try {
      sentFolder = (await appendSent(account, raw)).folder;
    } catch {
      /* delivery succeeded; storing a copy is best effort */
    }
  }
  return { messageId, accepted: info.accepted || [], rejected: info.rejected || [], sentFolder };
}
