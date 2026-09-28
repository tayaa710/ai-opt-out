// Local HTTPS server that stands in for real service hosts (chatgpt.com, …).
// Playwright's context.route() does not intercept tabs the extension opens
// itself (chrome.tabs.create), so instead Chromium resolves the fake hosts to
// this server (--host-resolver-rules) and accepts its throwaway certificate.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

export const FAKE_HOSTS = Object.freeze([
  'chatgpt.com',
  'openai.com',
  'claude.ai',
  'x.com',
  'linkedin.com',
  'www.linkedin.com',
  'auth.example.test',
]);

const STUB_PAGE = '<!doctype html><title>Stub</title><p>Stub settings page</p>';

function makeCert(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=notrain-test',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

/**
 * @returns {Promise<{ port: number, args: string[], set: (host: string, handler: Function) => void,
 *   reset: () => void, close: () => Promise<void> }>}
 * A handler receives `{ url: URL, method }` and returns `{ status?, headers?, contentType?, body? }`.
 */
export async function startFakeSites() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notrain-fake-sites-'));
  const handlers = new Map();
  const server = https.createServer(makeCert(dir), async (req, res) => {
    const host = String(req.headers.host || '')
      .split(':')[0]
      .toLowerCase();
    const url = new URL(req.url, `https://${host}`);
    const handler = handlers.get(host);
    let out = { status: 200, contentType: 'text/html', body: STUB_PAGE };
    if (handler) out = (await handler({ url, method: req.method })) ?? out;
    res.writeHead(out.status ?? 200, {
      'content-type': out.contentType ?? 'text/html',
      ...(out.headers ?? {}),
    });
    res.end(out.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const rules = FAKE_HOSTS.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(', ');
  return {
    port,
    args: [`--host-resolver-rules=${rules}`, '--ignore-certificate-errors', '--no-proxy-server'],
    set: (host, handler) => handlers.set(host, handler),
    reset: () => handlers.clear(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

/** Resolves with the first page (existing or future) whose URL starts with `prefix`. */
export async function waitForPageUrl(context, prefix, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const page = context.pages().find((p) => p.url().startsWith(prefix));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No page with URL starting ${prefix} within ${timeout} ms`);
}
