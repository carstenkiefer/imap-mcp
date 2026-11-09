// Streamable HTTP transport (for web clients such as Open WebUI).
//
// Security:
//  * a bearer token is mandatory (IMAP_MCP_HTTP_TOKEN, at least 32 characters),
//    compared in constant time,
//  * binds to 127.0.0.1 by default; exposing it on a network should be done
//    behind a TLS reverse proxy,
//  * request bodies are limited, sessions are capped and expire when idle.

import { createServer as createHttpServer } from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.js';

const MAX_BODY = 1024 * 1024;
const MAX_SESSIONS = 32;
const SESSION_IDLE_MS = 60 * 60_000;
export const MIN_TOKEN_LENGTH = 32;

const digest = (s) => createHash('sha256').update(String(s)).digest();

function authorized(req, token) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  return timingSafeEqual(digest(m[1].trim()), digest(token));
}

function sendJson(res, status, error) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: error }, id: null }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Start the HTTP server. Resolves with the node http.Server once listening.
 * @param {object} config loaded configuration
 * @param {{host?: string, port?: number, token: string, path?: string, log?: (msg: string) => void}} opts
 */
export function startHttpServer(config, { host = '127.0.0.1', port = 8808, token, path = '/mcp', log = () => {} }) {
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`An access token of at least ${MIN_TOKEN_LENGTH} characters is required (IMAP_MCP_HTTP_TOKEN). Generate one with: openssl rand -hex 32`);
  }

  /** @type {Map<string, {transport: StreamableHTTPServerTransport, server: any, lastSeen: number}>} */
  const sessions = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > SESSION_IDLE_MS) {
        sessions.delete(id);
        s.transport.close().catch(() => {});
      }
    }
  }, 60_000);
  sweep.unref();

  const http = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      if (url.pathname !== path) return sendJson(res, 404, 'Not found');
      if (!authorized(req, token)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return sendJson(res, 401, 'Unauthorized');
      }
      if (!['POST', 'GET', 'DELETE'].includes(req.method)) return sendJson(res, 405, 'Method not allowed');

      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const sessionId = req.headers['mcp-session-id'];
      let entry = sessionId ? sessions.get(String(sessionId)) : undefined;

      if (!entry) {
        if (sessionId) return sendJson(res, 404, 'Session not found');
        if (req.method !== 'POST' || !isInitializeRequest(body)) return sendJson(res, 400, 'No valid session');
        if (sessions.size >= MAX_SESSIONS) return sendJson(res, 503, 'Too many sessions');

        const server = createServer(config);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, entry);
            log(`session ${id.slice(0, 8)} opened (${sessions.size} active)`);
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        entry = { transport, server, lastSeen: Date.now() };
        await server.connect(transport);
      }

      entry.lastSeen = Date.now();
      await entry.transport.handleRequest(req, res, body);
    } catch (err) {
      sendJson(res, err.status || 500, err.status ? err.message : 'Internal error');
    }
  });

  http.on('close', () => {
    clearInterval(sweep);
    for (const s of sessions.values()) s.transport.close().catch(() => {});
    sessions.clear();
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => resolve(http));
  });
}
