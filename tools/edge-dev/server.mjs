#!/usr/bin/env node
// Local stand-in for the games edge Worker. Serves a storage root laid out as in
// plans/games/API.md section 1, with the routing and headers of edge/src/core.mjs.
//
//   node tools/edge-dev/server.mjs --root <dir> [--port 8790]
//
//   http://<slug>.localhost:8790/            live build (kv.json "live:<slug>")
//   http://pr-<n>--<slug>.localhost:8790/    PR preview (kv.json "pr:<n>" -> pending/<uploadId>)
//   http://up-<id>--<slug>.localhost:8790/   upload preview (pending/<id>, 24 hours)
//   http://localhost:8790/__host?slug=<slug>[&prefix=pr-<n>][&log=1]
//                                            a test host page that frames the game and answers the SDK
//
// Env: FRAME_ANCESTORS (default "http://localhost:3000 http://localhost:3300 https://degenhive.ai";
// this server's own origin is always added so /__host can frame games).
import { createServer } from "node:http";
import { readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "../../edge/src/core.mjs";
import { libraryIndex } from "../../scripts/lib/cdn.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const DEFAULT_SDK = resolve(HERE, "../../packages/sdk/dist/sdk.js");
const RULES = resolve(HERE, "../../rules/static-rules.json");
export const DEFAULT_FRAME_ANCESTORS = "http://localhost:3000 http://localhost:3300 https://degenhive.ai";
const REPORT_PATH = "/__dh/csp-report";
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_REPORTS = 500;

function fileStore(root, sdkPath) {
  const abs = (key) => {
    const p = resolve(root, key);
    if (p !== root && !p.startsWith(root + sep)) throw new Error(`key escapes the root: ${key}`);
    return p;
  };
  return {
    async kv(key) {
      const f = join(root, "kv.json");
      if (!existsSync(f)) return null;
      try {
        const v = JSON.parse(readFileSync(f, "utf8"))[key];
        return v === undefined || v === null ? null : String(v);
      } catch {
        return null;
      }
    },
    async text(key) {
      const p = abs(key);
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    },
    async object(key, range) {
      const p = abs(key);
      if (!existsSync(p)) return null;
      if (!range) return { body: readFileSync(p) };
      const buf = Buffer.alloc(range.length);
      const fd = openSync(p, "r");
      try {
        const n = readSync(fd, buf, 0, range.length, range.offset);
        return { body: buf.subarray(0, n) };
      } finally {
        closeSync(fd);
      }
    },
    async sdk() {
      return existsSync(sdkPath) ? readFileSync(sdkPath, "utf8") : null;
    },
  };
}

function readBody(req, limit) {
  return new Promise((res) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n <= limit) chunks.push(c);
    });
    req.on("end", () => res(n <= limit ? Buffer.concat(chunks).toString("utf8") : null));
    req.on("error", () => res(null));
  });
}

function isBareHost(host) {
  const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

function indexPage(root) {
  let kv = {};
  try {
    kv = JSON.parse(readFileSync(join(root, "kv.json"), "utf8"));
  } catch {
    // no kv.json yet
  }
  const rows = Object.keys(kv)
    .filter((k) => k.startsWith("live:"))
    .map((k) => k.slice(5))
    .sort()
    .map((s) => `<li><a href="/__host?slug=${s}&log=1">${s}</a> (${kv["off:" + s] ? "off" : "live"})</li>`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>edge-dev</title><body style="font:14px system-ui;padding:24px">
<h1 style="font-size:18px">edge-dev</h1><p>Root: <code>${root.replace(/</g, "&lt;")}</code></p><ul>${rows || "<li>No live games in kv.json</li>"}</ul></body>`;
}

/**
 * Starts the server. Resolves to { server, port, origin, reports, close() }.
 * reports collects CSP reports posted by games (report-uri), newest last.
 */
export function startEdgeDev({
  root,
  port = 8790,
  host = "127.0.0.1",
  frameAncestors = process.env.FRAME_ANCESTORS || DEFAULT_FRAME_ANCESTORS,
  sdkPath = DEFAULT_SDK,
  cspReport = true,
  quiet = true,
} = {}) {
  const rootAbs = resolve(root);
  const store = fileStore(rootAbs, sdkPath);
  const hostPage = readFileSync(join(HERE, "host.html"), "utf8");
  const reports = [];
  let selfOrigin = "";
  const libIndex = libraryIndex(JSON.parse(readFileSync(RULES, "utf8")).libraries);

  const onRequest = async (req, res) => {
    try {
      const hostHeader = req.headers.host || "";
      const url = new URL(req.url, `http://${hostHeader || "localhost"}`);

      if (req.method === "POST" && url.pathname === REPORT_PATH) {
        const body = await readBody(req, MAX_REPORT_BYTES);
        if (body !== null && reports.length < MAX_REPORTS) {
          try {
            const j = JSON.parse(body);
            for (const r of Array.isArray(j) ? j : [j]) reports.push({ host: hostHeader, at: Date.now(), report: r["csp-report"] || r.body || r });
          } catch {
            // not JSON: ignore
          }
        }
        res.writeHead(204).end();
        return;
      }

      if (isBareHost(hostHeader)) {
        if (url.pathname === "/__host") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          res.end(hostPage);
        } else if (url.pathname === "/__dh/reports") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(reports));
        } else if (url.pathname === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(indexPage(rootAbs));
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found\n");
        }
        return;
      }

      const env = {
        GAME_DOMAIN: "localhost",
        PREVIEW_DOMAIN: "localhost",
        FRAME_ANCESTORS: `${frameAncestors} ${selfOrigin}`.trim(),
        CSP_REPORT_URI: cspReport ? REPORT_PATH : undefined,
      };
      const out = await handle(
        { method: req.method, url: `http://${hostHeader}${req.url}`, headers: { get: (n) => req.headers[n.toLowerCase()] ?? null } },
        env,
        store,
        { libIndex },
      );
      res.writeHead(out.status, out.headers);
      if (out.body === null || out.body === undefined) res.end();
      else res.end(typeof out.body === "string" ? out.body : Buffer.from(out.body));
      if (!quiet) console.log(`${out.status} ${req.method} http://${hostHeader}${req.url}`);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Server error\n");
    }
  };

  // Browsers may resolve <slug>.localhost to ::1 or to 127.0.0.1, so listen on both loopbacks
  // with the same port. Another process holding the port on either one is an error.
  const listen = (srv, p, h) =>
    new Promise((ok, fail) => {
      srv.once("error", fail);
      srv.listen(p, h, () => {
        srv.off("error", fail);
        ok(srv.address().port);
      });
    });
  const closeAll = (servers) => Promise.all(servers.map((s) => new Promise((r) => (s.listening ? s.close(() => r()) : r()))));

  return (async () => {
    const hosts = host === "127.0.0.1" ? ["127.0.0.1", "::1"] : [host];
    for (let attempt = 0; attempt < 10; attempt++) {
      const servers = [];
      try {
        const first = createServer(onRequest);
        servers.push(first);
        const actual = await listen(first, port, hosts[0]);
        for (const h of hosts.slice(1)) {
          const s = createServer(onRequest);
          servers.push(s);
          try {
            await listen(s, actual, h);
          } catch (e) {
            if (e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT") continue; // no IPv6 here
            throw e;
          }
        }
        selfOrigin = `http://localhost:${actual}`;
        return {
          server: first,
          servers,
          port: actual,
          origin: selfOrigin,
          reports,
          close: () => closeAll(servers),
        };
      } catch (e) {
        await closeAll(servers);
        if (e.code !== "EADDRINUSE" || port !== 0) throw e;
      }
    }
    throw new Error("could not find a free port on both loopback addresses");
  })();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { parseArgs } = await import("../../scripts/lib/args.mjs");
  const args = parseArgs();
  const root = args.root || process.env.GAMES_STORAGE_DIR;
  if (!root) {
    console.error("usage: node tools/edge-dev/server.mjs --root <dir> [--port 8790]");
    process.exit(2);
  }
  const dev = await startEdgeDev({ root, port: Number(args.port || 8790), host: args.host || "127.0.0.1", quiet: !args.verbose });
  console.log(`edge-dev on ${dev.origin} serving ${resolve(root)}`);
  console.log(`  live:    http://<slug>.localhost:${dev.port}/`);
  console.log(`  preview: http://pr-<n>--<slug>.localhost:${dev.port}/  http://up-<id>--<slug>.localhost:${dev.port}/`);
  console.log(`  host:    ${dev.origin}/__host?slug=<slug>&log=1`);
  if (!existsSync(DEFAULT_SDK)) console.log("  note: packages/sdk/dist/sdk.js is missing; /__dh/sdk.js serves a stub");
}
