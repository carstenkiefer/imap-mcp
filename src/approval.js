// Human approval for outgoing mail (new emails and forwards).
//
// The language model can only *request* an operation. The decision is made by
// a human through a channel the model cannot write to:
//
//  1. MCP elicitation (preferred): the server asks the MCP client to show a
//     form to the user. The answer goes from the user's UI straight back to
//     the server; the model never sees or produces it.
//  2. Local outbox (fallback): the prepared operation is queued on disk and
//     the user reviews and sends it with `imap-mcp outbox send <id>` in an
//     interactive terminal.
//
// There is intentionally no tool parameter like `confirm: true` – anything
// the model can pass, a prompt injection can pass as well.

import { deliverPrepared, formatResults } from './mailer.js';
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
export async function requestApproval({ server, config, account, prepared }) {
  let elicitError = null;

  if (canElicit(server, config)) {
    let res = null;
    try {
      res = await server.server.elicitInput(
        {
          mode: 'form',
          message:
            `${prepared.intro} Please review everything below. ` +
            'Nothing is sent unless you tick the box and accept.\n\n' +
            prepared.review,
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: {
                type: 'boolean',
                title: prepared.confirmTitle,
                description: 'Only tick this if you have checked the details above and want exactly this to be sent.',
                default: false,
              },
            },
            required: ['confirm'],
          },
        },
        { timeout: ELICIT_TIMEOUT_MS },
      );
    } catch (err) {
      elicitError = err.message; // client could not show the dialog -> fall back to the outbox
    }
    if (res) {
      if (res.action === 'accept' && res.content?.confirm === true) {
        const result = await deliverPrepared(account, prepared);
        return { status: 'sent', text: formatResults(result) };
      }
      return {
        status: 'declined',
        text: `The user did NOT approve (${res.action}). Nothing was sent. Do not retry unless the user asks for it.`,
      };
    }
  }

  const entry = savePending(config.security.outboxDir, prepared, config.security.pendingTtlHours);
  return {
    status: 'pending',
    text:
      `Nothing was sent (${prepared.summary}). It is waiting for the user's approval in the local outbox` +
      (elicitError ? ` (approval dialog not available: ${elicitError})` : '') +
      '.\nTell the user to review and send it themselves in a terminal:\n' +
      `  imap-mcp outbox send ${entry.id}\n` +
      `It expires at ${entry.expiresAt}. You cannot approve it yourself.`,
  };
}
