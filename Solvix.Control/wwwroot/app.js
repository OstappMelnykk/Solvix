window.solvixScrollToEnd = (id) => { const el = document.getElementById(id); if (el) el.scrollTop = el.scrollHeight; };
window.solvixFocus = (el) => { if (el) el.focus(); };
window.solvixPref = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { } },
};
window.solvixTerm = {
  MIN_W: 320, MIN_H: 160, MARGIN: 8,

  // Where the window may be, in document coordinates: inside the viewport horizontally, never above
  // the row of command presets, never below the bottom of the visible screen.
  limits(el) {
    const chips = document.querySelector('.chips');
    const top = chips ? chips.getBoundingClientRect().bottom + window.scrollY + 6 : 0;
    const bottom = Math.max(window.scrollY + window.innerHeight - this.MARGIN, top + this.MIN_H);
    // The natural position (left/top offsets = 0) of the window, so offsets can be derived from absolutes.
    const r = el.getBoundingClientRect();
    const l = parseInt(el.style.left || '0', 10), t = parseInt(el.style.top || '0', 10);
    return {
      minL: this.MARGIN, maxR: window.innerWidth - this.MARGIN, minT: top, maxB: bottom,
      originX: r.left - l, originY: r.top + window.scrollY - t,
    };
  },

  // Applies a rect given in document coordinates (L,T,R,B) as width/height/left/top.
  apply(el, lim, L, T, R, B) {
    el.style.width = Math.round(R - L) + 'px';
    el.style.height = Math.round(B - T) + 'px';
    el.style.left = Math.round(L - lim.originX) + 'px';
    el.style.top = Math.round(T - lim.originY) + 'px';
  },

  geometry(el) {
    const available = el.parentElement ? el.parentElement.clientWidth : el.offsetWidth;
    return [parseInt(el.style.left || '0', 10), parseInt(el.style.top || '0', 10),
            Math.round(el.offsetWidth), Math.round(el.offsetHeight), Math.round(available)];
  },

  // Pulls the window back into the allowed area. Returns true when it had to move or shrink it.
  fit(el) {
    const lim = this.limits(el);
    const before = [el.style.left, el.style.top, el.style.width, el.style.height].join('|');
    let w = Math.min(Math.max(el.offsetWidth, this.MIN_W), lim.maxR - lim.minL);
    let h = Math.min(Math.max(el.offsetHeight, this.MIN_H), lim.maxB - lim.minT);
    const r = el.getBoundingClientRect();
    let L = r.left, T = r.top + window.scrollY;
    L = Math.min(Math.max(L, lim.minL), lim.maxR - w);
    T = Math.min(Math.max(T, lim.minT), lim.maxB - h);
    // keep a full-width window full-width instead of freezing it at today's pixel width
    const fullWidth = el.style.width === '100%' && w >= el.parentElement.clientWidth - 3;
    this.apply(el, lim, L, T, L + w, T + h);
    if (fullWidth) { el.style.width = '100%'; }
    return before !== [el.style.left, el.style.top, el.style.width, el.style.height].join('|');
  },

  // Keeps the window reachable: on load, and whenever the browser window changes size.
  keepVisible(el, ref) {
    const run = () => { if (this.fit(el)) { ref.invokeMethodAsync('OnGeometry', ...this.geometry(el)); } };
    run();
    setTimeout(run, 400);   // once more after the saved geometry has been rendered
    let timer;
    window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(run, 200); });
  },

  // Resize by any edge or corner (the .rz handles). The edge that isn't dragged stays put.
  enableResize(el, ref) {
    const self = this;
    el.querySelectorAll('.rz').forEach((handle) => {
      handle.addEventListener('pointerdown', (down) => {
        if (down.button !== 0) { return; }
        down.preventDefault();
        const dir = handle.dataset.dir;
        const lim = self.limits(el);
        const r = el.getBoundingClientRect();
        const L0 = r.left, T0 = r.top + window.scrollY, R0 = r.right, B0 = r.bottom + window.scrollY;
        const sx = down.clientX, sy = down.clientY;
        handle.setPointerCapture(down.pointerId);
        const move = (e) => {
          const dx = e.clientX - sx, dy = e.clientY - sy;
          let L = L0, T = T0, R = R0, B = B0;
          if (dir.includes('e')) { R = Math.min(Math.max(R0 + dx, L0 + self.MIN_W), lim.maxR); }
          if (dir.includes('w')) { L = Math.max(Math.min(L0 + dx, R0 - self.MIN_W), lim.minL); }
          if (dir.includes('s')) { B = Math.min(Math.max(B0 + dy, T0 + self.MIN_H), lim.maxB); }
          if (dir.includes('n')) { T = Math.max(Math.min(T0 + dy, B0 - self.MIN_H), lim.minT); }
          self.apply(el, lim, L, T, R, B);
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          ref.invokeMethodAsync('OnGeometry', ...self.geometry(el));
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    });
  },

  // Drag by the title bar, kept entirely inside the allowed area.
  enableDrag(el, ref) {
    const self = this;
    const bar = el.querySelector('.titlebar');
    if (!bar) { return; }
    bar.addEventListener('pointerdown', (down) => {
      if (down.button !== 0 || down.target.closest('select, button, input, a')) { return; }
      const lim = self.limits(el);
      const r = el.getBoundingClientRect();
      const L0 = r.left, T0 = r.top + window.scrollY, w = r.width, h = r.height;
      const sx = down.clientX, sy = down.clientY;
      bar.setPointerCapture(down.pointerId);
      const move = (e) => {
        const L = Math.min(Math.max(L0 + e.clientX - sx, lim.minL), Math.max(lim.minL, lim.maxR - w));
        const T = Math.min(Math.max(T0 + e.clientY - sy, lim.minT), Math.max(lim.minT, lim.maxB - h));
        self.apply(el, lim, L, T, L + w, T + h);
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        ref.invokeMethodAsync('OnGeometry', ...self.geometry(el));
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest('select, button, input, a')) { return; }
      el.style.left = '0px'; el.style.top = '0px';
      self.fit(el);
      ref.invokeMethodAsync('OnGeometry', ...self.geometry(el));
    });
  },

  // Re-checks the window shortly after the server changed its size or position.
  refit(el, ref) {
    setTimeout(() => { if (this.fit(el)) { ref.invokeMethodAsync('OnGeometry', ...this.geometry(el)); } }, 150);
  },

  viewportHeight() { return window.innerHeight; },
  // Space between the top of the window's natural position and the bottom of the screen.
  availableHeight(el) {
    const lim = this.limits(el);
    return Math.round(lim.maxB - lim.minT);
  },
};
