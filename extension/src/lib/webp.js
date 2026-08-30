// NoWebP — byte-level image classification. See ARCHITECTURE.md §4.2, §7.3.
// Classify on bytes only, never filename or MIME. VP8X flags live at byte 20,
// not byte 12 (Google's own doc summary is wrong here — LESSONS.md L6).

// Signature table for FILENAME normalisation only — we rename, we never re-encode.
// Deliberately narrow: JPEG and PNG only (ARCHITECTURE.md §4.2).
const SIGNATURES = [
  { ext: 'jpg', exts: ['jpg', 'jpeg'], mime: 'image/jpeg', test: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { ext: 'png', exts: ['png'],         mime: 'image/png',  test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 }
];

function realType(b) {
  if (!b || b.length < 4) return null;
  for (const s of SIGNATURES) if (s.test(b)) return s;
  return null;
}

function u32le(b, i) {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function trustedDimensions(w, h) {
  const pixels = w * h;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 ||
      !Number.isSafeInteger(pixels)) return null;
  return { dimensionsTrusted: true, w, h, pixels };
}

function malformedStatic(fourcc, reason) {
  return { webp: true, animated: false, fourcc, dimensionsTrusted: false, reason };
}

// 32 bytes are enough to classify WebP and validate dimensions for VP8, VP8L,
// and VP8X. Dimensions are never returned from unvalidated offsets.
function classify(b) {
  if (!b || b.length < 16) return { webp: false, reason: 'too-short' };
  const s = (i, n) => String.fromCharCode.apply(null, Array.from(b.slice(i, i + n)));
  if (s(0, 4) !== 'RIFF' || s(8, 4) !== 'WEBP') return { webp: false, reason: 'not-riff-webp' };
  const fourcc = s(12, 4);

  if (fourcc === 'VP8 ') {
    if (b.length < 30) return malformedStatic(fourcc, 'vp8-truncated');
    if (u32le(b, 16) < 10) return malformedStatic(fourcc, 'vp8-short-chunk');
    if ((b[20] & 0x01) !== 0) return malformedStatic(fourcc, 'vp8-not-keyframe');
    if (b[23] !== 0x9D || b[24] !== 0x01 || b[25] !== 0x2A) {
      return malformedStatic(fourcc, 'vp8-bad-sync-code');
    }
    const dimensions = trustedDimensions(
      (b[26] | (b[27] << 8)) & 0x3FFF,
      (b[28] | (b[29] << 8)) & 0x3FFF
    );
    return dimensions
      ? { webp: true, animated: false, fourcc, ...dimensions }
      : malformedStatic(fourcc, 'vp8-invalid-dimensions');
  }

  if (fourcc === 'VP8L') {
    if (b.length < 25) return malformedStatic(fourcc, 'vp8l-truncated');
    if (u32le(b, 16) < 5) return malformedStatic(fourcc, 'vp8l-short-chunk');
    if (b[20] !== 0x2F) return malformedStatic(fourcc, 'vp8l-bad-signature');
    const bits = u32le(b, 21);
    if ((bits >>> 29) !== 0) return malformedStatic(fourcc, 'vp8l-unsupported-version');
    const dimensions = trustedDimensions(
      (bits & 0x3FFF) + 1,
      ((bits >>> 14) & 0x3FFF) + 1
    );
    return dimensions
      ? { webp: true, animated: false, fourcc, ...dimensions }
      : malformedStatic(fourcc, 'vp8l-invalid-dimensions');
  }

  if (fourcc === 'VP8X') {
    if (b.length < 30) return { webp: true, animated: null, fourcc, dimensionsTrusted: false, reason: 'vp8x-truncated' };
    if (u32le(b, 16) !== 10) return { webp: true, animated: null, fourcc, dimensionsTrusted: false, reason: 'vp8x-bad-chunk-size' };
    const flags = b[20];
    if ((flags & 0xC1) !== 0 || b[21] !== 0 || b[22] !== 0 || b[23] !== 0) {
      return { webp: true, animated: null, fourcc, dimensionsTrusted: false, reason: 'vp8x-reserved-bits' };
    }
    const dimensions = trustedDimensions(
      (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
      (b[27] | (b[28] << 8) | (b[29] << 16)) + 1
    );
    if (!dimensions) return { webp: true, animated: null, fourcc, dimensionsTrusted: false, reason: 'vp8x-invalid-dimensions' };
    return {
      webp: true, fourcc, flags,
      animated: !!(flags & 0x02), alphaFlag: !!(flags & 0x10), ...dimensions
    };
  }
  return { webp: false, reason: 'unknown-fourcc', fourcc };
}
