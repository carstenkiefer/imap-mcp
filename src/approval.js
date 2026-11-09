// Human approval for outgoing mail.
//
// The language model can only *request* a send. The decision is made by a
// human through a channel the model cannot write to:
//
//  1. MCP elicitation (preferred): the server asks the MCP client to show a
//     form to the user. The answer goes from the user's UI straight back to
//     the server; the model never sees or produces it.
//  2. Local outbox (fallback): the message is queued on disk and the user
//     reviews and sends it with `imap-mcp outbox send <id>` in an interactive
//     terminal.
//
// There is intentionally no tool parameter like `confirm: true` – anything
// the model can pass, a prompt injection can pass as well.

import { renderForReview } from './compose.js';
import { deliver } from './mailer.js';
import { savePending } from './outbox.js';

const ELICIT_TIMEOUT_MS = 15 * 60_000;

export function accountLabel(account) {
  return account.name ? `${account.name} (${account.id})` : account.id;
}

function canElicit(server, config) {
  if (config.security.approvalMode !== 'auto') return false;
  return Boolean(server.server.getClientCapabilities()?.elicitation?.form);
}

/**
 * @returns {Promise<{status: 'sent'|'declined'|'pending', text: string}>}
 */
export async function requestSend({ server, config, account, msg }) {
  const review = renderForReview(msg, accountLabel(account));
  let elicitError = null;

  if (canElicit(server, config)) {
    try {
      const res = await server.server.elicitInput(
        {
          mode: 'form',
          message:
            'An AI assistant wants to SEND the following email on your behalf. ' +
            'Please review recipients and the complete text. Nothing is sent unless you tick the box and accept.\n\n' +
            review,
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: {
                type: 'boolean',
                title: 'Yes, send this email now',
                description: 'Only tick this if you have read the email above and want it sent exactly like this.',
                default: false,
              },
            },
            required: ['confirm'],
          },
        },
        { timeout: ELICIT_TIMEOUT_MS },
      );
      if (res.action === 'accept' && res.content?.confirm === true) {
        const result = await deliver(account, msg);
        return {
          status: 'sent',
          text:
            `Email sent after explicit approval by the user.\nMessage-ID: ${result.messageId}\n` +
            `Accepted: ${result.accepted.join(', ') || '-'}` +
            (result.rejected.length ? `\nRejected: ${result.rejected.join(', ')}` : '') +
            (result.sentFolder ? `\nCopy saved to: ${result.sentFolder}` : ''),
        };
      }
      return {
        status: 'declined',
        text: `The user did NOT approve the email (${res.action}). Nothing was sent. Do not retry unless the user asks for it.`,
      };
    } catch (err) {
      if (/SMTP|Sending is disabled|not permitted|Too many/.test(err.message)) throw err;
      elicitError = err.message; // client could not show the dialog -> fall back to the outbox
    }
  }

  const entry = savePending(config.security.outboxDir, msg, config.security.pendingTtlHours);
  return {
    status: 'pending',
    text:
      'The email was NOT sent. It is waiting for the user\'s approval in the local outbox' +
      (elicitError ? ` (approval dialog not available: ${elicitError})` : '') +
      '.\nTell the user to review and send it themselves in a terminal:\n' +
      `  imap-mcp outbox send ${entry.id}\n` +
      `It expires at ${entry.expiresAt}. You cannot approve it yourself.`,
  };
}
