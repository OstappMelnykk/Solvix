window.solvixScrollToEnd = (id) => { const el = document.getElementById(id); if (el) el.scrollTop = el.scrollHeight; };
window.solvixFocus = (el) => { if (el) el.focus(); };
window.solvixPref = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { } },
};
