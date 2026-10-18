// HTTP surface for the PowerShell 7 setup dialog.
//
// Four exact routes, all owned by the plugin and registered on `ctx.webServer` when that service
// exists:
//
//   GET  /pwsh7/state    one JSON snapshot (initial render and polling fallback)
//   GET  /pwsh7/events   Server-Sent Events; every snapshot change, progress coalesced
//   POST /pwsh7/install  start (or join) the single install job
//   POST /pwsh7/cancel   abort the active download
//
// The dialog is same-origin, so these routes intentionally carry no CORS grant. POST bodies must
// be `application/json`, which makes a cross-site simple request fail the content-type check and a
// cross-site JSON request fail the browser's (unanswered) preflight. The extra Origin check keeps a
// misconfigured proxy from widening that.

import { SETUP_METHODS, SETUP_ROUTES } from './setup-service.mjs';

const MAX_BODY_BYTES = 4 * 1024;
const SSE_HEARTBEAT_MS = 15_000;

function jsonHeaders(extra = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, jsonHeaders({ 'content-length': Buffer.byteLength(body) }));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

function sendError(req, res, status, message) {
  sendJson(req, res, status, { ok: false, error: message });
}

/** Same-origin check for state-changing requests. A missing Origin is a same-origin caller/CLI. */
function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return true;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body is too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (text.trim().length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { status: 400 });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('request body must be a JSON object'), { status: 400 });
  }
  return parsed;
}

function errorText(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Build the four route handlers over one setup service.
 *
 * @param {ReturnType<import('./setup-service.mjs').createSetupService>} service
 * @param {{ logger?: { warn?: Function } }} [options]
 */
export function createSetupHandlers(service, options = {}) {
  const logger = options.logger;

  function state(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(req, res, 405, 'use GET');
      return;
    }
    try {
      sendJson(req, res, 200, service.snapshot());
    } catch (caught) {
      logger?.warn?.(`pwsh7-router: setup state route failed: ${errorText(caught)}`);
      sendError(req, res, 500, 'could not read the PowerShell 7 setup state');
    }
  }

  /**
   * Server-Sent Events. The first frame is the current snapshot; every later frame is a full
   * snapshot, so a client needs no delta handling and a reconnecting EventSource recovers.
   */
  function events(req, res) {
    if (req.method !== 'GET') {
      sendError(req, res, 405, 'use GET');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    res.flushHeaders?.();

    let closed = false;
    let heartbeat = null;

    const writeFrame = (snapshot) => {
      if (closed) return;
      try {
        res.write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`);
      } catch (caught) {
        logger?.warn?.(`pwsh7-router: setup event write failed: ${errorText(caught)}`);
        close();
      }
    };

    const unsubscribe = service.subscribe(writeFrame);

    function close() {
      if (closed) return;
      closed = true;
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      unsubscribe();
      try {
        res.end();
      } catch {
        // The socket may already be gone.
      }
    }

    try {
      writeFrame(service.snapshot());
    } catch (caught) {
      logger?.warn?.(`pwsh7-router: setup event baseline failed: ${errorText(caught)}`);
    }

    heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(': keep-alive\n\n');
      } catch {
        close();
      }
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    req.on('close', close);
    req.on('error', close);
    res.on?.('close', close);
    res.on?.('error', close);
  }

  async function install(req, res) {
    if (req.method !== 'POST') {
      sendError(req, res, 405, 'use POST');
      return;
    }
    if (!sameOrigin(req)) {
      sendError(req, res, 403, 'cross-origin install requests are not allowed');
      return;
    }
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      sendError(req, res, 415, 'send application/json');
      return;
    }
    try {
      const body = await readJsonBody(req);
      const method = typeof body.method === 'string' ? body.method : 'auto';
      if (!SETUP_METHODS.includes(method)) {
        sendError(req, res, 400, `unsupported method ${JSON.stringify(method)}`);
        return;
      }
      const outcome = service.start(method);
      sendJson(req, res, outcome.started ? 202 : 200, {
        ok: true,
        started: outcome.started,
        state: outcome.snapshot,
      });
    } catch (caught) {
      const status = Number.isInteger(caught?.status) ? caught.status : 400;
      sendError(req, res, status, errorText(caught));
    }
  }

  async function cancel(req, res) {
    if (req.method !== 'POST') {
      sendError(req, res, 405, 'use POST');
      return;
    }
    if (!sameOrigin(req)) {
      sendError(req, res, 403, 'cross-origin cancel requests are not allowed');
      return;
    }
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      sendError(req, res, 415, 'send application/json');
      return;
    }
    try {
      // Drain the (empty) body so keep-alive connections stay reusable.
      await readBody(req);
      sendJson(req, res, 200, { ok: true, state: service.cancel() });
    } catch (caught) {
      const status = Number.isInteger(caught?.status) ? caught.status : 400;
      sendError(req, res, status, errorText(caught));
    }
  }

  return { state, events, install, cancel };
}

/**
 * The `webServer.register()` rows for the setup surface.
 * @param {ReturnType<typeof createSetupHandlers>} handlers
 */
export function setupRouteRows(handlers) {
  return [
    { kind: 'exact', path: SETUP_ROUTES.state, handler: handlers.state },
    { kind: 'exact', path: SETUP_ROUTES.events, handler: handlers.events },
    { kind: 'exact', path: SETUP_ROUTES.install, handler: handlers.install },
    { kind: 'exact', path: SETUP_ROUTES.cancel, handler: handlers.cancel },
  ];
}
