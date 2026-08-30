// NoWebP — fetch -> decode -> encode, entirely inside the service worker.
//
// ARCHITECTURE.md §7.1: an offscreen document's OffscreenCanvas.convertToBlob() costs a
// flat ~1s regardless of image size; the identical call in the service worker takes
// single-digit to low-hundreds of ms. No offscreen document, no offscreen permission.
//
// Service workers have no URL.createObjectURL, so the result is a data: URL
// (LESSONS.md L5: measured working well past any realistic size).

function abToBase64(ab) {
  const b = new Uint8Array(ab);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
  return btoa(s);
}

// Shared policy boundary for every extension-initiated source-image request.
// Parse with the platform URL parser, allow HTTPS verbatim, and fail open for
// HTTP or any unsupported/malformed scheme. Callers must fetch the original
// `url` value, never a normalized or rewritten value derived from this check.
function sourceFetchPolicy(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { ok: false, reason: 'unsupported-source' };
  }
  if (parsed.protocol === 'https:') return { ok: true };
  if (parsed.protocol === 'http:') return { ok: false, reason: 'insecure-source' };
  return { ok: false, reason: 'unsupported-source' };
}

// Fetches `url`, decodes it, and re-encodes as PNG. Never throws — every failure
// stage returns { ok: false, stage }, so the caller's fail-safe path is unconditional.
async function convertToPng(url, { maxPixels }) {
  const policy = sourceFetchPolicy(url);
  if (!policy.ok) return { ok: false, stage: policy.reason, reason: policy.reason };

  let r;
  try {
    r = await fetch(url, { credentials: 'include' });
  } catch (e) {
    return { ok: false, stage: 'fetch-throw', err: String(e) };
  }
  if (!r.ok) return { ok: false, stage: 'fetch-status', status: r.status };

  const blob = await r.blob();

  let bmp;
  try {
    bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  } catch (e) {
    return { ok: false, stage: 'decode', err: String(e) };
  }

  const w = bmp.width, h = bmp.height;
  if (w * h > maxPixels) {
    bmp.close();
    return { ok: false, stage: 'guard-pixels', w, h };
  }

  let png;
  try {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { alpha: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    png = await c.convertToBlob({ type: 'image/png' });
  } catch (e) {
    return { ok: false, stage: 'encode', err: String(e) };
  }

  const outUrl = 'data:image/png;base64,' + abToBase64(await png.arrayBuffer());
  return { ok: true, url: outUrl, w, h, srcBytes: blob.size, pngBytes: png.size };
}

// Fetches `url` verbatim — no decode, no re-encode. Used only to rebuild a correctly
// extensioned data: URL for bytes that are already the right format but were served
// under a mismatched MIME type (see service-worker.js: onDeterminingFilename's
// suggest() silently reverts a cross-extension rename when item.mime maps to a
// canonical extension — measured true for image/webp; a fresh download is the only
// reliable fix).
async function refetchRaw(url) {
  const policy = sourceFetchPolicy(url);
  if (!policy.ok) return { ok: false, stage: policy.reason, reason: policy.reason };

  let r;
  try {
    r = await fetch(url, { credentials: 'include' });
  } catch (e) {
    return { ok: false, stage: 'fetch-throw', err: String(e) };
  }
  if (!r.ok) return { ok: false, stage: 'fetch-status', status: r.status };
  const buf = await r.arrayBuffer();
  return { ok: true, buf };
}
