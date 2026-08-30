// NoWebP — standalone-image keyboard copy, pre-commit path.
//
// This is deliberately NOT the old post-copy clipboard-change correction. It
// prepares a static WebP as PNG before the user copies, then intercepts only a
// trusted, cancelable DOM `copy` event while the same standalone image document
// remains focused and actively user-triggered. Every uncertainty fails open:
// Chrome's normal copy proceeds because preventDefault() is not called.
(() => {
  const startedAt = Date.now();
  const initialUrl = location.href;
  const standaloneImage = Boolean(
    document.contentType && document.contentType.startsWith('image/')
  );

  const state = {
    initialUrl,
    standaloneImage,
    preparation: standaloneImage ? 'preparing' : 'inactive',
    preparedPng: null,
    preparationResponse: null
  };

  function hasClipboardWriteApi() {
    return typeof ClipboardItem === 'function' &&
      typeof navigator.clipboard?.write === 'function';
  }

  function copyDecision(input) {
    if (!state.standaloneImage) return { intercept: false, reason: 'not-standalone-image' };
    if (!input.trusted) return { intercept: false, reason: 'untrusted-event' };
    if (!input.cancelable) return { intercept: false, reason: 'not-cancelable' };
    if (!input.sameDocument) return { intercept: false, reason: 'document-changed' };
    if (!input.prepared) return { intercept: false, reason: 'png-not-ready' };
    if (!input.focused) return { intercept: false, reason: 'document-not-focused' };
    if (!input.userActivation) return { intercept: false, reason: 'no-user-activation' };
    if (!input.clipboardWriteAvailable) return { intercept: false, reason: 'clipboard-write-unavailable' };
    return { intercept: true, reason: 'ready' };
  }

  function currentPrerequisites(event) {
    return {
      trusted: event.isTrusted === true,
      cancelable: event.cancelable === true,
      sameDocument: location.href === state.initialUrl &&
        Boolean(document.contentType && document.contentType.startsWith('image/')),
      prepared: state.preparation === 'ready' && state.preparedPng instanceof Blob &&
        state.preparedPng.type === 'image/png' && state.preparedPng.size > 0,
      focused: document.hasFocus() === true,
      userActivation: navigator.userActivation?.isActive === true,
      clipboardWriteAvailable: hasClipboardWriteApi()
    };
  }

  function makeClipboardPayload(blob) {
    return [new ClipboardItem({ 'image/png': blob })];
  }

  function appendRecord(record) {
    if (typeof noWebPAppendDebugRecord !== 'function') return Promise.resolve();
    return noWebPAppendDebugRecord({
      flow: 'keyboard-precommit',
      standaloneImage: state.standaloneImage,
      ...record
    });
  }

  // Isolated-world introspection for deterministic headless coverage. This is
  // not visible to page scripts and never exposes image bytes or clipboard data.
  window.__noWebPKeyboardCopyTest = {
    snapshot() {
      return {
        initialUrl: state.initialUrl,
        standaloneImage: state.standaloneImage,
        preparation: state.preparation,
        preparedType: state.preparedPng?.type || null,
        preparedSize: state.preparedPng?.size || 0,
        preparationResponse: state.preparationResponse
      };
    },
    evaluate(overrides = {}) {
      return copyDecision({
        trusted: false,
        cancelable: true,
        sameDocument: location.href === state.initialUrl,
        prepared: state.preparation === 'ready',
        focused: document.hasFocus(),
        userActivation: false,
        clipboardWriteAvailable: hasClipboardWriteApi(),
        ...overrides
      });
    },
    preparedClipboardShape() {
      const items = state.preparedPng ? makeClipboardPayload(state.preparedPng) : [];
      return {
        itemCount: items.length,
        types: items.length ? Array.from(items[0].types) : []
      };
    }
  };

  if (!standaloneImage) return;

  document.addEventListener('copy', (event) => {
    const eventStartedAt = Date.now();
    const prerequisites = currentPrerequisites(event);
    const decision = copyDecision(prerequisites);
    const record = {
      kind: 'copy',
      startedAt: eventStartedAt,
      prerequisites,
      decision: decision.reason,
      preventDefaultUsed: false,
      writeAttempted: false,
      writeResult: null,
      writeErrorName: null,
      totalElapsedMs: null,
      outcome: 'fail-open:' + decision.reason
    };

    if (!decision.intercept) {
      record.totalElapsedMs = Date.now() - eventStartedAt;
      void appendRecord(record);
      return;
    }

    // The eligibility decision is complete before this synchronous boundary.
    // Cancel Chrome's native image copy first, then start exactly one PNG-only
    // Async Clipboard write under the same trusted user activation.
    event.preventDefault();
    record.preventDefaultUsed = event.defaultPrevented === true;
    if (!record.preventDefaultUsed) {
      record.outcome = 'fail-open:prevent-default-failed';
      record.totalElapsedMs = Date.now() - eventStartedAt;
      void appendRecord(record);
      return;
    }

    record.writeAttempted = true;
    const items = makeClipboardPayload(state.preparedPng);
    navigator.clipboard.write(items).then(() => {
      record.writeResult = 'success';
      record.outcome = 'success';
    }).catch((error) => {
      record.writeResult = 'failed';
      record.writeErrorName = error?.name || 'Error';
      record.outcome = 'write-failed';
    }).finally(() => {
      record.totalElapsedMs = Date.now() - eventStartedAt;
      void appendRecord(record);
    });
  }, true);

  (async () => {
    const record = {
      kind: 'preparation',
      startedAt,
      requestSent: false,
      responseReceived: false,
      responseReason: null,
      diagnostic: null,
      preparedType: null,
      preparedSize: 0,
      totalElapsedMs: null,
      outcome: null
    };

    try {
      record.requestSent = true;
      const response = await chrome.runtime.sendMessage({
        target: 'nowebp-sw',
        type: 'keyboard-copy-prepare',
        src: initialUrl
      });
      record.responseReceived = true;
      record.responseReason = response?.reason || null;
      record.diagnostic = response?.diag || null;
      state.preparationResponse = response ? {
        ok: response.ok === true,
        reason: response.reason || null,
        classification: response.diag?.classification || null,
        conversion: response.diag?.conversion || null
      } : null;

      if (!response?.ok || location.href !== initialUrl) {
        state.preparation = response?.ok ? 'document-changed' : 'declined';
        record.outcome = response?.ok ? 'document-changed' : 'declined:' + (response?.reason || 'no-response');
        return;
      }

      const blob = await (await fetch(response.pngUrl)).blob();
      if (blob.type !== 'image/png' || blob.size === 0 || location.href !== initialUrl) {
        state.preparation = 'invalid-png';
        record.outcome = 'invalid-png';
        return;
      }

      state.preparedPng = blob;
      state.preparation = 'ready';
      record.preparedType = blob.type;
      record.preparedSize = blob.size;
      record.outcome = 'prepared';
    } catch (error) {
      state.preparation = 'failed';
      state.preparationResponse = {
        ok: false,
        reason: 'content-preparation-failed',
        errorName: error?.name || 'Error'
      };
      record.responseReason = 'content-preparation-failed';
      record.outcome = 'failed';
    } finally {
      record.totalElapsedMs = Date.now() - startedAt;
      void appendRecord(record);
    }
  })();
})();
