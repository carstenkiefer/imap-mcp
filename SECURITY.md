# Security model

This server gives an AI assistant access to mailboxes, and mailboxes are full of content written by strangers. The design
assumes that **every email may contain a prompt-injection attack** and that the model may be tricked by it. The goal is
that a successful injection still cannot send mail on your behalf or leak data through the server.

## Background: CVE-2025-32711 ("EchoLeak")

EchoLeak was a zero-click vulnerability in Microsoft 365 Copilot (CVSS 9.3). An attacker sent an ordinary-looking email
containing hidden instructions. When the user later asked Copilot an unrelated question, the email was retrieved as
context, and the instructions made the model:

1. collect sensitive data from the user's other documents and mails (an "LLM scope violation": untrusted input steering
   access to privileged data),
2. place that data into the URL of a markdown image or reference-style link,
3. which the client then loaded automatically, delivering the data to an attacker-controlled server. Link redaction and
   content security policy were bypassed via reference-style markdown and allowed domains.

No user action beyond asking a question was needed.

## Guarantees

These hold regardless of what the model does, because they are enforced in code, not by instructions:

| # | Guarantee | How |
|---|---|---|
| G1 | **No email leaves without explicit human approval of that exact message.** | `send_email` only creates a frozen message. Delivery (`src/mailer.js`) is reachable only after an approval answer from the MCP elicitation dialog (which the client shows to the human; the model cannot produce it) or from `imap-mcp outbox send` typed by the human in an interactive terminal. No tool has a confirmation parameter. |
| G2 | **What you approve is what is sent.** | The message is validated and frozen before approval; the dialog shows all recipients (including BCC), subject and the complete body. |
| G3 | **No hidden content in outgoing mail.** | Plain text only, no HTML, no attachments, invisible Unicode characters (zero-width, bidi, tag characters, variation selectors) stripped, header injection impossible. The sender address is fixed by configuration. |
| G4 | **Sending is off by default** and can be limited to an allow list of recipients and a maximum recipient count, checked before you are asked and again at delivery. | `allowSend`, `allowedRecipients`, `maxRecipients` |
| G5 | **The server makes no network connections except to the configured IMAP/SMTP servers.** It never fetches URLs or images from emails. | No HTTP client in the code; images are dropped. |
| G6 | **Reading is non-destructive.** Folders are opened read-only (EXAMINE) and fetched with `BODY.PEEK`; there are no delete/move/flag tools. | `src/imap.js` |
| G7 | **Credentials never reach the model.** They are resolved only when connecting; errors are scrubbed. TLS with certificate validation is enforced (STARTTLS is mandatory when implicit TLS is off). | `src/config.js`, `src/imap.js` |

## Mitigations (defence in depth)

These reduce the chance that an injection succeeds or that leaked text is harmful, but they cannot be absolute:

- **Spotlighting.** All mailbox-derived text (bodies, subjects, sender names, folder and attachment names) is wrapped in
  `<<<UNTRUSTED_EMAIL_DATA id=…>>>` with a random nonce; attempts to fake the end marker are neutralised. The server's MCP
  instructions and tool descriptions tell the model to treat it strictly as data.
- **Hidden text removal.** HTML is converted to text after removing elements hidden from humans (`display:none`,
  `visibility:hidden`, `opacity:0`, `font-size:0`, zero height with overflow hidden, off-screen positioning,
  `mso-hide:all`, the `hidden` attribute), plus scripts, styles, comments, iframes, SVG etc. The model is told when
  something was removed, which is a strong signal of an attack.
- **Invisible character removal** in all incoming text (ASCII smuggling via Unicode tag characters, zero-width text,
  bidi overrides).
- **No active content for the client to render.** Markdown images become `[image: alt]`, markdown and reference links
  are flattened to text, `data:`/`javascript:` URIs are removed, and URLs are defanged (`hxxps[://]example[.]com`) by
  default. A model that echoes email content therefore does not emit something a client would auto-load.
- **Phishing hints**, e.g. when Reply-To differs from From.
- **Review warnings** in the approval dialog: external recipients, BCC, every URL in the body, long encoded-looking
  strings (a typical way to smuggle data out), and removed invisible characters.
- **Size limits** for downloaded messages and returned text.

## What this server cannot prevent

Be aware of these residual risks and configure your environment accordingly:

1. **Your MCP client rendering the model's own output.** If the model is manipulated into writing a markdown image with
   data in the URL *itself* (not copied from an email), a client that auto-loads images would fetch it. This is outside
   the server's control. Use clients that do not auto-load remote images in model output, or that ask first.
2. **Other tools in the same session.** If the assistant also has a web-fetch, HTTP, shell, or another messaging tool, an
   injection could try to use *that* to exfiltrate data. Require approval for such tools, or do not combine them with
   mailbox access in the same session.
3. **An agent with a shell on the same machine.** Such an agent could read the config file or credentials, talk SMTP
   directly, or fake an interactive terminal (e.g. with `script`) to drive `imap-mcp outbox send`. The terminal check
   stops ordinary non-interactive invocation, not a determined agent with full shell access. Use elicitation, keep
   credentials in environment variables of the MCP server process only, and do not give such agents unrestricted shell
   access.
4. **A client that auto-accepts elicitation requests.** The approval dialog is only as good as the client showing it.
   If in doubt, set `"approvalMode": "outbox"` so that every send goes through your terminal.
5. **You approving a malicious email.** Read the dialog. It shows everything that will be sent; pay attention to the
   warnings.
6. **Misleading summaries.** Injected text can still influence what the model tells you about an email (e.g. "this
   invoice is legitimate"). Sanitising cannot fix judgement; treat summaries of unknown senders' mail with care.

## Reporting a vulnerability

Please open a private security advisory in the GitHub repository rather than a public issue.
