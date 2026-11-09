// Streamable HTTP transport (Open WebUI and other web clients).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHttpServer } from '../src/http.js';
import { startImap, startSmtp, testConfig } from './helpers.js';

const IMAP_PORT = 17300 + Math.floor(Math.random() * 300);
const SMTP_PORT = IMAP_PORT + 400;
const TOKEN = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(8);
let imap, smtp, http, base, outboxDir;

before(async () => {
  imap = await startImap(IMAP_PORT);
  smtp = await startSmtp(SMTP_PORT);
  outboxDir = mkdtempSync(join(tmpdir(), 'imap-mcp-http-'));
  http = await startHttpServer(testConfig({ imapPort: IMAP_PORT, smtpPort: SMTP_PORT, outboxDir }), { port: 0, token: TOKEN });
  base = `http://127.0.0.1:${http.address().port}`;
});
after(() => {
  http.close();
  imap.close();
  smtp.server.close();
  rmSync(outboxDir, { recursive: true, force: true });
});

async function connect(token, elicit) {
  const client = new Client({ name: 'web', version: '1' }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  const dialogs = [];
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      dialogs.push(req.params.message);
      return elicit(req.params);
    });
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return { client, dialogs, close: () => client.close() };
}

test('a token of at least 32 characters is mandatory', () => {
  assert.throws(() => startHttpServer({}, { port: 0, token: undefined }), /at least 32/);
  assert.throws(() => startHttpServer({}, { port: 0, token: 'short' }), /at least 32/);
});

test('requests without or with a wrong token are rejected', async () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const none = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(init) });
  assert.equal(none.status, 401);
  const wrong = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer ' + 'x'.repeat(40) }, body: JSON.stringify(init) });
  assert.equal(wrong.status, 401);
  await assert.rejects(connect('y'.repeat(40)));
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('tools work over HTTP', async () => {
  const { client, close } = await connect(TOKEN);
  const r = await client.callTool({ name: 'search_messages', arguments: { account: 'test', from: 'dpd', has_attachments: true } });
  assert.match(r.content[0].text, /Rechnung_4711\.pdf/);
  await close();
});

test('approval dialog reaches the HTTP client during the tool call; decline sends nothing', async () => {
  const before = smtp.received.length;
  const { client, dialogs, close } = await connect(TOKEN, () => ({ action: 'decline' }));
  const r = await client.callTool({ name: 'forward_messages', arguments: { account: 'test', uids: [3], to: ['buha@example.de'] } });
  assert.match(r.content[0].text, /did NOT approve/);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /Rechnung_4711\.pdf/);
  assert.equal(smtp.received.length, before);
  await close();
});

test('approved forward over HTTP is delivered', async () => {
  const before = smtp.received.length;
  const { client, close } = await connect(TOKEN, () => ({ action: 'accept', content: { confirm: true } }));
  const r = await client.callTool({ name: 'forward_messages', arguments: { account: 'test', uids: [4], to: ['buha@example.de'] } });
  assert.match(r.content[0].text, /1 of 1 email\(s\) sent/, r.content[0].text);
  assert.equal(smtp.received.length, before + 1);
  await close();
});
