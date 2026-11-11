<img src="docs/logo.png" alt="imap-mcp logo" width="96" align="right">

# imap-mcp<br>Secure MCP server for IMAP mailboxes

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/G2G4KXS8L)

A small [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant read your IMAP mailboxes,
built with security as the first concern:

- **No email is ever sent or forwarded without your explicit approval.** The assistant can only *request* it. You see
  everything that will go out (recipients, subject, full text or the list of forwarded messages with their attachments,
  warnings) and approve it yourself, either in an approval dialog shown by your MCP client or in your own terminal.
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
| `search_messages` | Server-side search (from, to, subject, text, date range, unread, flagged, has attachments, not yet forwarded) | no |
| `read_message` | One message as sanitised plain text; attachments listed, not returned | no |
| `create_draft` | Saves a plain-text draft in the Drafts folder | Drafts folder only |
| `send_email` | Requests sending a plain-text email; **only sent after you approve it** | after approval |
| `forward_messages` | Requests forwarding existing messages with their original attachments to allow-listed recipients; **only sent after you approve the batch** | after approval |

The server opens folders read-only and fetches with `BODY.PEEK`, so reading never marks messages as read. There are no
tools to delete or move messages. The only flag the server ever sets is `$Forwarded` on messages you approved for
forwarding.

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
| `allowForward` | `false` | Allow `forward_messages` (always with approval). Requires `smtp` and `forwardRecipients`. Independent of `allowSend`. |
| `forwardRecipients` | – | **Mandatory** allow list for forwarding, e.g. `["buha@example.de"]`. Same pattern syntax as `allowedRecipients`. |
| `markForwarded` | `true` | Set the `$Forwarded` flag on forwarded originals, so they are not forwarded twice |
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

The server speaks MCP over stdio by default (Streamable HTTP for web clients: see [Open WebUI](#open-webui)). Example for Claude Desktop (`claude_desktop_config.json`) or any client with the same
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

## Open WebUI

[Open WebUI](https://docs.openwebui.com/features/mcp) (v0.6.31 or later) connects to MCP servers natively over
Streamable HTTP, including the approval dialog (MCP elicitation). Run imap-mcp in HTTP mode:

```bash
export IMAP_MCP_HTTP_TOKEN="$(openssl rand -hex 32)"
```

```bash
node bin/imap-mcp.js http --host 127.0.0.1 --port 8808
```

The endpoint is `http://<host>:8808/mcp`. A bearer token of at least 32 characters is mandatory. The server listens on
`127.0.0.1` unless told otherwise.

In Open WebUI, go to **Admin Settings → External Tools** (in some versions **Settings → Admin → Integrations**) and add a
connection:

| Field | Value |
|---|---|
| Type | **MCP (Streamable HTTP)** (not OpenAPI) |
| URL | `http://imap-mcp:8808/mcp` (same Docker network), `http://host.docker.internal:8808/mcp` (Open WebUI in Docker, imap-mcp on the host), or `http://127.0.0.1:8808/mcp` (both on the host) |
| Auth | **Bearer**, key = the value of `IMAP_MCP_HTTP_TOKEN` |

Then enable the tool in a chat via **+ → Tools**.

**Restrict access.** Use the connection's **Access Control** so that only you (or your group) can use it. Anyone who can
use the tool can read the configured mailboxes, and the approval dialog for a send or forward is shown to whoever
triggered it.

**Approvals in Open WebUI.** Open WebUI shows the approval as a form in the chat. The dialog only appears while the chat is
open in a browser tab, and it is cancelled after 120 seconds. A cancelled or timed-out dialog sends nothing. To approve
in the terminal instead, set `"approvalMode": "outbox"` and run `imap-mcp outbox send <id>` on the machine running
imap-mcp. With Docker, use `docker compose exec -it imap-mcp node bin/imap-mcp.js outbox send <id>`.

**Docker.** A multi-arch `Dockerfile` (amd64 and ARM) and [`docker-compose.example.yml`](docker-compose.example.yml) are
included. The compose example runs imap-mcp and Open WebUI on a private network. The MCP port is not published to the
host, and the outbox is stored in a volume. If imap-mcp runs on the host and Open WebUI runs in Docker on Linux, bind
imap-mcp to the Docker bridge address (e.g. `--host 172.17.0.1`) rather than `0.0.0.0`. Start Open WebUI with
`--add-host=host.docker.internal:host-gateway`.

Never expose the port to the internet. If Open WebUI runs on another machine, put a TLS reverse proxy in front.

**Alternative: mcpo.** Older Open WebUI versions can use the [mcpo](https://github.com/open-webui/mcpo) proxy with the
stdio server (`mcpo --port 8000 --api-key … -- node bin/imap-mcp.js`, added as an OpenAPI connection). mcpo cannot show
approval dialogs, so every send or forward goes to the outbox and you approve it in the terminal.

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

## Forwarding invoices to an accounting inbox

Typical request: *"Find all emails with invoices from DPD and forward them to my accounting inbox buha@example.de."*

1. Allow forwarding to exactly that address only, and keep free-form sending off if you do not need it:

   ```json
   "allowSend": false,
   "allowForward": true,
   "forwardRecipients": ["buha@example.de"]
   ```

2. Ask the assistant. It searches (e.g. `from: "dpd"`, `has_attachments: true`, `exclude_forwarded: true`), checks
   senders, subjects and attachment names, and calls `forward_messages` once with all matching UIDs.
3. You get **one** approval for the whole batch, listing every message (date, sender, subject, attachment names and
   sizes), the recipient and the optional note. Approve, and one email per invoice is sent.
4. The originals are flagged `$Forwarded` (your mail client shows them as forwarded). Next month, the same request with
   `exclude_forwarded` only picks up new invoices.

Two modes are available:

- `inline` (default): the original text plus the original attachments (e.g. the PDF). Works best with accounting
  systems that import email attachments (DATEV, Lexoffice, sevDesk, GetMyInvoices, …).
- `attachment`: the complete original email attached unchanged as `.eml`, for maximum fidelity or when the invoice is
  in the email body itself.

Even if a malicious email tricks the assistant, forwarded mail can only reach the addresses in `forwardRecipients`, and
only after you approve it.

## Running as a systemd service

In stdio mode the MCP client starts the server on demand, so no service is needed. For HTTP mode (Open WebUI), a
hardened systemd unit is provided in [`contrib/systemd/`](contrib/systemd). It runs the server as a dedicated system
user, without access to home directories, with a read-only file system except for its state directory, and with
secrets kept out of the configuration file.

| Path | Content | Owner / mode |
|---|---|---|
| `/opt/imap-mcp` | Code | root, world-readable |
| `/etc/imap-mcp/config.json` | Configuration (`passwordEnv` only, no inline passwords) | `root:imap-mcp` 0640 |
| `/etc/imap-mcp/imap-mcp.env` | `IMAP_MCP_HTTP_TOKEN` and the mail passwords | `root:root` 0600 |
| `/var/lib/imap-mcp` | Outbox (created by systemd) | `imap-mcp` 0700 |

Node.js must be installed system-wide (distribution package or [NodeSource](https://github.com/nodesource/distributions)).
A Node installed with `nvm` in a home directory is not visible to the service. Check the path with `command -v node`. If
it is not `/usr/bin/node`, adjust `ExecStart` in the unit and `NODE` in `imap-mcp-outbox`.

1. Create the service user and install the code:

   ```bash
   sudo useradd --system --home-dir /var/lib/imap-mcp --shell /usr/sbin/nologin imap-mcp
   ```

   ```bash
   sudo git clone https://github.com/carstenkiefer/imap-mcp.git /opt/imap-mcp
   ```

   ```bash
   cd /opt/imap-mcp && sudo npm ci --omit=dev
   ```

2. Install configuration and secrets:

   ```bash
   sudo install -d -m 0750 -o root -g imap-mcp /etc/imap-mcp
   ```

   ```bash
   sudo install -m 0640 -o root -g imap-mcp /opt/imap-mcp/config.example.json /etc/imap-mcp/config.json
   ```

   ```bash
   sudo install -m 0600 -o root -g root /opt/imap-mcp/contrib/systemd/imap-mcp.env.example /etc/imap-mcp/imap-mcp.env
   ```

   Edit both files (`sudoedit /etc/imap-mcp/config.json`, `sudoedit /etc/imap-mcp/imap-mcp.env`). Set the token to the
   output of `openssl rand -hex 32`. Every `passwordEnv` name in the configuration needs a line in the env file.

3. Install and start the service:

   ```bash
   sudo install -m 0644 /opt/imap-mcp/contrib/systemd/imap-mcp.service /etc/systemd/system/
   ```

   ```bash
   sudo install -m 0755 /opt/imap-mcp/contrib/systemd/imap-mcp-outbox /usr/local/bin/
   ```

   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now imap-mcp
   ```

4. Check it:

   ```bash
   systemctl status imap-mcp
   ```

   ```bash
   curl http://127.0.0.1:8808/health
   ```

   ```bash
   journalctl -u imap-mcp -f
   ```

Then add `http://127.0.0.1:8808/mcp` in Open WebUI as described in [Open WebUI](#open-webui).

**Approving in the terminal.** `imap-mcp-outbox` runs the outbox commands as the service user, with the service's
configuration and secrets:

```bash
imap-mcp-outbox
```

```bash
imap-mcp-outbox send <id>
```

**Updating:**

```bash
cd /opt/imap-mcp && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart imap-mcp
```

**If the service does not start**, `journalctl -u imap-mcp` shows the reason. A missing token or password is reported
there by name. If a hardening option conflicts with your system, put an override in
`sudo systemctl edit imap-mcp` instead of changing the unit file.

### Running on another machine via SSH (stdio)

To use stdio mode on a different machine than the client, use any stdio-over-SSH setup, e.g.
`"command": "ssh", "args": ["pi@raspberrypi", "node", "/home/pi/imap-mcp/bin/imap-mcp.js"]`. The approval dialog still
appears in your client. The terminal fallback then runs on the Pi.

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

- Attachments are listed but their content is not returned to the model. Emails written by the assistant cannot carry
  attachments; only forwards carry the original message's attachments.
- Outgoing mail is plain text only (forwards in `attachment` mode keep the original unchanged).
- At most 50 messages per forward request.
- Hidden-text detection covers the common CSS techniques (display, visibility, opacity, font-size, zero height,
  off-screen positioning, `mso-hide`). Text coloured like its background is not detected.
- Prompt injection cannot be ruled out completely by any tool – see [SECURITY.md](SECURITY.md) for what is guaranteed and
  what is not.

## License

[MIT](LICENSE)
