// The forge's HTTP server: one in-memory Forge behind four surfaces — git smart HTTP, REST v3,
// GraphQL v4 and MCP — routed here. main.ts owns the entry <-> env lifecycle; this file is the whole
// application, and every answer carries the X-GitHub-Request-Id the protocol checks require.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { pathSegments, sendError, sendJson } from './web.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('x-github-request-id', forge.nextRequestId());
    void dispatch(forge, req, res).catch(() => {
      // A handler failure must never take the server down (the suite probes exactly that).
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    });
  });
  // The suite's read workload drives thousands of sequential requests over one pooled keep-alive
  // connection; a generous keep-alive timeout keeps that socket from ever churning mid-round.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}

/** Route one request to its surface. */
async function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return sendError(res, 400, 'Bad Request');
  }
  const segments = pathSegments(url);

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    return sendJson(res, 200, { ok: true });
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    return handleRest(forge, req, res, url, segments.slice(2));
  }
  if (segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') return sendError(res, 404, 'Not Found');
    return handleGraphQL(forge, req, res);
  }
  if (segments.length === 1 && segments[0] === 'mcp') {
    return handleMcp(forge, req, res);
  }
  if (await handleGit(forge, req, res, url, segments)) return;

  // Everything else, every method: GitHub's 404 body.
  return sendError(res, 404, 'Not Found');
}
