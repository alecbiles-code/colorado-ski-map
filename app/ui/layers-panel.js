// Layer panel: layers grouped by meaning, each with switch, status, opacity, legend and source info.
import {el, link} from './dom.js';
import {GROUPS} from '../map/layers.js';

const STATUS_TEXT = {off: 'Off', loading: 'Loading…', ready: 'Shown', failed: 'Failed', unavailable: 'Not available yet', zoom: 'Zoom in'};

function statusLine(s) {
  const bad = s.status === 'failed' || s.status === 'unavailable';
  return el('div', {class: `layer-state${bad ? ' bad' : ''}`}, STATUS_TEXT[s.status] || s.status, s.detail ? `: ${s.detail}` : '');
}

function sourceInfo(d, ctx) {
  const info = d.info?.(ctx);
  if (!info) return null;
  return el('details', {}, el('summary', {}, 'Source and limits'),
    el('p', {class: 'small'}, info.text || ''),
    ...(info.notes || []).map(n => el('p', {class: 'small muted'}, n)),
    el('div', {class: 'small'}, (info.links || []).map(([t, u]) => el('div', {}, link(u, t)))),
    info.metaUrl ? el('div', {class: 'small'}, link(new URL(info.metaUrl, document.baseURI).href, 'Product metadata (JSON)')) : null);
}

function layerRow(reg, d, ctx) {
  const s = reg.state.get(d.id);
  const input = el('input', {type: 'checkbox', role: 'switch', 'aria-label': d.title, onchange: e => reg.setOn(d.id, e.target.checked)});
  input.checked = s.on;
  input.disabled = s.status === 'unavailable';
  const opacity = s.opacity === null ? null : el('label', {class: 'opacity'}, 'Opacity',
    el('input', {type: 'range', min: '0.1', max: '1', step: '0.05', value: String(s.opacity), 'aria-label': `${d.title} opacity`,
      oninput: e => reg.setOpacity(d.id, Number(e.target.value))}));
  return el('div', {class: `layer${s.on ? ' on' : ''}`, 'data-layer': d.id},
    el('div', {}, el('div', {class: 'layer-name'}, d.title), statusLine(s)),
    el('label', {class: 'switch'}, input, el('span', {})),
    el('div', {class: 'layer-extra'}, opacity, d.legend?.(ctx), sourceInfo(d, ctx)),
    s.on ? null : el('div', {style: 'grid-column:1/-1'}, s.status === 'unavailable' ? d.unavailableNode?.(ctx) : sourceInfo(d, ctx)));
}

/**
 * Build the panel. Rows re-render when their layer changes state.
 * @param {object} reg layer registry
 * @param {object} ctx shared context
 * @param {{header: Node}} opts
 */
export function renderLayersPanel(reg, ctx, {header}) {
  const root = el('div', {}, header);
  for (const [g, title] of GROUPS) {
    const defs = reg.defs.filter(d => d.group === g);
    const sec = el('section', {class: 'section', 'aria-label': title}, el('h3', {}, title));
    if (!defs.length) sec.append(el('p', {class: 'empty-state small'}, g === 'weather'
      ? 'Weather is shown per place: select a point, then open Conditions.'
      : 'No layers published for this group yet.'));
    defs.forEach(d => sec.append(layerRow(reg, d, ctx)));
    ctx.extraGroupContent?.[g]?.forEach(n => sec.append(n));
    root.append(sec);
  }
  const onChange = e => {
    if (!root.isConnected) { reg.events.removeEventListener('change', onChange); return; }
    const old = root.querySelector(`[data-layer="${e.detail.id}"]`);
    if (!old) return;
    const focused = old.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    const fresh = layerRow(reg, reg.get(e.detail.id), ctx);
    old.replaceWith(fresh);
    if (focused) fresh.querySelector(`[aria-label="${CSS.escape(focused)}"]`)?.focus();
  };
  reg.events.addEventListener('change', onChange);
  return root;
}
