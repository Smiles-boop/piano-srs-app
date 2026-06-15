// PianoSRS — engraved sheet-music view (OpenSheetMusicDisplay wrapper).
//
// createSheetView(host) renders a MusicXML score into `host` and exposes a
// small API the app drives from the practice engine:
//   load(xml, ticksPerQuarter)  → render the score, index cursor stops by tick
//   highlightMeasures(a, b)      → tint measures a..b (0-based) and scroll there
//   moveCursorToTick(tick)       → snap the follow-cursor to the onset at tick
//   clearCursor() / clearHighlight() / isReady()
//
// Two implementation notes:
//   - Section highlights are injected as <rect>s INTO the rendered <svg>, in
//     its viewBox coordinate space, so they scale with the score and never
//     drift when the container resizes.
//   - The cursor is OSMD's built-in cursor. We pre-walk it once after render to
//     record the absolute MIDI tick at every stop, so moveCursorToTick can snap
//     to the nearest onset in O(log n) + a few steps.

function createSheetView(host) {
  const OSMD =
    window.opensheetmusicdisplay && window.opensheetmusicdisplay.OpenSheetMusicDisplay;

  let osmd = null;
  let loadToken = 0;      // guards against overlapping load() calls
  let ready = false;
  let stopTicks = [];     // absolute tick at each cursor stop, in order
  let currentStop = -1;   // index of the cursor's current stop
  let scale = 10;         // OSMD units → SVG viewBox units (UnitInPixels)
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** True if OSMD is available + a score has rendered. */
  function isReady() {
    return ready;
  }

  async function load(xml, ticksPerQuarter) {
    if (!OSMD) throw new Error('OpenSheetMusicDisplay failed to load');
    ready = false;
    const token = ++loadToken;
    host.innerHTML = '';
    osmd = new OSMD(host, {
      autoResize: false,         // render once; toggling views is CSS-only
      backend: 'svg',
      drawTitle: false,
      drawPartNames: false,
      drawingParameters: 'compacttight',
    });
    await osmd.load(xml);
    if (token !== loadToken) return false; // superseded by a newer load
    osmd.render();
    scale = (osmd.EngravingRules && osmd.EngravingRules.UnitInPixels) || 10;
    indexCursorStops(ticksPerQuarter || 480);
    if (osmd.cursor) osmd.cursor.hide();
    ready = true;
    return true;
  }

  /** Walk the cursor once, recording the absolute tick at each stop. */
  function indexCursorStops(tpq) {
    stopTicks = [];
    currentStop = -1;
    const cur = osmd.cursor;
    if (!cur) return;
    cur.reset();
    let guard = 0;
    while (!cur.iterator.EndReached && guard++ < 200000) {
      const ts = cur.iterator.currentTimeStamp;
      // realValue = position in whole notes; 1 whole note = 4 quarters.
      stopTicks.push(Math.round(ts.realValue * 4 * tpq));
      cur.next();
    }
    cur.reset();
    cur.hide();
  }

  /** Index of the last cursor stop at or before `tick` (binary search). */
  function stopIndexForTick(tick) {
    if (!stopTicks.length) return -1;
    let lo = 0;
    let hi = stopTicks.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (stopTicks[mid] <= tick) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function moveCursorToTick(tick) {
    if (!ready || !osmd.cursor) return;
    const target = stopIndexForTick(tick);
    if (target < 0) return;
    const cur = osmd.cursor;
    if (target < currentStop) { cur.reset(); currentStop = -1; }
    while (currentStop < target) { cur.next(); currentStop++; }
    cur.show();
    const el = cur.cursorElement;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function clearCursor() {
    if (osmd && osmd.cursor) {
      osmd.cursor.reset();
      osmd.cursor.hide();
      currentStop = -1;
    }
  }

  /** The <g> we inject highlight rects into (created lazily inside the SVG). */
  function highlightGroup() {
    const svg = host.querySelector('svg');
    if (!svg) return null;
    let g = svg.querySelector('#sheet-highlight');
    if (!g) {
      g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('id', 'sheet-highlight');
      svg.insertBefore(g, svg.firstChild); // behind the notes
    }
    return g;
  }

  /** Union the bounding boxes of every staff-measure at measure index `mi`. */
  function measureBox(mi) {
    const list = osmd.GraphicSheet && osmd.GraphicSheet.MeasureList;
    if (!list || !list[mi]) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const gm of list[mi]) {
      if (!gm || !gm.PositionAndShape) continue;
      const ps = gm.PositionAndShape;
      const x = ps.AbsolutePosition.x;
      const y = ps.AbsolutePosition.y;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + ps.Size.width);
      y1 = Math.max(y1, y + ps.Size.height);
    }
    if (!Number.isFinite(x0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function highlightMeasures(firstIdx, lastIdx) {
    if (!ready) return;
    const g = highlightGroup();
    if (!g) return;
    g.innerHTML = '';
    let firstRect = null;
    for (let mi = firstIdx; mi <= lastIdx; mi++) {
      const b = measureBox(mi);
      if (!b) continue;
      const rect = document.createElementNS(SVG_NS, 'rect');
      // Pad a touch so the tint frames the staff rather than clipping it.
      rect.setAttribute('x', (b.x * scale - 2).toFixed(1));
      rect.setAttribute('y', (b.y * scale - 2).toFixed(1));
      rect.setAttribute('width', (b.w * scale + 4).toFixed(1));
      rect.setAttribute('height', (b.h * scale + 4).toFixed(1));
      rect.setAttribute('rx', '3');
      rect.setAttribute('class', 'sheet-measure-highlight');
      g.appendChild(rect);
      if (!firstRect) firstRect = rect;
    }
    if (firstRect && typeof firstRect.scrollIntoView === 'function') {
      firstRect.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function clearHighlight() {
    const svg = host.querySelector('svg');
    const g = svg && svg.querySelector('#sheet-highlight');
    if (g) g.innerHTML = '';
  }

  function dispose() {
    clearHighlight();
    clearCursor();
    host.innerHTML = '';
    osmd = null;
    ready = false;
  }

  return {
    load,
    isReady,
    moveCursorToTick,
    clearCursor,
    highlightMeasures,
    clearHighlight,
    dispose,
  };
}
