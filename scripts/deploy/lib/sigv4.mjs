// AWS Signature Version 4 for the S3 API, as R2 speaks it. Only what deploy needs:
// single-request PUT, HEAD and GET with the payload hash in x-amz-content-sha256.
import { createHash, createHmac } from "node:crypto";

const hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding of each path segment, keeping the slashes (S3 does not double-encode). */
export function encodePath(path) {
  return path
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()))
    .join("/");
}

export function amzDate(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Signs a request. Returns the headers to send (including Authorization).
 * @param {{ method: string, url: string, headers?: object, body?: Buffer|string, payloadHash?: string,
 *           accessKeyId: string, secretAccessKey: string, region?: string, service?: string, date?: Date }} r
 */
export function signRequest(r) {
  const url = new URL(r.url);
  const region = r.region || "auto";
  const service = r.service || "s3";
  const stamp = amzDate(r.date);
  const day = stamp.slice(0, 8);
  const payloadHash = r.payloadHash || hex(r.body === undefined ? "" : r.body);
  const headers = { ...(r.headers || {}), host: url.host, "x-amz-date": stamp, "x-amz-content-sha256": payloadHash };

  const lower = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]);
  lower.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = lower.map(([k]) => k).join(";");
  const canonicalHeaders = lower.map(([k, v]) => `${k}:${v}\n`).join("");
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [r.method.toUpperCase(), url.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + r.secretAccessKey, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return {
    ...Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "host")),
    Authorization: `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
