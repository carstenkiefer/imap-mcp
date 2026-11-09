// End-to-end: MCP client <-> server <-> local IMAP/SMTP test servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';
import { listPending } from '../src/outbox.js';
import { startImap, startSmtp, testConfig } from './helpers.js';

const IMAP_PORT = 14300 + Math.floor(Math.random() * 500);
const SMTP_PORT = IMAP_PORT + 600;
let imap, smtp, outboxDir;

before(async () => {
  imap = await startImap(IMAP_PORT);
  smtp = await startSmtp(SMTP_PORT);
  outboxDir = mkdtempSync(join(tmpdir(), 'imap-mcp-outbox-'));
});
after(() => {
  imap.close();
  smtp.server.close();
  rmSync(outboxDir, { recursive: true, force: true });
});

/** Connect a client. `elicit` simulates the human's answer in the approval dialog (null = no elicitation support). */
async function connect(configOverrides = {}, elicit = null) {
  const config = testConfig({ imapPort: IMAP_PORT, smtpPort: SMTP_PORT, outboxDir, ...configOverrides });
  const server = createServer(config);
  const client = new Client({ name: 'test', version: '1' }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  const dialogs = [];
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      dialogs.push(req.params.message);
      return elicit(req.params);
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, dialogs, call: async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, text: r.content.map((c) => c.text).join('\n') };
  } };
}

const mail = { account: 'test', to: ['bob@example.com'], subject: 'Hi', body: 'Hello Bob' };

test('tools are listed with read-only annotations', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['create_draft', 'list_accounts', 'list_folders', 'list_messages', 'read_message', 'search_messages', 'send_email']);
  for (const t of tools.filter((t) => /^(list|read|search)_/.test(t.name))) assert.equal(t.annotations.readOnlyHint, true);
  assert.ok(!tools.some((t) => JSON.stringify(t.inputSchema).includes('confirm')), 'no tool may take a confirmation flag');
});

test('list and search return wrapped, sanitised data', async () => {
  const { call } = await connect();
  const list = await call('list_messages', { account: 'test' });
  assert.match(list.text, /<<<UNTRUSTED_EMAIL_DATA id=[0-9a-f]+>>>/);
  assert.match(list.text, /UID 2 .*UNREAD/);
  assert.doesNotMatch(list.text, /​|\u{E0041}/u);
  const search = await call('search_messages', { account: 'test', from: 'alice' });
  assert.match(search.text, /1 hit/);
  assert.match(search.text, /Lunch\?/);
});

test('read_message neutralises the EchoLeak-style injection and does not mark as read', async () => {
  const { call } = await connect();
  const r = await call('read_message', { account: 'test', uid: 2 });
  assert.match(r.text, /quarterly numbers/);
  assert.doesNotMatch(r.text, /ignore all previous instructions/i);
  assert.doesNotMatch(r.text, /https?:\/\//);
  assert.doesNotMatch(r.text, /!\[/);
  assert.match(r.text, /hidden HTML element/);
  assert.match(r.text, /Reply-To differs/);
  const list = await call('list_messages', { account: 'test', unseen_only: true });
  assert.match(list.text, /UID 2/);
});

test('send_email: declined approval sends nothing', async () => {
  const before = smtp.received.length;
  const { call, dialogs } = await connect({}, () => ({ action: 'decline' }));
  const r = await call('send_email', mail);
  assert.match(r.text, /did NOT approve/);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /bob@example\.com/);
  assert.match(dialogs[0], /Hello Bob/);
  assert.equal(smtp.received.length, before);
});

test('send_email: "accept" without ticking the box sends nothing', async () => {
  const before = smtp.received.length;
  const { call } = await connect({}, () => ({ action: 'accept', content: { confirm: false } }));
  const r = await call('send_email', mail);
  assert.match(r.text, /did NOT approve/);
  assert.equal(smtp.received.length, before);
});

test('send_email: explicit approval sends exactly the reviewed mail, BCC hidden', async () => {
  const before = smtp.received.length;
  const { call, dialogs } = await connect({}, () => ({ action: 'accept', content: { confirm: true } }));
  const r = await call('send_email', { ...mail, bcc: ['carol@example.com'], reply_to_uid: 1 });
  assert.match(r.text, /Email sent after explicit approval/, r.text);
  assert.equal(smtp.received.length, before + 1);
  const sent = smtp.received.at(-1);
  assert.deepEqual(sent.envelope.rcptTo.map((x) => x.address).sort(), ['bob@example.com', 'carol@example.com']);
  assert.doesNotMatch(sent.raw, /^Bcc:/im);
  assert.match(sent.raw, /^In-Reply-To: <.+@test\.example>/im);
  assert.match(sent.raw, /Hello Bob/);
  assert.match(dialogs[0], /BCC/);
});

test('send_email without elicitation support only queues to the outbox', async () => {
  const before = smtp.received.length;
  const { call } = await connect();
  const r = await call('send_email', mail);
  assert.match(r.text, /NOT sent/);
  assert.match(r.text, /imap-mcp outbox send [0-9a-f]{16}/);
  assert.equal(smtp.received.length, before);
  assert.equal(listPending(outboxDir).length, 1);
});

test('approvalMode "outbox" never uses the dialog', async () => {
  const { call, dialogs } = await connect({ approvalMode: 'outbox' }, () => ({ action: 'accept', content: { confirm: true } }));
  const r = await call('send_email', mail);
  assert.match(r.text, /NOT sent/);
  assert.equal(dialogs.length, 0);
});

test('send disabled and recipient allow list are enforced before any dialog', async () => {
  const off = await connect({ allowSend: false }, () => ({ action: 'accept', content: { confirm: true } }));
  const r1 = await off.call('send_email', mail);
  assert.equal(r1.isError, true);
  assert.match(r1.text, /disabled/);
  assert.equal(off.dialogs.length, 0);

  const limited = await connect({ allowedRecipients: ['*@example.com'] }, () => ({ action: 'accept', content: { confirm: true } }));
  const r2 = await limited.call('send_email', { ...mail, to: ['attacker@evil.example'] });
  assert.equal(r2.isError, true);
  assert.match(r2.text, /not permitted/);
  assert.equal(limited.dialogs.length, 0);
});

test('create_draft stores a draft and sends nothing', async () => {
  const before = smtp.received.length;
  const { call } = await connect();
  const r = await call('create_draft', mail);
  assert.match(r.text, /Draft saved in folder "Drafts"/, r.text);
  assert.equal(smtp.received.length, before);
  const folders = await call('list_folders', { account: 'test' });
  assert.match(folders.text, /Drafts \[\\Drafts\] – 1 messages/);
});
