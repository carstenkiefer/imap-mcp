// Configuration loading and validation.

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const AuthSchema = z
  .object({
    user: z.string().min(1),
    password: z.string().optional(),
    passwordEnv: z.string().optional(),
    passwordFile: z.string().optional(),
    accessTokenEnv: z.string().optional(), // OAuth2 (XOAUTH2) access token
  })
  .refine((a) => a.password || a.passwordEnv || a.passwordFile || a.accessTokenEnv, {
    message: 'One of password, passwordEnv, passwordFile or accessTokenEnv is required',
  });

const ServerSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  secure: z.boolean().default(true), // implicit TLS (993 / 465)
  allowInsecure: z.boolean().default(false), // allow plaintext without STARTTLS – never in production
  rejectUnauthorized: z.boolean().default(true),
});

const AccountSchema = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'id may only contain letters, digits, _ and -'),
  name: z.string().optional(),
  imap: ServerSchema.extend({ auth: AuthSchema }),
  smtp: ServerSchema.extend({ auth: AuthSchema }).optional(),
  from: z.string().optional(), // "Name <addr>" – defaults to imap user
  allowSend: z.boolean().default(false),
  allowDrafts: z.boolean().default(true),
  allowedRecipients: z.array(z.string().min(1)).optional(), // e.g. ["*@example.com", "chef@partner.de"]
  maxRecipients: z.number().int().positive().max(100).default(10),
  draftsFolder: z.string().optional(),
  sentFolder: z.string().optional(),
  saveToSent: z.boolean().default(true),
});

const ConfigSchema = z.object({
  accounts: z.array(AccountSchema).min(1),
  security: z
    .object({
      urlMode: z.enum(['defang', 'remove', 'keep']).default('defang'),
      maxBodyChars: z.number().int().positive().default(20000),
      maxMessageBytes: z.number().int().positive().default(25 * 1024 * 1024),
      approvalMode: z.enum(['auto', 'outbox']).default('auto'),
      outboxDir: z.string().optional(),
      pendingTtlHours: z.number().positive().default(24),
    })
    .prefault({}),
});

export function defaultConfigPath() {
  if (process.env.IMAP_MCP_CONFIG) return resolve(process.env.IMAP_MCP_CONFIG);
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'imap-mcp', 'config.json');
}

export function defaultStateDir() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'imap-mcp');
}

export function loadConfig(path = defaultConfigPath()) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read configuration (${path}): ${err.code || err.message}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Configuration is not valid JSON (${path}): ${err.message}`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration (${path}):\n${issues}`);
  }
  const config = parsed.data;

  const ids = new Set();
  for (const acc of config.accounts) {
    if (ids.has(acc.id)) throw new Error(`Duplicate account id: ${acc.id}`);
    ids.add(acc.id);
    if (acc.allowSend && !acc.smtp) throw new Error(`Account ${acc.id}: allowSend requires an smtp configuration`);
  }

  // Warn (stderr – stdout belongs to the MCP protocol) about readable inline secrets.
  const hasInline = config.accounts.some((a) => a.imap.auth.password || a.smtp?.auth.password);
  if (hasInline && process.platform !== 'win32') {
    try {
      if (statSync(path).mode & 0o077) {
        process.stderr.write(
          `[imap-mcp] WARNING: ${path} contains passwords and is readable by other users. Run chmod 600 or use passwordEnv/passwordFile.\n`,
        );
      }
    } catch {
      /* ignore */
    }
  }

  config.security.outboxDir = resolve(config.security.outboxDir || join(defaultStateDir(), 'outbox'));
  config.path = path;
  return config;
}

/** Resolve credentials lazily so that secrets only live in memory when needed. */
export function resolveAuth(auth) {
  if (auth.accessTokenEnv) {
    const token = process.env[auth.accessTokenEnv];
    if (!token) throw new Error(`Environment variable ${auth.accessTokenEnv} is not set`);
    return { user: auth.user, accessToken: token };
  }
  if (auth.passwordEnv) {
    const pass = process.env[auth.passwordEnv];
    if (!pass) throw new Error(`Environment variable ${auth.passwordEnv} is not set`);
    return { user: auth.user, pass };
  }
  if (auth.passwordFile) {
    try {
      return { user: auth.user, pass: readFileSync(auth.passwordFile, 'utf8').replace(/\r?\n$/, '') };
    } catch (err) {
      throw new Error(`Cannot read password file: ${err.code || err.message}`);
    }
  }
  return { user: auth.user, pass: auth.password };
}

export function getAccount(config, id) {
  const acc = config.accounts.find((a) => a.id === id);
  if (!acc) throw new Error(`Unknown account "${id}". Available: ${config.accounts.map((a) => a.id).join(', ')}`);
  return acc;
}
