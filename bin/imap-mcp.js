#!/usr/bin/env node
// imap-mcp – MCP server for IMAP mailboxes, plus a small CLI to review and
// approve outgoing mail.

import { createInterface } from 'node:readline/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, getAccount, defaultConfigPath } from '../src/config.js';
import { createServer, VERSION, accountLabel } from '../src/server.js';
import { listPending, loadPending, removePending } from '../src/outbox.js';
import { renderForReview } from '../src/compose.js';
import { deliver } from '../src/mailer.js';
import { withImap } from '../src/imap.js';

const HELP = `imap-mcp ${VERSION}

Usage:
  imap-mcp                       Start the MCP server (stdio)
  imap-mcp check                 Test the IMAP login of all configured accounts
  imap-mcp outbox                List emails waiting for approval
  imap-mcp outbox show <id>      Show a waiting email
  imap-mcp outbox send <id>      Review and send a waiting email (interactive terminal only)
  imap-mcp outbox discard <id>   Discard a waiting email

Configuration: ${defaultConfigPath()} (override with IMAP_MCP_CONFIG)`;

async function serve() {
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[imap-mcp] ${VERSION} ready, ${config.accounts.length} account(s)\n`);
}

async function check() {
  const config = loadConfig();
  let ok = true;
  for (const acc of config.accounts) {
    try {
      await withImap(acc, async (c) => c.status('INBOX', { messages: true }));
      console.log(`✔ ${acc.id}: IMAP login OK (send: ${acc.allowSend ? 'enabled, with approval' : 'disabled'})`);
    } catch (err) {
      ok = false;
      console.log(`✘ ${acc.id}: ${err.message}`);
    }
  }
  process.exitCode = ok ? 0 : 1;
}

async function outbox(sub, id) {
  const config = loadConfig();
  const dir = config.security.outboxDir;

  if (!sub || sub === 'list') {
    const items = listPending(dir);
    if (!items.length) return console.log('No emails waiting for approval.');
    for (const e of items) {
      const m = e.message;
      console.log(`${e.id}  ${e.createdAt}  [${m.accountId}]  to ${m.to.map((r) => r.address).join(', ')}  "${m.subject}"`);
    }
    return;
  }
  if (!id) throw new Error('Missing id. See: imap-mcp outbox');
  const entry = loadPending(dir, id);
  const account = getAccount(config, entry.message.accountId);

  if (sub === 'show') return console.log(renderForReview(entry.message, accountLabel(account)));
  if (sub === 'discard') {
    removePending(dir, id);
    return console.log(`Discarded ${id}.`);
  }
  if (sub !== 'send') throw new Error(`Unknown command "outbox ${sub}"`);

  // Approval must come from a human at a real terminal, not from a piped
  // command an AI agent could run.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Approval requires an interactive terminal. Run this command yourself.');
  }
  console.log('\n' + renderForReview(entry.message, accountLabel(account)) + '\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "send" to send this email exactly as shown, anything else to abort: ')).trim();
  rl.close();
  if (answer !== 'send') return console.log('Aborted. Nothing was sent (the email stays in the outbox).');

  const res = await deliver(account, entry.message);
  removePending(dir, id);
  console.log(`Sent. Message-ID ${res.messageId}${res.rejected.length ? `, rejected: ${res.rejected.join(', ')}` : ''}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const run = {
  undefined: serve,
  serve,
  check,
  outbox: () => outbox(...rest),
  help: async () => console.log(HELP),
  '--help': async () => console.log(HELP),
  '-h': async () => console.log(HELP),
  '--version': async () => console.log(VERSION),
}[cmd];

if (!run) {
  console.error(HELP);
  process.exit(2);
}
run().catch((err) => {
  console.error(`imap-mcp: ${err.message}`);
  process.exit(1);
});
