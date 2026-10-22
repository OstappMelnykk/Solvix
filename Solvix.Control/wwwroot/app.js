window.solvixScrollToEnd = (id) => { const el = document.getElementById(id); if (el) el.scrollTop = el.scrollHeight; };
window.solvixFocus = (el) => { if (el) el.focus(); };
window.solvixPref = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { } },
};
window.solvixTerm = {
  // Resize by any edge or corner (the .rz handles). West/north edges also move the window so the
  // opposite edge stays put. Works on the DOM while dragging; reports the final geometry once.
  enableResize(el, ref) {
    const MIN_W = 320, MIN_H = 160;
    el.querySelectorAll('.rz').forEach((handle) => {
      handle.addEventListener('pointerdown', (down) => {
        if (down.button !== 0) { return; }
        down.preventDefault();
        const dir = handle.dataset.dir;
        const startX = down.clientX, startY = down.clientY;
        const w0 = el.offsetWidth, h0 = el.offsetHeight;
        const l0 = parseInt(el.style.left || '0', 10), t0 = parseInt(el.style.top || '0', 10);
        const maxW = Math.max(MIN_W, window.innerWidth - 8);
        handle.setPointerCapture(down.pointerId);
        const move = (e) => {
          const dx = e.clientX - startX, dy = e.clientY - startY;
          let w = w0, h = h0, l = l0, t = t0;
          if (dir.includes('e')) { w = w0 + dx; }
          if (dir.includes('s')) { h = h0 + dy; }
          if (dir.includes('w')) { w = w0 - dx; l = l0 + dx; }
          if (dir.includes('n')) { h = h0 - dy; t = t0 + dy; }
          const cw = Math.min(maxW, Math.max(MIN_W, w)), ch = Math.max(MIN_H, h);
          // when clamped, keep the fixed edge fixed
          if (dir.includes('w')) { l = l0 + (w0 - cw); }
          if (dir.includes('n')) { t = t0 + (h0 - ch); }
          el.style.width = cw + 'px'; el.style.height = ch + 'px';
          el.style.left = l + 'px'; el.style.top = t + 'px';
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          const available = el.parentElement ? el.parentElement.clientWidth : el.offsetWidth;
          ref.invokeMethodAsync('OnGeometry',
            parseInt(el.style.left || '0', 10), parseInt(el.style.top || '0', 10),
            Math.round(el.offsetWidth), Math.round(el.offsetHeight), Math.round(available));
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    });
  },
  viewportHeight() { return window.innerHeight; },
  // Drag the window by its title bar. Moves via left/top while dragging (no server round-trip),
  // reports the final offset once on release. The bar always stays reachable inside the viewport.
  enableDrag(el, ref) {
    const bar = el.querySelector('.titlebar');
    if (!bar) { return; }
    bar.addEventListener('pointerdown', (down) => {
      if (down.button !== 0 || down.target.closest('select, button, input, a')) { return; }
      const startX = down.clientX, startY = down.clientY;
      const baseLeft = parseInt(el.style.left || '0', 10), baseTop = parseInt(el.style.top || '0', 10);
      bar.setPointerCapture(down.pointerId);
      const move = (e) => {
        el.style.left = (baseLeft + e.clientX - startX) + 'px';
        el.style.top = (baseTop + e.clientY - startY) + 'px';
        const r = el.getBoundingClientRect();
        if (r.top < 0) { el.style.top = (parseInt(el.style.top, 10) - r.top) + 'px'; }
        if (r.left > window.innerWidth - 80) { el.style.left = (parseInt(el.style.left, 10) - (r.left - (window.innerWidth - 80))) + 'px'; }
        if (r.right < 80) { el.style.left = (parseInt(el.style.left, 10) + (80 - r.right)) + 'px'; }
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        ref.invokeMethodAsync('OnMoved', parseInt(el.style.left || '0', 10), parseInt(el.style.top || '0', 10));
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest('select, button, input, a')) { return; }
      el.style.left = '0px'; el.style.top = '0px';
      ref.invokeMethodAsync('OnMoved', 0, 0);
    });
  },
};
