#!/usr/bin/env node
// imap-mcp – MCP server for IMAP mailboxes, plus a small CLI to review and
// approve outgoing mail.

import { createInterface } from 'node:readline/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, getAccount, defaultConfigPath } from '../src/config.js';
import { createServer, VERSION } from '../src/server.js';
import { listPending, loadPending, removePending } from '../src/outbox.js';
import { deliverPrepared, formatResults } from '../src/mailer.js';
import { withImap } from '../src/imap.js';
import { startHttpServer } from '../src/http.js';

const HELP = `imap-mcp ${VERSION}

Usage:
  imap-mcp                       Start the MCP server (stdio)
  imap-mcp http [options]        Start the MCP server over Streamable HTTP (e.g. for Open WebUI)
      --host <addr>              Interface to listen on (default 127.0.0.1, env IMAP_MCP_HTTP_HOST)
      --port <port>              Port (default 8808, env IMAP_MCP_HTTP_PORT)
                                 The bearer token is read from IMAP_MCP_HTTP_TOKEN (min. 32 characters)
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

function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function http(args) {
  const config = loadConfig();
  const host = option(args, '--host', process.env.IMAP_MCP_HTTP_HOST || '127.0.0.1');
  const port = Number(option(args, '--port', process.env.IMAP_MCP_HTTP_PORT || 8808));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const log = (m) => process.stderr.write(`[imap-mcp] ${m}\n`);
  await startHttpServer(config, { host, port, token: process.env.IMAP_MCP_HTTP_TOKEN, log });
  log(`${VERSION} listening on http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp, ${config.accounts.length} account(s)`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    log('NOTE: listening on a non-loopback interface. Use TLS (reverse proxy) or a private Docker network, never expose this port to the internet.');
  }
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
    for (const e of items) console.log(`${e.id}  ${e.createdAt}  [${e.prepared.accountId}]  ${e.prepared.summary}`);
    return;
  }
  if (!id) throw new Error('Missing id. See: imap-mcp outbox');
  const entry = loadPending(dir, id);
  const { prepared } = entry;
  const account = getAccount(config, prepared.accountId);

  if (sub === 'show') return console.log(prepared.review);
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
  console.log(`\n${prepared.intro}\n\n${prepared.review}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "send" to send exactly what is shown above, anything else to abort: ')).trim();
  rl.close();
  if (answer !== 'send') return console.log('Aborted. Nothing was sent (it stays in the outbox).');

  // Remove first so that an interrupted run can never send the same batch twice.
  removePending(dir, id);
  const res = await deliverPrepared(account, prepared);
  console.log(formatResults(res));
}

const [cmd, ...rest] = process.argv.slice(2);
const run = {
  undefined: serve,
  serve,
  http: () => http(rest),
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
