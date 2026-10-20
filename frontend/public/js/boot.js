/* Runs before first paint: restores the sidebar state so the layout does not jump. Kept as a file (not inline) because the
   Content-Security-Policy forbids inline scripts. */
(function () {
  try {
    var saved = window.localStorage.getItem('dv.sidebar');
    // With no saved choice, laptops start with the narrow sidebar so the workspace has room; the choice is remembered once made.
    if (saved === 'collapsed' || (!saved && window.innerWidth >= 992 && window.innerWidth < 1280)) {
      document.documentElement.setAttribute('data-sidebar', 'collapsed');
    }
  } catch (e) { /* storage blocked: keep the default */ }
})();
