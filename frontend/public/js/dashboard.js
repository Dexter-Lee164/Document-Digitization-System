/* Dashboard: turn the ISO timestamps rendered by the server into relative times in the user's locale. */
(function () {
  'use strict';
  document.querySelectorAll('[data-ago]').forEach((cell) => {
    const text = DV.fmt.ago(cell.dataset.ago);
    if (text) { cell.textContent = text; cell.title = DV.fmt.date(cell.dataset.ago); }
  });
})();
