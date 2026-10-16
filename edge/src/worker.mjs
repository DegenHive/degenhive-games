// Cloudflare Worker for *.<game domain> and *.<preview domain>.
// Bindings (edge/wrangler.toml): GAMES_BUCKET (R2), GAMES_KV (KV).
// Vars: GAME_DOMAIN, PREVIEW_DOMAIN, FRAME_ANCESTORS.
import { handle } from "./core.mjs";
import { libraryIndex } from "../../scripts/lib/cdn.mjs";
import rules from "../../rules/static-rules.json";

const libIndex = libraryIndex(rules.libraries);

// Builds and pending uploads never change once written, so their manifests can be cached
// for the life of the isolate. The SDK is cached briefly so a new upload shows up soon.
const MANIFEST_CACHE_MAX = 500;
const manifests = new Map();
let sdkCache = { at: 0, text: null };
const SDK_TTL_MS = 60 * 1000;
const KV_CACHE_TTL_S = 60;

function makeStore(env) {
  return {
    kv: (key) => env.GAMES_KV.get(key, { cacheTtl: KV_CACHE_TTL_S }),
    async text(key) {
      const cacheable = key.endsWith("/manifest.json");
      if (cacheable && manifests.has(key)) return manifests.get(key);
      const obj = await env.GAMES_BUCKET.get(key);
      if (!obj) return null;
      const text = await obj.text();
      if (cacheable) {
        if (manifests.size >= MANIFEST_CACHE_MAX) manifests.delete(manifests.keys().next().value);
        manifests.set(key, text);
      }
      return text;
    },
    async object(key, range) {
      const obj = await env.GAMES_BUCKET.get(key, range ? { range: { offset: range.offset, length: range.length } } : undefined);
      return obj ? { body: obj.body } : null;
    },
    async sdk() {
      const now = Date.now();
      if (sdkCache.text !== null && now - sdkCache.at < SDK_TTL_MS) return sdkCache.text;
      const obj = await env.GAMES_BUCKET.get("sdk/sdk.js");
      sdkCache = { at: now, text: obj ? await obj.text() : null };
      return sdkCache.text;
    },
  };
}

export default {
  async fetch(request, env) {
    try {
      const res = await handle({ method: request.method, url: request.url, headers: request.headers }, env, makeStore(env), { libIndex });
      return new Response(res.body, { status: res.status, headers: res.headers });
    } catch (e) {
      console.error("games-edge", e && e.stack ? e.stack : String(e));
      return new Response("Server error\n", { status: 500, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    }
  },
};
