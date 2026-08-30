// NoWebP — filename normalisation. Rename only, never re-encode (ARCHITECTURE.md §4.2).

function baseName(p) { return String(p || '').replace(/^.*\//, ''); }

// Replace a trailing image extension; append only when there is none.
// looks-like.jpg -> looks-like.png, not looks-like.jpg.png.
function swapExt(name, ext) {
  const n = baseName(name);
  return /\.[A-Za-z0-9]{1,5}$/.test(n) ? n.replace(/\.[A-Za-z0-9]{1,5}$/, '.' + ext) : n + '.' + ext;
}
