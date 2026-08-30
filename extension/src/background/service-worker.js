// NoWebP — production service worker. See ARCHITECTURE.md §4 for the full flow.
//
// Governing rule (ARCHITECTURE.md §6): uncertainty means leave the user's data exactly
// as it was. The original download is never destroyed before a valid PNG blob exists.

importScripts('../lib/webp.js', '../lib/naming.js', '../lib/convert.js');

const SELF_ID = chrome.runtime.id;

// Final values — ARCHITECTURE.md §4.3. Not user-configurable; kept as top-level
// `let` bindings (not a closure) so the test harness can override them via CDP
// Runtime.evaluate without a message-passing test API in production code.
let CFG = {
  holdBudgetMs: 800,
  sniffTimeoutMs: 5000,
  maxPixels: 80_000_000
};

// url -> intended filename for a replacement download we initiated ourselves.
// Doubles as the self-recursion guard (LESSONS.md L3: downloads.download({filename})
// is silently ignored whenever any onDeterminingFilename listener exists, including
// our own — the filename must be re-asserted here).
const selfInitiated = new Map();

// Minimal in-memory counters for the test harness. Not persisted, not logged —
// deliberately not the spike's per-step event log (AGENTS.md: port deliberately).
let processed = 0;      // bumped once per onDeterminingFilename decision
let downloadCalls = 0;  // bumped once per self-initiated chrome.downloads.download

const NEVER_SNIFF = /^(application\/(pdf|zip|json|xml)|video\/|audio\/|text\/)/i;
function isCandidate(item) {
  const m = (item.mime || '').toLowerCase();
  if (NEVER_SNIFF.test(m)) return false;
  if (m.startsWith('image/')) return true;                 // includes mislabelled webp
  if (m === '' || m === 'application/octet-stream' || m === 'binary/octet-stream') return true;
  return false;
}

// Reads at most 32 bytes, then aborts the body. Range if honoured, stream-capped if not.
async function sniff(url, timeoutMs) {
  const policy = sourceFetchPolicy(url);
  if (!policy.ok) return { ok: false, reason: policy.reason };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('sniff-timeout'), timeoutMs);
  try {
    const r = await fetch(url, {
      credentials: 'include',
      headers: { Range: 'bytes=0-31' },
      signal: ac.signal
    });
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    while (got < 32) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, 32 - got);
      // slice() copies only the required prefix. Using the whole chunk (or a
      // subarray view) would retain its potentially much larger backing buffer
      // when a server ignores Range.
      chunks.push(value.slice(0, take));
      got += take;
    }
    try { await reader.cancel(); } catch (_) {}
    const buf = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    return { ok: true, bytes: buf };
  } catch (e) {
    return { ok: false, err: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function getItem(id) {
  return new Promise(res => chrome.downloads.search({ id }, r => res(r && r[0])));
}

// MEASURED (2026-08-24, see LESSONS.md L28): chrome.downloads.onDeterminingFilename's
// `item` carries no field that distinguishes a saveAs-gated download (native "Save
// image as...", or the global "Ask where to save each file" setting) from a normal
// one — both report a populated item.filename at listener-fire time. The difference
// only shows up afterward, in chrome.downloads.search(): a saveAs-gated download's
// filename stays '' with state 'in_progress' for as long as the dialog is unresolved
// (seconds, bounded only by the user), while a normal download resolves to a real
// filename within roughly 100-150ms even over a slow path. That gap is wide enough
// to poll safely without racing the ~1-2ms transient a normal download can also
// briefly show. destroyOriginal()+redownload must never run while this is still true.
const DIALOG_GATE_POLL_MS = 60;
const DIALOG_GATE_MAX_WAIT_MS = 500;
async function waitForResolvedDestination(id) {
  const t0 = Date.now();
  while (Date.now() - t0 < DIALOG_GATE_MAX_WAIT_MS) {
    const it = await getItem(id);
    if (!it) return { resolved: false, gone: true };
    if (it.filename || it.state !== 'in_progress') return { resolved: true };
    await new Promise(r => setTimeout(r, DIALOG_GATE_POLL_MS));
  }
  return { resolved: false, gone: false }; // still unresolved -> treat as dialog-gated
}

// Both branches are needed because the download may or may not have finished
// (LESSONS.md L8): in_progress -> cancel + erase; complete -> removeFile + erase.
async function destroyOriginal(id) {
  const before = await getItem(id);
  const state = before ? before.state : 'gone';
  if (state === 'in_progress') {
    try { await chrome.downloads.cancel(id); } catch (_) {}
  }
  const after = await getItem(id);
  if (after && after.state === 'complete' && after.exists) {
    try { await chrome.downloads.removeFile(id); } catch (_) {}
  }
  try { await chrome.downloads.erase({ id }); } catch (_) {}
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const intended = selfInitiated.get(item.finalUrl) || selfInitiated.get(item.url);
  if (item.byExtensionId === SELF_ID || intended) {
    if (intended) suggest({ filename: intended, conflictAction: 'uniquify' });
    else suggest();
    processed++;
    return;
  }
  if (!isCandidate(item)) {
    suggest();
    processed++;
    return;
  }
  handle(item, suggest);
  return true; // async suggest()
});

async function handle(item, suggest) {
  let released = false;
  const release = (arg) => {
    if (released) return;
    released = true;
    processed++;
    suggest(arg);
  };

  try {
    const sn = await sniff(item.finalUrl, CFG.sniffTimeoutMs);
    if (!sn.ok) { release(); return; }                        // FAIL-SAFE: preserve original

    const cls = classify(sn.bytes);

    if (!cls.webp) {
      // Not WebP. Never re-encode — but if Chrome proposed a .webp name for
      // JPEG/PNG bytes, the file would be unopenable. Normalise the extension only.
      const rt = realType(sn.bytes);
      const nameNow = baseName(item.filename);
      const extNow = (nameNow.match(/\.([A-Za-z0-9]{1,5})$/) || [, ''])[1].toLowerCase();
      if (rt && !rt.exts.includes(extNow)) {
        // MEASURED: a same-event suggest({filename}) that changes the extension is
        // silently reverted by Chrome back to the extension implied by item.mime
        // whenever that MIME maps to a canonical extension (true for image/webp,
        // even with a synchronous suggest() and no fetch involved at all). The only
        // reliable fix is the same destroy+redownload path used for conversion,
        // carrying the ORIGINAL bytes verbatim — no re-encode.
        const holdTimer = setTimeout(() => { if (!released) release(); }, CFG.holdBudgetMs);
        const raw = await refetchRaw(item.finalUrl);
        clearTimeout(holdTimer);
        if (!raw.ok) { release(); return; }                     // FAIL-SAFE: preserve original

        release();

        // FAIL-SAFE: if the original is still waiting on an unresolved native save
        // dialog (saveAs, or "Ask where to save each file"), never race it with a
        // silent replacement (ARCHITECTURE.md §4.4). Defer entirely — the user's
        // chosen destination is not something this extension can reuse or observe.
        const dest = await waitForResolvedDestination(item.id);
        if (!dest.resolved) return;

        await destroyOriginal(item.id);

        const fixedName = swapExt(nameNow, rt.ext);
        const dataUrl = 'data:' + rt.mime + ';base64,' + abToBase64(raw.buf);
        selfInitiated.set(item.finalUrl, fixedName);
        selfInitiated.set(dataUrl, fixedName);
        downloadCalls++;
        await chrome.downloads.download({ url: dataUrl, filename: fixedName, conflictAction: 'uniquify' });
        return;
      }
      release();
      return;                                                  // untouched
    }

    if (cls.animated !== false) {
      release();
      return;                                                  // FAIL-SAFE: animated preserved untouched
    }

    // HYBRID: bound how long the user's download is stalled, not the conversion
    // itself. If conversion outruns the budget, release now and replace after it
    // lands; otherwise replace before anything lands at all (ARCHITECTURE.md §4.1).
    const holdTimer = setTimeout(() => {
      if (!released) release();
    }, CFG.holdBudgetMs);

    const conv = await convertToPng(item.finalUrl, { maxPixels: CFG.maxPixels });
    clearTimeout(holdTimer);

    if (!conv.ok) {
      release();
      return;                                                  // FAIL-SAFE: preserve original
    }

    // Only now, with a valid PNG in hand, is it safe to destroy the original.
    release();

    // FAIL-SAFE: see the identical guard above — never destroy+replace while the
    // original is still waiting on an unresolved native save dialog.
    const dest = await waitForResolvedDestination(item.id);
    if (!dest.resolved) return;

    await destroyOriginal(item.id);

    const pngName = swapExt(item.filename || 'image.webp', 'png');
    selfInitiated.set(item.finalUrl, pngName);
    selfInitiated.set(conv.url, pngName);
    downloadCalls++;
    await chrome.downloads.download({ url: conv.url, filename: pngName, conflictAction: 'uniquify' });
  } catch (e) {
    release();                                                 // FAIL-SAFE: unexpected throw -> preserve
  }
}

// ============================================================================
// Layer 2 fallback — "Copy image as PNG" (ARCHITECTURE.md §5.2).
//
// Ship this regardless of the standalone keyboard path: it remains the reliable
// explicit fallback for ordinary-page images and Chrome's native right-click
// "Copy Image" command, which has no interceptable pre-copy DOM event. Fetch and
// convert happen here in the SW — a content script inherits
// the page's CORS context and cannot fetch cross-origin (LESSONS.md L14) — and only
// the clipboard write itself is injected into the focused tab (LESSONS.md L13:
// navigator.clipboard.write() requires a focused document; the SW is never focused).
// ============================================================================

const MENU_ID = 'nowebp-copy-as-png';
const MENU_ID_SAVE = 'nowebp-save-as-png';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Copy image as PNG', contexts: ['image'] });
    chrome.contextMenus.create({ id: MENU_ID_SAVE, title: 'Save image as PNG…', contexts: ['image'] });
  });
});

// Runs inside the focused tab via chrome.scripting.executeScript. Self-contained —
// executeScript cannot see the service worker's scope.
function injectCopyPngToClipboard(pngDataUrl) {
  return fetch(pngDataUrl)
    .then(r => r.blob())
    .then(blob => navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]))
    .then(() => ({ ok: true }))
    .catch(e => ({ ok: false, err: String(e) }));
}

// Named (rather than inlined into the listener) so the test harness can drive the
// exact production logic via CDP Runtime.evaluate — headless/CDP cannot render or
// click a native context menu, so this is the strongest automated entry point
// available (AGENTS.md: "strongest automated validation without pretending
// PowerPoint Web itself is automatable").
async function runCopyAsPngFallback(srcUrl, tabId) {
  const sn = await sniff(srcUrl, CFG.sniffTimeoutMs);
  if (!sn.ok) return { ok: false, reason: sn.reason || 'sniff-failed' }; // FAIL-SAFE

  const cls = classify(sn.bytes);
  if (!cls.webp || cls.animated !== false) return { ok: false, reason: 'not-static-webp' };

  const conv = await convertToPng(srcUrl, { maxPixels: CFG.maxPixels });
  if (!conv.ok) return { ok: false, reason: 'convert-failed', stage: conv.stage }; // FAIL-SAFE

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectCopyPngToClipboard,
      args: [conv.url]
    });
    return result || { ok: false, reason: 'no-result' };
  } catch (e) {
    // Focus lost, tab closed, or injection blocked — leave Chrome's clipboard untouched.
    return { ok: false, reason: 'inject-failed', err: String(e) };
  }
}

// ============================================================================
// "Save image as PNG…" (ARCHITECTURE.md §4.4) — the proven-safe alternative to
// automatic conversion when the user wants an interactive Save dialog. Converts
// FIRST, then makes exactly one chrome.downloads.download({saveAs:true}) call, so
// the ONE resulting native dialog already carries PNG bytes and a PNG filename —
// same right-click-then-click-menu-item count as native "Save image as...", one
// dialog, and the user can still edit the filename and pick any folder. This is
// deliberately NOT automatic: see the fail-safe guard in handle() and LESSONS.md
// L28 for why the automatic path cannot safely do this itself.
async function runSaveAsPngFallback(srcUrl, suggestedFilename) {
  const sn = await sniff(srcUrl, CFG.sniffTimeoutMs);
  if (!sn.ok) return { ok: false, reason: sn.reason || 'sniff-failed' };

  const cls = classify(sn.bytes);
  if (!cls.webp || cls.animated !== false) return { ok: false, reason: 'not-static-webp' };

  const conv = await convertToPng(srcUrl, { maxPixels: CFG.maxPixels });
  if (!conv.ok) return { ok: false, reason: 'convert-failed', stage: conv.stage };

  const pngName = swapExt(baseName(suggestedFilename) || 'image.webp', 'png');
  // Self-recursion guard re-assertion (LESSONS.md L3) applies here too: without this,
  // Chrome would ignore the filename we pass to downloads.download below and the
  // save dialog would show a UUID instead of a meaningful suggested name.
  selfInitiated.set(conv.url, pngName);
  try {
    const id = await new Promise((resolve, reject) => {
      chrome.downloads.download({ url: conv.url, filename: pngName, saveAs: true }, (downloadId) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(downloadId);
      });
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, reason: 'download-failed', err: String(e) };
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null || !info.srcUrl) return;
  if (info.menuItemId === MENU_ID) {
    runCopyAsPngFallback(info.srcUrl, tab.id);
  } else if (info.menuItemId === MENU_ID_SAVE) {
    const suggested = baseName(new URL(info.srcUrl, tab.url).pathname) || 'image.webp';
    runSaveAsPngFallback(info.srcUrl, suggested);
  }
});

// ============================================================================
// Layer 2 keyboard pre-commit preparation (ARCHITECTURE.md §5.1).
//
// The shipped content script runs only on a standalone image document. It asks
// this worker to classify and pre-convert location.href before a trusted `copy`
// event occurs. The old post-copy message type is intentionally
// not handled here, so Chrome's native right-click "Copy Image" path cannot
// accidentally reactivate the measured last-writer race.
// ============================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'nowebp-sw' || msg.type !== 'keyboard-copy-prepare') return;
  (async () => {
    const diag = { requestReceivedAt: Date.now() };

    // Only the top-level content script for the same document may request this
    // preparation. Any mismatch fails open before a fetch or conversion.
    if (sender.frameId !== 0 || !sender.url || sender.url !== msg.src) {
      sendResponse({ ok: false, reason: 'sender-mismatch', diag });
      return;
    }

    const sniffStart = Date.now();
    const sn = await sniff(msg.src, CFG.sniffTimeoutMs);
    diag.sniff = {
      startedAt: sniffStart,
      endedAt: Date.now(),
      ok: sn.ok,
      reason: sn.ok ? null : (sn.reason || null),
      err: sn.ok ? null : (sn.err || null)
    };
    if (!sn.ok) { sendResponse({ ok: false, reason: sn.reason || 'sniff-failed', diag }); return; }

    const cls = classify(sn.bytes);
    diag.classification = {
      webp: cls.webp,
      animated: cls.animated,
      fourcc: cls.fourcc || null,
      dimensionsTrusted: cls.dimensionsTrusted === true,
      w: cls.dimensionsTrusted ? cls.w : null,
      h: cls.dimensionsTrusted ? cls.h : null,
      pixels: cls.dimensionsTrusted ? cls.pixels : null,
      reason: cls.reason || null
    };
    if (!cls.webp || cls.animated !== false) { sendResponse({ ok: false, reason: 'not-static-webp', diag }); return; }
    if (!cls.dimensionsTrusted || !Number.isSafeInteger(cls.pixels)) {
      sendResponse({ ok: false, reason: 'invalid-dimensions', diag });
      return;
    }
    diag.preDecodeGuard = { maxPixels: CFG.maxPixels, pixels: cls.pixels, exceeded: cls.pixels > CFG.maxPixels };
    if (diag.preDecodeGuard.exceeded) {
      sendResponse({ ok: false, reason: 'guard-pixels-predecode', stage: 'guard-pixels-predecode', diag });
      return;
    }

    const convStart = Date.now();
    const conv = await convertToPng(msg.src, { maxPixels: CFG.maxPixels });
    diag.conversion = { startedAt: convStart, endedAt: Date.now(), ok: conv.ok, stage: conv.ok ? null : conv.stage };
    if (!conv.ok) { sendResponse({ ok: false, reason: 'convert-failed', stage: conv.stage, diag }); return; }

    sendResponse({ ok: true, pngUrl: conv.url, diag });
  })();
  return true; // async sendResponse
});
