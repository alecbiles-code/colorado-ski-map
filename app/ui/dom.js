// Tiny DOM builder. Children that are strings become text nodes, so untrusted text is never parsed as HTML.
import {safeUrl} from '../lib/escape.js';

/**
 * Create an element. attrs: class, text, on<event> handlers, boolean attributes, anything else as attribute.
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

/** External link that opens in a new tab, or plain text when the URL is not http(s). */
export function link(href, text) {
  const u = safeUrl(href);
  return u ? el('a', {href: u, target: '_blank', rel: 'noopener noreferrer'}, text || u) : el('span', {}, text || '');
}

/** Definition list from [label, value] pairs; values may be nodes or strings. Skips empty rows. */
export const kv = rows => el('dl', {class: 'kv'}, rows.filter(r => r && r[1] !== undefined && r[1] !== null && r[1] !== '')
  .map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));

let toastTimer = null;
/** Short status message at the bottom of the screen. */
export function toast(msg, ms = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
