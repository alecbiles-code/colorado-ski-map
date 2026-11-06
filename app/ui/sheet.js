// Bottom sheet with drag and snap (peek, half, full), keyboard resizing, and a side-panel mode on wide
// screens and phones in landscape (CSS decides the mode; this module only reads it).

const SNAPS = ['peek', 'half', 'full'];
const sideMode = () => matchMedia('(min-width: 900px), (orientation: landscape) and (max-height: 540px)').matches;

/**
 * @param {{onResize: (px: number, side: boolean) => void, onClose: () => void}} hooks
 */
export function createSheet({onResize, onClose}) {
  const sheet = document.getElementById('sheet');
  const body = document.getElementById('sheet-body');
  const title = document.getElementById('sheet-title');
  const handle = document.getElementById('sheet-handle');
  const head = sheet.querySelector('.sheet-head');
  let snap = 'closed';
  let owner = null;

  const heightFor = s => {
    const max = sheet.clientHeight || window.innerHeight * 0.8;
    return s === 'peek' ? Math.min(240, max) : s === 'half' ? Math.round(max * 0.55) : s === 'full' ? max : 0;
  };

  function apply(px) {
    const side = sideMode();
    document.documentElement.style.setProperty('--sheet-h', `${side ? 0 : px}px`);
    document.body.classList.toggle('sheet-open', snap !== 'closed');
    onResize?.(snap === 'closed' ? 0 : side ? sheet.getBoundingClientRect().right : px, side);
  }

  function setSnap(s) {
    snap = s;
    sheet.dataset.snap = s;
    sheet.setAttribute('aria-hidden', String(s === 'closed'));
    apply(heightFor(s));
  }

  /**
   * Show content. owner identifies the view so callers can tell whether they still own the sheet.
   * @param {{owner: string, title: string, content: Node, snap?: string, focus?: boolean, force?: boolean}} o
   *   force: use snap even when the sheet is currently taller.
   */
  function open({owner: o, title: t, content, snap: s = 'half', focus = false, force = false}) {
    owner = o;
    title.textContent = t;
    body.replaceChildren(content);
    body.scrollTop = 0;
    const keep = !force && snap !== 'closed' && SNAPS.indexOf(snap) > SNAPS.indexOf(s);
    setSnap(keep ? snap : s);
    if (focus) body.focus({preventScroll: true});
  }

  function close() {
    if (snap === 'closed') return;
    owner = null;
    setSnap('closed');
    onClose?.();
  }

  function step(dir) {
    const i = SNAPS.indexOf(snap);
    if (dir < 0 && i <= 0) return close();
    setSnap(SNAPS[Math.max(0, Math.min(SNAPS.length - 1, i + dir))]);
  }

  // Drag on the header (not on buttons). Snap to the nearest height on release; fling down past peek closes.
  // Pointer capture starts only once the pointer has moved: capturing on pointerdown would retarget a plain
  // tap's click from the handle to the header, so tapping the handle would do nothing.
  let start = null;
  let dragged = false; // the last gesture was a drag: swallow the click that may follow it
  head.addEventListener('pointerdown', e => {
    dragged = false;
    if (sideMode() || e.target.closest('#sheet-close')) return;
    start = {y: e.clientY, h: heightFor(snap), moved: false};
  });
  head.addEventListener('pointermove', e => {
    if (!start) return;
    const dy = e.clientY - start.y;
    if (!start.moved && Math.abs(dy) > 4) { start.moved = true; sheet.classList.add('dragging'); head.setPointerCapture(e.pointerId); }
    if (start.moved) apply(Math.max(60, Math.min(heightFor('full'), start.h - dy)));
  });
  const end = e => {
    if (!start) return;
    const moved = start.moved;
    const h = start.h - (e.clientY - start.y);
    start = null;
    dragged = moved;
    sheet.classList.remove('dragging');
    if (!moved) return;
    if (h < heightFor('peek') * 0.6) return close();
    const best = SNAPS.reduce((a, b) => (Math.abs(heightFor(b) - h) < Math.abs(heightFor(a) - h) ? b : a));
    setSnap(best);
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);

  handle.addEventListener('click', () => { if (!dragged) step(snap === 'full' ? -2 : 1); });
  head.addEventListener('click', () => { dragged = false; }); // bubbles after the handle's listener, wherever the click lands
  handle.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp') { e.preventDefault(); step(1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
  });
  document.getElementById('sheet-close').addEventListener('click', close);
  sheet.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', () => apply(heightFor(snap)));

  return {open, close, setSnap, get snap() { return snap; }, get owner() { return owner; }, body};
}
