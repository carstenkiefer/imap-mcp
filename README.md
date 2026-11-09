# imap-mcp

A small [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant read your IMAP mailboxes,
built with security as the first concern:

- **No email is ever sent without your explicit approval.** The assistant can only *request* a send. You see the complete
  message (recipients, subject, full text, warnings) and approve it yourself, either in an approval dialog shown by your
  MCP client or in your own terminal.
- **Built against prompt-injection exfiltration like [CVE-2025-32711 "EchoLeak"](https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711).**
  Email content is treated as untrusted data: hidden text, images, active links and invisible characters are removed or
  defanged before the model sees them. See [SECURITY.md](SECURITY.md) for the threat model.
- **Runs anywhere Node.js runs, including ARM** (Raspberry Pi, Apple Silicon, AWS Graviton). Pure JavaScript, no native
  modules, no build step.

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `list_accounts` | Configured accounts and their permissions | no |
| `list_folders` | Folders with message/unread counts | no |
| `list_messages` | Newest messages in a folder (envelope only) | no |
| `search_messages` | Server-side search (from, to, subject, text, date range, unread, flagged) | no |
| `read_message` | One message as sanitised plain text; attachments listed, not returned | no |
| `create_draft` | Saves a plain-text draft in the Drafts folder | Drafts folder only |
| `send_email` | Requests sending a plain-text email; **only sent after you approve it** | after approval |

The server opens folders read-only and fetches with `BODY.PEEK`, so reading never marks messages as read. There are no
tools to delete, move or flag messages.

## Requirements

- Node.js 20 or newer (`node --version`). On a Raspberry Pi or other ARM Linux machine, install Node from your
  distribution, from [nodejs.org](https://nodejs.org/en/download) (ARM64/ARMv7 builds), or with `nvm`.
- An IMAP account (and SMTP, if you want to send).

## Installation

```bash
git clone https://github.com/carstenkiefer/imap-mcp.git
```

```bash
cd imap-mcp && npm ci --omit=dev
```

## Configuration

The configuration file is read from `~/.config/imap-mcp/config.json`, or from the path in the `IMAP_MCP_CONFIG`
environment variable. Start from the example:

```bash
mkdir -p ~/.config/imap-mcp && cp config.example.json ~/.config/imap-mcp/config.json && chmod 600 ~/.config/imap-mcp/config.json
```

### Accounts

| Key | Default | Meaning |
|---|---|---|
| `id` | – | Short identifier the assistant uses (`[A-Za-z0-9_-]`) |
| `name` | – | Optional display name |
| `from` | IMAP user | Sender address for drafts and sent mail. The assistant cannot change it. |
| `imap` / `smtp` | – | `host`, `port`, `secure` (implicit TLS, default `true`), `auth` |
| `imap.secure: false` | – | Uses STARTTLS, which is then **required**. Plaintext needs `allowInsecure: true` (testing only). |
| `rejectUnauthorized` | `true` | Certificate validation. Leave it on. |
| `allowDrafts` | `true` | Allow `create_draft` |
| `allowSend` | `false` | Allow `send_email` (always with approval). Requires `smtp`. |
| `allowedRecipients` | any | Optional allow list, e.g. `["*@example.com", "boss@partner.example"]`. Other recipients are rejected before you are even asked. |
| `maxRecipients` | `10` | Maximum To + Cc + Bcc |
| `draftsFolder` / `sentFolder` | auto | Detected via SPECIAL-USE; set them if detection fails |
| `saveToSent` | `true` | Store a copy of sent mail in the Sent folder |

### Credentials

Prefer not to put passwords into the config file. In `auth` use one of:

- `"passwordEnv": "VAR"` – the password is read from an environment variable (recommended),
- `"passwordFile": "/path/to/file"` – the password is read from a file (e.g. a Docker/systemd secret),
- `"accessTokenEnv": "VAR"` – OAuth2 access token (XOAUTH2), e.g. for Microsoft 365 or Gmail,
- `"password": "..."` – inline; the server warns if the file is readable by other users.

For Gmail, Microsoft 365 and other providers with 2FA, use an app password or OAuth2 token.

### Security options

| Key | Default | Meaning |
|---|---|---|
| `urlMode` | `defang` | How URLs in email content are shown to the model: `defang` (`hxxps[://]example[.]com`), `remove`, or `keep` (not recommended) |
| `maxBodyChars` | `20000` | Maximum body length returned to the model |
| `maxMessageBytes` | `26214400` | Larger messages are not downloaded |
| `approvalMode` | `auto` | `auto`: approval dialog if the client supports it, otherwise outbox. `outbox`: always approve in the terminal. |
| `outboxDir` | `~/.local/state/imap-mcp/outbox` | Where emails waiting for approval are kept (mode 0600) |
| `pendingTtlHours` | `24` | Unapproved emails expire after this time |

Check the configuration and logins:

```bash
WORK_MAIL_PASSWORD='…' node bin/imap-mcp.js check
```

## Connecting an MCP client

The server speaks MCP over stdio. Example for Claude Desktop (`claude_desktop_config.json`) or any client with the same
format:

```json
{
  "mcpServers": {
    "imap": {
      "command": "node",
      "args": ["/absolute/path/to/imap-mcp/bin/imap-mcp.js"],
      "env": { "WORK_MAIL_PASSWORD": "…" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add imap -e WORK_MAIL_PASSWORD='…' -- node /absolute/path/to/imap-mcp/bin/imap-mcp.js
```

## Sending email: how approval works

1. You ask the assistant to send an email. It calls `send_email`.
2. The server validates the message (allowed account, recipients on the allow list, no attachments, plain text only,
   invisible characters stripped) and freezes it.
3. Approval:
   - **Approval dialog (preferred).** If your MCP client supports [elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation),
     it shows you the complete email with warnings (external recipients, BCC, links, suspicious encoded strings). Only
     if you tick "Yes, send this email now" and accept is it sent. Declining, cancelling or accepting without the tick
     sends nothing.
   - **Terminal (fallback).** Otherwise the email is placed in the local outbox and the assistant tells you its id. You
     review and send it yourself:

     ```bash
     node bin/imap-mcp.js outbox
     ```

     ```bash
     node bin/imap-mcp.js outbox send <id>
     ```

     The command shows the full email and sends only after you type `send`. It refuses to run without an interactive
     terminal. `outbox show <id>` and `outbox discard <id>` are also available.

No tool takes a "confirm" parameter: anything the model can pass, an injected instruction can pass too.

If you want the assistant to prepare emails but never send, leave `allowSend` at `false` and use drafts: you then send
from your normal mail client.

## Running as a service / on a Raspberry Pi

The server is started by the MCP client on demand, so usually no service is needed. To run it on a different
machine than the client, use any stdio-over-SSH setup, e.g. `"command": "ssh", "args": ["pi@raspberrypi", "node", "/home/pi/imap-mcp/bin/imap-mcp.js"]`.
The approval dialog still appears in your client; the terminal fallback then runs on the Pi.

## Development

```bash
npm ci
```

```bash
npm test
```

The tests start local IMAP and SMTP servers and drive the server through a real MCP client, including approval,
rejection and prompt-injection cases.

## Limitations

- Attachments are listed but their content is not returned, and outgoing mail cannot carry attachments.
- Outgoing mail is plain text only.
- Hidden-text detection covers the common CSS techniques (display, visibility, opacity, font-size, zero height,
  off-screen positioning, `mso-hide`). Text coloured like its background is not detected.
- Prompt injection cannot be ruled out completely by any tool – see [SECURITY.md](SECURITY.md) for what is guaranteed and
  what is not.
