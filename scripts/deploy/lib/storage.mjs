// Where deploy writes: the Cloudflare account (R2 over its S3 API, KV over the REST API) or a
// local storage root (plans/games/API.md section 1).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { signRequest, encodePath } from "./sigv4.mjs";
import { setKv } from "../../lib/local-store.mjs";

const CF_API = "https://api.cloudflare.com/client/v4";

async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e.retry === false) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw last;
}

function httpError(what, res, text) {
  const e = new Error(`${what}: HTTP ${res.status} ${String(text || "").slice(0, 300)}`);
  e.retry = res.status === 429 || res.status >= 500;
  return e;
}

export class LocalStorage {
  constructor(root) {
    this.root = resolve(root);
    this.kind = "local";
  }
  path(key) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error(`key escapes the root: ${key}`);
    return p;
  }
  async has(key) {
    return existsSync(this.path(key));
  }
  async put(key, body) {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, body);
    renameSync(tmp, p);
  }
  async kvPut(key, value) {
    setKv(this.root, key, value);
  }
  async kvDelete(key) {
    setKv(this.root, key, null);
  }
  describe() {
    return `local root ${this.root}`;
  }
}

/**
 * R2 through its S3-compatible API and KV through the Cloudflare REST API.
 * S3 credentials come from R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY, or are derived from the API
 * token as Cloudflare documents it: access key id = the token's id, secret = sha256(token).
 */
export class CloudflareStorage {
  constructor({ apiToken, accountId, bucket, kvNamespaceId, accessKeyId = null, secretAccessKey = null }) {
    if (!apiToken || !accountId || !bucket || !kvNamespaceId) throw new Error("CloudflareStorage needs apiToken, accountId, bucket and kvNamespaceId");
    this.kind = "cloudflare";
    this.apiToken = apiToken;
    this.accountId = accountId;
    this.bucket = bucket;
    this.kvNamespaceId = kvNamespaceId;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  }

  async credentials() {
    if (this.accessKeyId && this.secretAccessKey) return;
    const headers = { Authorization: `Bearer ${this.apiToken}` };
    let id = null;
    for (const url of [`${CF_API}/accounts/${this.accountId}/tokens/verify`, `${CF_API}/user/tokens/verify`]) {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      const j = await res.json().catch(() => null);
      if (res.ok && j && j.success && j.result && j.result.id) {
        id = j.result.id;
        break;
      }
    }
    if (!id) throw new Error("could not verify CF_API_TOKEN (set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY instead)");
    this.accessKeyId = id;
    this.secretAccessKey = createHash("sha256").update(this.apiToken).digest("hex");
  }

  async s3(method, key, { body, contentType } = {}) {
    await this.credentials();
    const url = `${this.endpoint}/${encodePath(this.bucket)}/${encodePath(key)}`;
    const headers = contentType ? { "content-type": contentType } : {};
    const signed = signRequest({ method, url, headers, body: body === undefined ? "" : body, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey });
    return fetch(url, { method, headers: signed, body: method === "PUT" ? body : undefined, signal: AbortSignal.timeout(120000) });
  }

  async has(key) {
    return withRetry(async () => {
      const res = await this.s3("HEAD", key);
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      throw httpError(`HEAD ${key}`, res, "");
    });
  }

  async put(key, body, contentType = "application/octet-stream") {
    return withRetry(async () => {
      const res = await this.s3("PUT", key, { body, contentType });
      if (!res.ok) throw httpError(`PUT ${key}`, res, await res.text().catch(() => ""));
    });
  }

  async kv(method, key, value) {
    return withRetry(async () => {
      const url = `${CF_API}/accounts/${this.accountId}/storage/kv/namespaces/${this.kvNamespaceId}/values/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.apiToken}`, ...(value !== undefined ? { "Content-Type": "text/plain" } : {}) },
        body: value,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok && !(method === "DELETE" && res.status === 404)) throw httpError(`KV ${method} ${key}`, res, await res.text().catch(() => ""));
    });
  }

  kvPut(key, value) {
    return this.kv("PUT", key, value);
  }

  kvDelete(key) {
    return this.kv("DELETE", key);
  }

  describe() {
    return `R2 bucket ${this.bucket} and KV namespace ${this.kvNamespaceId}`;
  }
}

export function localAssetPath(root, sha) {
  return join(resolve(root), "assets", sha);
}
