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
};
