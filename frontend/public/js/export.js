/* Export page: choose layout and file name, preview, create the .docx on the server, list and download earlier exports. */
(function () {
  'use strict';
  const { $, h, fmt } = DV;

  const root = $('#ex');
  const docId = Number(root.dataset.docId);
  const api = (method, path, opts) => DV.api(method, `/api/documents/${docId}${path}`, opts);

  const els = {
    alert: $('#ex-alert'), badges: $('#ex-badges'), fname: $('#fname'), reflow: $('#reflow'), fulltext: $('#fulltext'), fulltextRow: $('#fulltext-row'),
    create: $('#btn-create'), error: $('#ex-error'), paper: $('#paper'), history: $('#history'), resultPanel: $('#result-panel'), resultBody: $('#result-body'),
    choiceForm: $('#choice-form'), formNote: $('#form-choice-note'),
  };
  const state = { ocr: null, doc: null, form: null, busy: false };

  els.reflow.checked = root.dataset.reflow === '1';
  els.fulltext.checked = root.dataset.fulltext === '1';
  const stem = root.dataset.name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  els.fname.value = `${stem}${root.dataset.suffix}`;

  const type = () => document.querySelector('input[name="etype"]:checked').value;

  /* Same paragraph rule as the server (export/docx_generator.split_paragraphs). */
  function paragraphs(text, reflow) {
    const t = text.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
    if (!t.trim()) return [];
    return t.split(/\n[ \t]*\n+/).map((block) => {
      const lines = block.split('\n').map((l) => l.replace(/\s+$/, ''));
      return reflow ? lines.map((l) => l.trim()).filter(Boolean).join(' ') : lines.join('\n').replace(/^\n+|\n+$/g, '');
    }).filter((p) => p.trim());
  }

  function renderPreview() {
    els.paper.replaceChildren();
    if (!state.ocr) return;
    const reflow = els.reflow.checked;
    const t = type();
    els.fulltextRow.classList.toggle('d-none', t !== 'form');
    if (t === 'form' && state.form) {
      els.paper.append(h('p.ttl', null, (state.form.title || 'Form').toUpperCase()));
      els.paper.append(h('table', null, h('tbody', null,
        h('tr', null, h('th', null, 'Field'), h('th', null, 'Value')),
        state.form.fields.map((f) => h('tr', null, h('td', null, h('b', null, f.label)), h('td', null, f.value || ' '))))));
      if (els.fulltext.checked && state.ocr.corrected_text.trim()) {
        els.paper.append(h('p', null, h('b', null, 'Other recognized text')));
        paragraphs(state.ocr.corrected_text, reflow).forEach((p) => els.paper.append(h('p', null, p)));
      }
    } else {
      paragraphs(state.ocr.corrected_text, reflow).forEach((p) => els.paper.append(h('p', null, p)));
    }
    els.paper.append(h('div.dv-paper-fade'));
  }

  function notice(tone, message) {
    els.alert.replaceChildren(h(`div.dv-notice.dv-notice-${tone}.mb-3`, { role: tone === 'bad' ? 'alert' : 'status' }, DV.icon(tone === 'warn' ? 'exclamation-triangle-fill' : 'info-circle-fill'), h('div', null, message)));
  }

  function download(item) {
    return h('a.btn.btn-sm.btn-primary', { href: item.download_url, download: item.filename }, DV.icon('download', 'me-1'), 'Download');
  }

  async function loadHistory() {
    const { items } = await api('GET', '/exports');
    if (!items.length) {
      els.history.replaceChildren(h('div.dv-empty', { style: 'padding:1.5rem' }, h('p.mb-0', null, 'Nothing exported yet.')));
      return;
    }
    els.history.replaceChildren(...items.map((it) => h('div.dv-export-row', null,
      DV.icon('file-earmark-word', 'fs-4 text-primary'),
      h('div.grow', null, h('div.fw-semibold.dv-ellipsis', { title: it.filename }, it.filename), h('div.small.text-slate', null, `${it.export_type === 'form' ? 'Form table' : 'Text document'}, ${fmt.date(it.created_at)}`)),
      download(it),
      h('button.btn.btn-sm.btn-outline-secondary', { type: 'button', 'aria-label': `Delete ${it.filename}`, title: 'Delete this export', onclick: async () => {
        const ok = await DV.confirm({ title: 'Delete this export?', message: `"${it.filename}" will be removed from DocuVision. Copies you already downloaded are not affected.`, confirmText: 'Delete', danger: true });
        if (!ok) return;
        try { await DV.api('DELETE', `/api/exports/${it.id}`); DV.toast('Export deleted.', 'success'); loadHistory(); } catch (err) { DV.toast(DV.errorMessage(err), 'danger'); }
      } }, DV.icon('trash')))));
  }

  async function init() {
    try {
      const [detail, ocrRes] = await Promise.all([api('GET', ''), api('GET', '/ocr')]);
      state.doc = detail.document; state.ocr = ocrRes.ocr;
    } catch (err) {
      if (err.status === 404) notice('warn', 'There is no recognised text to export yet. Process the page and review the text first.');
      else notice('bad', DV.errorMessage(err));
      loadHistory().catch(() => {});
      return;
    }
    els.badges.replaceChildren(DV.badge('review', state.doc.review_status));
    if (state.doc.review_status !== 'reviewed') {
      notice('info', 'You have not marked this text as reviewed. You can still export it; it is worth a quick check first.');
    }
    const form = state.ocr.form;
    state.form = form && form.matched && form.fields && form.fields.length ? form : null;
    if (!state.form) {
      els.choiceForm.querySelector('input').disabled = true;
      els.choiceForm.style.opacity = '0.55';
      els.formNote.textContent = state.doc.document_type === 'form'
        ? 'Not available: this page did not match the form template, so no fields were read.'
        : 'Not available: this document was read as general text, not as a structured form.';
    } else {
      document.querySelector('input[name="etype"][value="form"]').checked = true;
    }
    els.create.disabled = false;
    renderPreview();
    loadHistory().catch(() => {});
  }

  document.querySelectorAll('input[name="etype"]').forEach((r) => r.addEventListener('change', renderPreview));
  els.reflow.addEventListener('change', renderPreview);
  els.fulltext.addEventListener('change', renderPreview);

  els.create.addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    els.error.classList.add('d-none');
    DV.setBusy(els.create, true, 'Creating the document');
    try {
      const res = await api('POST', '/export', { json: { type: type(), filename: els.fname.value.trim() || undefined, reflow: els.reflow.checked, include_full_text: els.fulltext.checked } });
      const v = res.verification || {};
      els.resultPanel.classList.remove('d-none');
      els.resultBody.replaceChildren(
        h('div.d-flex.align-items-center.gap-3.mb-3', null, DV.icon('file-earmark-word', 'fs-1 text-primary'),
          h('div.grow', { style: 'min-width:0' }, h('div.fw-semibold.dv-ellipsis', { title: res.export.filename }, res.export.filename), h('div.small.text-slate', null, `${fmt.bytes(res.bytes)}, created just now`))),
        download(res.export),
        h('ul.small.mt-3.mb-0.ps-3', null,
          h('li', null, `Font: ${v.font_ok ? 'Times New Roman 12 pt on every line (checked after saving)' : 'check failed'}`),
          h('li', null, `Page: ${v.a4 ? 'A4 (21 x 29.7 cm)' : 'check failed'}`),
          h('li', null, 'The text is real, editable Word text, not a picture.')));
      DV.toast('Word document created.', 'success');
      loadHistory().catch(() => {});
    } catch (err) {
      els.error.replaceChildren(DV.icon('exclamation-octagon-fill'), h('div', null, DV.errorMessage(err)));
      els.error.classList.remove('d-none');
    } finally {
      state.busy = false;
      DV.setBusy(els.create, false);
    }
  });

  init();
})();
