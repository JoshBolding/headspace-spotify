/**
 * Tiny localhost HTTP server that catches Spotify's OAuth redirect.
 *
 * The user's browser is redirected to http://127.0.0.1:8888/callback?code=...&state=...
 * We respond with a small "you can close this tab" page, then close ourselves.
 */

import http from "node:http";

export interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
}

export function startCallbackServer(opts: {
  port: number;
  onResult: (result: CallbackResult) => void;
}): http.Server {
  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end();
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${opts.port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code") ?? undefined;
    const state = url.searchParams.get("state") ?? undefined;
    const error = url.searchParams.get("error") ?? undefined;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (error) {
      res.end(htmlPage("Sign-in failed", `Spotify returned: <code>${escapeHtml(error)}</code>.<br>You can close this tab.`));
    } else if (code) {
      res.end(htmlPage("Signed in", "Welcome back. You can close this tab and return to Headspace."));
    } else {
      res.end(htmlPage("Sign-in failed", "Missing code parameter. You can close this tab."));
    }

    opts.onResult({ code, state, error });
    // Close shortly so the response finishes flushing.
    setTimeout(() => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    }, 500);
  });
  server.listen(opts.port, "127.0.0.1");
  return server;
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — Headspace</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: radial-gradient(circle at center, #1f5d33 0%, #0d2410 70%);
    color: #c4ee72;
    font-family: Verdana, "Segoe UI", sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    text-align: center;
    padding: 56px 64px;
    border: 1px solid rgba(120, 220, 60, 0.4);
    background: rgba(6, 22, 0, 0.65);
    border-radius: 12px;
    box-shadow: 0 0 60px rgba(120, 220, 60, 0.15);
  }
  h1 { color: #b6e84a; margin: 0 0 16px; font-size: 28px; }
  p { font-size: 14px; opacity: 0.9; }
  code { background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}
