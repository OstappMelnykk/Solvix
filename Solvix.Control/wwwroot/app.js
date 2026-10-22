window.solvixScrollToEnd = (id) => { const el = document.getElementById(id); if (el) el.scrollTop = el.scrollHeight; };
window.solvixFocus = (el) => { if (el) el.focus(); };
window.solvixPref = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { } },
};
window.solvixTerm = {
  // Reports the window's size (px) after the user drags its corner, once they stop.
  observe(el, ref) {
    let timer;
    const report = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const available = el.parentElement ? el.parentElement.clientWidth : el.offsetWidth;
        ref.invokeMethodAsync('OnResized', Math.round(el.offsetWidth), Math.round(el.offsetHeight), Math.round(available));
      }, 300);
    };
    const observer = new ResizeObserver(report);
    observer.observe(el);
    el._solvixObserver = observer;
  },
  unobserve(el) { if (el && el._solvixObserver) { el._solvixObserver.disconnect(); el._solvixObserver = null; } },
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
