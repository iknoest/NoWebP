# NoWebP

A Chrome extension that converts static WebP images to PNG at the points where you actually
need PNG: downloading, copying, and saving.

WebP is efficient for the web, but a lot of everyday tools — PowerPoint, older editors, some
web upload forms — don't handle it well. NoWebP quietly gives you a PNG instead, only when it's
confident the source is a static (non-animated) WebP image.

## What NoWebP does

- **Automatic download conversion** — download a static WebP image normally, and NoWebP saves it
  as PNG instead.
- **Keyboard copy** — press `Ctrl+C` / `⌘C` on a standalone static WebP image (an image open by
  itself in a tab) and the clipboard receives PNG image data.
- **Right-click → "Copy image as PNG"** — explicit PNG copy from NoWebP's own context-menu entry.
- **Right-click → "Save image as PNG…"** — explicit PNG save, with one native Chrome save dialog.

Animated WebP is left untouched. Anything NoWebP isn't confident about is left untouched too —
when in doubt, it does nothing rather than risk your data.

## Important limitation

Chrome's **built-in** right-click **"Copy Image"** command is **not** modified by NoWebP — this
is a current Chrome platform limitation, not a bug in this extension. Chrome does not expose a
page-visible event that NoWebP can use to intercept that specific native command. If you need a
right-click copy workflow, use NoWebP's own **"Copy image as PNG"** entry instead.

## Manual installation (for testing / before Chrome Web Store availability)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select this repository's **`extension/`** folder — not the repository root.

NoWebP should now appear in your extensions list and is ready to use.

## How to test

A public test lab with known WebP sample files is published via GitHub Pages:

**→ [Test NoWebP](https://iknoest.github.io/NoWebP/test.html)**

It walks through static WebP with alpha, lossy (VP8), lossless (VP8L), an animated WebP that
should be left alone, and PNG/JPEG controls that shouldn't be touched at all — with the expected
result written next to each one.

## Privacy

NoWebP processes everything locally in Chrome. It does not collect, transmit, or sell any data.

**→ [Privacy Policy](https://iknoest.github.io/NoWebP/privacy.html)**

## Support

This repository's **[Issues](https://github.com/iknoest/NoWebP/issues)** page is the support and
contact channel for NoWebP. Please open an issue for bugs, questions, or compatibility reports.

## License

No license has been assigned to this repository yet.
