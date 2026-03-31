/**
 * Gateway Server — HTTP endpoint for the shared Telegram bot gateway.
 *
 * Receives messages forwarded by agent_ops/gateway, stores them in SQLite,
 * registers a group for the client if needed, and waits for the agent
 * container to process and respond.
 *
 * Implements the Channel interface so NanoClaw's message loop can route
 * agent responses back through this server to the waiting HTTP request.
 *
 * Endpoint: POST /api/gateway/message
 * Request:  { clientSlug, chatId, sender, text, timestamp, channel }
 * Response: { text, sessionId }
 */

import http from 'http';

import { ASSISTANT_NAME } from './config.js';
import { logger } from './logger.js';
import { Channel } from './types.js';

// ── Response promise tracking ────────────────────────────────────────────────

// When the agent responds via sendMessage(), we resolve the waiting HTTP request.
// Key: chatJid (gw:{clientSlug}), Value: resolve function for the response.
const pendingResponses = new Map<
  string,
  { resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> }
>();

// How long to wait for the agent to respond before timing out
const RESPONSE_TIMEOUT_MS = 120_000; // 2 minutes

// ── Gateway Channel ──────────────────────────────────────────────────────────

/**
 * Virtual channel for gateway-routed messages.
 * sendMessage() resolves the pending HTTP response instead of sending to Telegram.
 */
export class GatewayChannel implements Channel {
  name = 'gateway';

  async connect(): Promise<void> {
    // No-op — gateway channel doesn't need persistent connections
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const pending = pendingResponses.get(jid);
    if (pending) {
      clearTimeout(pending.timer);
      pendingResponses.delete(jid);
      pending.resolve(text);
    } else {
      // Agent responded but nobody is waiting (timeout already fired).
      // Log it so we can see if timeouts are too aggressive.
      logger.debug({ jid, textLength: text.length }, 'Gateway response with no waiting request');
    }
  }

  isConnected(): boolean {
    return true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gw:');
  }

  async disconnect(): Promise<void> {
    // Clear all pending responses
    for (const [jid, pending] of pendingResponses) {
      clearTimeout(pending.timer);
      pending.resolve('');
      pendingResponses.delete(jid);
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // No-op — the external gateway handles typing indicators
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface GatewayDeps {
  storeMessage: (msg: {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
  }) => void;
  storeChatMetadata: (
    jid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  ensureGroup: (jid: string, clientSlug: string) => void;
  enqueueMessage: (jid: string) => void;
  pipeMessage: (jid: string, formatted: string) => boolean;
}

// ── HTTP Server ──────────────────────────────────────────────────────────────

export function startGatewayServer(
  port: number,
  deps: GatewayDeps,
): http.Server {
  const server = http.createServer((req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pending: pendingResponses.size }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/gateway/message') {
      handleMessage(req, res, deps).catch((err) => {
        logger.error({ err }, 'Gateway endpoint error');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Gateway server listening');
    console.log(`  Gateway server: http://0.0.0.0:${port}/api/gateway/message`);
  });

  return server;
}

async function handleMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: GatewayDeps,
): Promise<void> {
  // Read body
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', resolve);
    req.on('error', reject);
  });

  let body: {
    clientSlug: string;
    chatId: number;
    sender: string;
    text: string;
    timestamp?: string;
    channel?: string;
  };

  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  // Validate
  if (!body.clientSlug || !body.text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'clientSlug and text are required' }));
    return;
  }

  // Sanitize client slug
  const clientSlug = body.clientSlug.replace(/[^a-z0-9-]/g, '').slice(0, 100);
  if (!clientSlug) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid clientSlug' }));
    return;
  }

  const chatJid = `gw:${clientSlug}`;
  const timestamp = body.timestamp || new Date().toISOString();
  const messageId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const senderName = body.sender || 'User';

  // Ensure group exists for this client
  deps.ensureGroup(chatJid, clientSlug);

  // Store chat metadata
  deps.storeChatMetadata(chatJid, timestamp, clientSlug, 'gateway', true);

  // Prepend trigger so the message loop processes it without waiting for @mention
  const content = `@${ASSISTANT_NAME} ${body.text}`;

  // Store message
  deps.storeMessage({
    id: messageId,
    chat_jid: chatJid,
    sender: String(body.chatId || clientSlug),
    sender_name: senderName,
    content,
    timestamp,
    is_from_me: false,
  });

  logger.info(
    { clientSlug, chatJid, sender: senderName },
    'Gateway message stored',
  );

  // Set up response promise — we'll wait for the agent to call sendMessage()
  const responsePromise = new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(chatJid);
      resolve(''); // Empty response on timeout
    }, RESPONSE_TIMEOUT_MS);

    pendingResponses.set(chatJid, { resolve, timer });
  });

  // Trigger processing — try to pipe to active container first
  const formatted = `<messages>\n<message sender="${senderName}" time="${timestamp}">@${ASSISTANT_NAME} ${body.text}</message>\n</messages>`;
  if (!deps.pipeMessage(chatJid, formatted)) {
    deps.enqueueMessage(chatJid);
  }

  // Wait for agent response
  const responseText = await responsePromise;

  if (!responseText) {
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Agent response timeout', text: '' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ text: responseText }));
}
