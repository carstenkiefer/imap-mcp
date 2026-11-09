import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutgoing, buildRaw, isRecipientAllowed, renderForReview } from '../src/compose.js';

const account = { id: 'a', from: 'Me <me@example.com>', imap: { auth: { user: 'me@example.com' } }, maxRecipients: 3, allowedRecipients: undefined };

test('header injection via addresses or subject is impossible', () => {
  assert.throws(() => buildOutgoing(account, { to: ['a@example.com\r\nBcc: x@evil.example'], subject: 's', body: 'b' }));
  const msg = buildOutgoing(account, { to: ['a@example.com'], subject: 'hi\r\nBcc: x@evil.example', body: 'b' });
  assert.doesNotMatch(msg.subject, /[\r\n]/);
});

test('invalid addresses and too many recipients are rejected', () => {
  assert.throws(() => buildOutgoing(account, { to: ['not-an-address'], subject: '', body: '' }));
  assert.throws(() => buildOutgoing(account, { to: ['a@x.de', 'b@x.de'], cc: ['c@x.de'], bcc: ['d@x.de'], subject: '', body: '' }), /Too many/);
});

test('allow list', () => {
  assert.ok(isRecipientAllowed('a@example.com', ['*@example.com']));
  assert.ok(isRecipientAllowed('a@example.com', ['@example.com']));
  assert.ok(isRecipientAllowed('a@sub.example.com', ['*@*.example.com']));
  assert.ok(!isRecipientAllowed('a@example.com.evil.example', ['*@example.com']));
  assert.ok(!isRecipientAllowed('a@evil.example', ['*@example.com', 'boss@partner.example']));
  assert.throws(() => buildOutgoing({ ...account, allowedRecipients: ['*@example.com'] }, { to: ['x@evil.example'], subject: '', body: '' }), /not permitted/);
});

test('invisible characters are stripped from outgoing mail (no covert channel)', () => {
  const msg = buildOutgoing(account, { to: ['a@example.com'], subject: 'x​', body: 'hello\u{E0053}\u{E0045}' });
  assert.equal(msg.text, 'hello');
  assert.equal(msg.strippedInvisible, 3);
});

test('review shows everything, including warnings for links and BCC', () => {
  const msg = buildOutgoing(account, { to: ['a@other.example'], bcc: ['b@example.com'], subject: 'S', body: 'see https://x.example/?q=ZXhmaWx0cmF0ZWQgZGF0YSBleGZpbHRyYXRlZCBkYXRhIGV4ZmlsdHJhdGVkIGRhdGE' });
  const r = renderForReview(msg, 'a');
  assert.match(r, /External recipients: a@other\.example/);
  assert.match(r, /BCC/);
  assert.match(r, /1 link/);
  assert.match(r, /unusually long/);
  assert.ok(r.includes(msg.text));
});

test('raw message is plain text only', async () => {
  const msg = buildOutgoing(account, { to: ['a@example.com'], subject: 'S', body: '<b>hi</b>' });
  const raw = (await buildRaw(msg)).toString();
  assert.match(raw, /Content-Type: text\/plain/i);
  assert.doesNotMatch(raw, /text\/html/i);
});
