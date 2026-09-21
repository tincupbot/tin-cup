import { PORTRAIT_PNG, ICON_PNG } from "./images.ts";

type Embedded = { etag: string; bytes: number; b64: string };

/**
 * Decode once per isolate, not once per request.
 *
 * A cold start pays ~100KB of base64 decoding; every request after it is a
 * pointer. The cache is keyed by the object itself so adding an image needs no
 * bookkeeping here.
 */
const decoded = new WeakMap<Embedded, Uint8Array>();

function bytesOf(img: Embedded): Uint8Array {
  const hit = decoded.get(img);
  if (hit) return hit;
  const raw = atob(img.b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  decoded.set(img, out);
  return out;
}

/**
 * Serve an embedded PNG, honouring If-None-Match.
 *
 * The etag is the content hash, so a changed image invalidates itself and an
 * unchanged one costs a 304 and no body. `immutable` is deliberately not used:
 * these are served from stable paths, and a year-long immutable cache on a
 * stable path is how a logo becomes impossible to change.
 */
export function pngResponse(img: Embedded, req: Request, maxAgeSeconds = 86400): Response {
  const headers: Record<string, string> = {
    "content-type": "image/png",
    "cache-control": `public, max-age=${maxAgeSeconds}`,
    etag: img.etag,
  };
  if (req.headers.get("if-none-match") === img.etag) {
    return new Response(null, { status: 304, headers });
  }
  const body = bytesOf(img);
  return new Response(body, { status: 200, headers });
}

export { PORTRAIT_PNG, ICON_PNG };
