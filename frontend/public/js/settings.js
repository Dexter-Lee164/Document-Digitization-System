/* Settings: defaults, export preferences, password change, service status. */
(function () {
  'use strict';
  const { $, h } = DV;

  const root = $('#settings');
  $('#s-preset').value = root.dataset.preset;
  $('#s-type').value = root.dataset.type;
  $('#s-reflow').checked = root.dataset.reflow === '1';
  $('#s-fulltext').checked = root.dataset.fulltext === '1';
  if (![...$('#s-preset').options].some((o) => o.value === root.dataset.preset)) $('#s-preset').value = 'automatic';

  function showError(el, message) {
    el.classList.toggle('d-none', !message);
    el.replaceChildren(...(message ? [DV.icon('exclamation-octagon-fill'), h('div', null, message)] : []));
  }

  $('#defaults-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#defaults-error');
    showError(err, '');
    const btn = e.submitter || e.target.querySelector('button[type=submit]');
    DV.setBusy(btn, true, 'Saving');
    try {
      await DV.api('PUT', '/api/settings', { json: {
        default_preset: $('#s-preset').value, default_document_type: $('#s-type').value,
        export_reflow: $('#s-reflow').checked, export_include_full_text: $('#s-fulltext').checked, export_filename_suffix: $('#s-suffix').value,
      } });
      DV.toast('Defaults saved.', 'success');
    } catch (ex) { showError(err, DV.errorMessage(ex)); } finally { DV.setBusy(btn, false); }
  });

  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#password-error');
    showError(err, '');
    const current = $('#pw-current').value;
    const next = $('#pw-new').value;
    const confirm = $('#pw-confirm').value;
    if (!current) return showError(err, 'Enter your current password.');
    if (next.length < 8 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return showError(err, 'The new password needs at least 8 characters, with a letter and a number.');
    if (next !== confirm) return showError(err, 'The two new passwords do not match.');
    const btn = e.submitter || e.target.querySelector('button[type=submit]');
    DV.setBusy(btn, true, 'Changing');
    try {
      const res = await DV.api('POST', '/api/settings/password', { json: { current_password: current, new_password: next, confirm_password: confirm } });
      DV.setCsrf(res.csrfToken); // the session was rotated, so the old security token is no longer valid
      e.target.reset();
      DV.toast('Password changed. Other devices were signed out.', 'success');
    } catch (ex) { showError(err, DV.errorMessage(ex)); } finally { DV.setBusy(btn, false); }
    return undefined;
  });

  function row(label, status, detail) {
    const tone = status === 'ok' ? 'success' : status === 'degraded' ? 'warning' : 'danger';
    const text = status === 'ok' ? 'Running' : status === 'degraded' ? 'Limited' : 'Not available';
    return h('div.d-flex.justify-content-between.align-items-start.gap-3.py-2.border-bottom', null,
      h('div', null, h('div.fw-semibold', null, label), h('div.small.text-slate', null, detail || '')),
      h(`span.dv-badge.dv-badge-${tone}`, null, text));
  }

  async function services() {
    const box = $('#services');
    try {
      const s = await DV.api('GET', '/api/health');
      const cv = s.cv_service;
      box.replaceChildren(
        row('Web app', 'ok', `Node.js ${s.node.version}`),
        row('Database', s.database.status === 'ok' ? 'ok' : 'down', 'SQLite'),
        row('Image processing', cv.status === 'offline' ? 'down' : 'ok', cv.status === 'offline' ? 'Start it with "npm run start:cv".' : `OpenCV ${cv.opencv}`),
        row('Text recognition', s.ocr.available ? 'ok' : cv.status === 'offline' ? 'down' : 'degraded', s.ocr.available ? `Tesseract ${s.ocr.version}, languages: ${(s.ocr.languages || []).join(', ')}` : (s.ocr.error || 'Tesseract was not found. See INSTALLATION.md.')));
      box.lastElementChild.classList.remove('border-bottom');
    } catch (ex) { box.replaceChildren(h('p.text-danger.small.mb-0', null, DV.errorMessage(ex))); }
  }
  $('#btn-recheck').addEventListener('click', services);
  services();
})();
