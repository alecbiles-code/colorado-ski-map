// Escaping for untrusted text (imported files, upstream data, shared links).

const XML_ESC = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'};
/** Escape text for XML or HTML text and attribute positions. */
export const escapeXml = s => String(s).replace(/[&<>"']/g, c => XML_ESC[c]);

/** Return the URL if it is an absolute http(s) URL, else null (blocks javascript:, data: and friends). */
export function safeUrl(u) {
  if (typeof u !== 'string') return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

/** Trim, collapse control characters and bound the length of an untrusted string. */
export function cleanText(s, max) {
  if (s === null || s === undefined) return '';
  // eslint-disable-next-line no-control-regex
  const t = String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
