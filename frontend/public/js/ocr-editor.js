/* OCR review: editable text with low-confidence highlighting (aligned to the OCR word list), structured form fields,
   word boxes drawn on the enhanced page, save / reset / re-read. */
(function () {
  'use strict';
  const { $, $$, h, fmt } = DV;

  const root = $('#rv');
  const docId = Number(root.dataset.docId);
  const api = (method, path, opts) => DV.api(method, `/api/documents/${docId}${path}`, opts);

  const els = {
    text: $('#text'), hl: $('#hl'), textbox: $('#textbox'), stats: $('#rv-stats'), count: $('#rv-count'), dirty: $('#rv-dirty'),
    lowlist: $('#lowlist'), meta: $('#rv-meta'), alert: $('#rv-alert'), fields: $('#fields'), fieldsNote: $('#fields-note'), formNote: $('#rv-form-note'),
    save: $('#btn-save'), reviewed: $('#btn-reviewed'), reset: $('#btn-reset'), reocr: $('#btn-reocr'), psm: $('#rv-psm'), goExport: $('#go-export'),
    tabText: $('#tab-text'), tabFields: $('#tab-fields'), paneText: $('#pane-text'), paneFields: $('#pane-fields'),
    showLow: $('#show-low'), showAll: $('#show-all'),
  };

  const viewer = new DV.PageViewer($('#rv-view'), { editable: false, label: 'Enhanced page with the words the OCR engine read. Click a box to find it in the text.' });
  viewer.root.style.height = 'clamp(420px, 70vh, 820px)';

  const state = {
    ocr: null, doc: null, savedText: '', savedFields: [], fields: [], aligned: [], selectedWord: -1, selectedField: null, busy: false,
  };

  /* ------------------------------------------------------------ notices + header */
  function notice(tone, message) {
    els.alert.replaceChildren(h(`div.dv-notice.dv-notice-${tone}.mb-3`, { role: tone === 'bad' ? 'alert' : 'status' },
      DV.icon(tone === 'bad' ? 'exclamation-octagon-fill' : tone === 'warn' ? 'exclamation-triangle-fill' : tone === 'ok' ? 'check-circle-fill' : 'info-circle-fill'),
      h('div', null, message)));
  }
  const clearNotice = () => els.alert.replaceChildren();

  function renderHeader() {
    const d = state.doc;
    if (!d) return;
    els.meta.replaceChildren(DV.badge('processing', d.processing_status), DV.badge('review', d.review_status), h('span', null, DV.typeLabel(d.document_type)));
    const ready = Boolean(state.ocr);
    els.goExport.classList.toggle('disabled', !ready);
    els.goExport.setAttribute('aria-disabled', String(!ready));
  }

  /* ------------------------------------------------------------ dirty state */
  const currentFieldValues = () => state.fields.map((f) => f.value);
  function isDirty() {
    if (!state.ocr) return false;
    return els.text.value !== state.savedText || JSON.stringify(currentFieldValues()) !== JSON.stringify(state.savedFields);
  }
  function updateButtons() {
    const dirty = isDirty();
    const ready = Boolean(state.ocr) && !state.busy;
    els.save.disabled = !ready || !dirty;
    els.reviewed.disabled = !ready || (!dirty && state.doc && state.doc.review_status === 'reviewed');
    const edited = state.ocr && (els.text.value !== state.ocr.original_text || state.fields.some((f) => f.value !== f.original_value));
    els.reset.disabled = !ready || !edited;
    els.reocr.disabled = !ready;
    els.dirty.replaceChildren(...(dirty ? [DV.icon('circle-fill', 'text-warning me-1'), 'Unsaved changes'] : state.ocr ? [DV.icon('check2', 'text-success me-1'), 'All changes saved'] : []));
  }
  window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

  /* ------------------------------------------------------------ text + highlight layer */
  function alignWords(text, words) {
    const out = [];
    let pos = 0;
    for (let i = 0; i < words.length; i += 1) {
      const t = words[i].text;
      if (!t) continue;
      const idx = text.indexOf(t, pos);
      if (idx === -1 || idx - pos > 160) continue; // word was edited away or text diverged: skip it, keep the cursor
      out.push({ i, start: idx, end: idx + t.length });
      pos = idx + t.length;
    }
    return out;
  }

  function renderHighlights() {
    const text = els.text.value;
    state.aligned = state.ocr ? alignWords(text, state.ocr.words) : [];
    const low = state.aligned.filter((a) => state.ocr.words[a.i].low);
    const nodes = [];
    let cursor = 0;
    low.forEach((a) => {
      if (a.start < cursor) return;
      if (a.start > cursor) nodes.push(text.slice(cursor, a.start));
      nodes.push(h('mark', null, text.slice(a.start, a.end)));
      cursor = a.end;
    });
    nodes.push(text.slice(cursor) + '\n​');
    els.hl.replaceChildren(...nodes);
    els.hl.scrollTop = els.text.scrollTop;
    els.hl.scrollLeft = els.text.scrollLeft;
    els.textbox.classList.toggle('is-plain', !els.showLow.checked);
    renderLowList(low.length);
    renderCount();
  }
  const renderHighlightsSoon = DV.debounce(renderHighlights, 120);

  function renderCount() {
    const t = els.text.value;
    const words = t.trim() ? t.trim().split(/\s+/).length : 0;
    els.count.textContent = `${t.length.toLocaleString()} characters, ${words.toLocaleString()} words`;
  }

  function renderLowList() {
    const o = state.ocr;
    if (!o) return;
    const lowAligned = state.aligned.filter((a) => o.words[a.i].low);
    els.lowlist.classList.toggle('d-none', lowAligned.length === 0);
    els.lowlist.replaceChildren(...lowAligned.slice(0, 200).map((a) => {
      const w = o.words[a.i];
      return h('button.dv-chip', { type: 'button', title: 'Show this word on the page', onclick: () => selectWord(a.i, { fromChip: true }) }, w.text, h('small', null, `${Math.round(w.conf)}%`));
    }));
    if (lowAligned.length > 200) els.lowlist.append(h('span.small.text-slate.align-self-center', null, `and ${lowAligned.length - 200} more`));
  }

  els.text.addEventListener('input', () => { updateButtons(); renderHighlightsSoon(); });
  els.text.addEventListener('scroll', () => { els.hl.scrollTop = els.text.scrollTop; els.hl.scrollLeft = els.text.scrollLeft; });

  /* ------------------------------------------------------------ page overlay */
  function boxOf(w, pad = 2) { return { x: w.x - pad, y: w.y - pad, w: w.w + pad * 2, h: w.h + pad * 2 }; }

  function renderOverlay() {
    const o = state.ocr;
    if (!o || !viewer.img) return;
    const list = [];
    if (els.showAll.checked) o.words.forEach((w, i) => { if (w.conf >= 0 && !w.low) list.push({ ...boxOf(w, 1), fill: 'rgba(37,99,235,0.07)', stroke: 'rgba(37,99,235,0.55)', width: 1, word: i }); });
    if (els.showLow.checked) o.words.forEach((w, i) => { if (w.low) list.push({ ...boxOf(w), word: i }); });
    if (state.selectedWord >= 0) {
      const w = o.words[state.selectedWord];
      if (w) list.push({ ...boxOf(w, 4), fill: 'rgba(37,99,235,0.22)', stroke: '#1d4ed8', width: 2.5, clickable: false });
    }
    if (state.selectedField) list.push({ ...state.selectedField, fill: 'rgba(22,163,74,0.18)', stroke: '#15803d', width: 2.5, clickable: false });
    viewer.setHighlights(list);
  }
  els.showLow.addEventListener('change', () => { renderOverlay(); renderHighlights(); });
  els.showAll.addEventListener('change', renderOverlay);

  viewer.onHighlightClick = (box) => { if (box.word !== undefined) selectWord(box.word, { fromPage: true }); };

  function selectWord(index, { fromChip, fromPage } = {}) {
    const o = state.ocr;
    const w = o && o.words[index];
    if (!w) return;
    state.selectedWord = index;
    state.selectedField = null;
    renderOverlay();
    if (fromChip) viewer.focusBox(boxOf(w, 4), { minScale: Math.max(viewer.fitScale, 0.8) });
    const a = state.aligned.find((x) => x.i === index);
    if (a && (fromPage || fromChip)) {
      activateTab('text');
      els.text.focus({ preventScroll: true });
      els.text.setSelectionRange(a.start, a.end);
      const lineHeight = 0.95 * 16 * 1.65;
      const approxLine = els.text.value.slice(0, a.start).split('\n').length;
      els.text.scrollTop = Math.max(0, approxLine * lineHeight - els.text.clientHeight / 2);
    } else if (!a && fromPage) {
      DV.toast(`"${w.text}" is no longer in the text (it may have been corrected).`, 'info');
    }
  }

  /* ------------------------------------------------------------ stats */
  function renderStats() {
    const c = state.ocr.confidence || {};
    const m = state.ocr.meta || {};
    const stat = (value, label) => h('div', null, h('b', null, value), h('span', null, label));
    els.stats.replaceChildren(
      stat(c.mean === null || c.mean === undefined ? '-' : `${c.mean}%`, 'Mean confidence'),
      stat(c.median === null || c.median === undefined ? '-' : `${c.median}%`, 'Median'),
      stat(String(c.word_count || 0), 'Words read'),
      stat(c.low_confidence_count ? `${c.low_confidence_count} (${fmt.ratio(c.low_confidence_ratio, 1)})` : '0', `Below ${c.threshold || 60}%`),
      stat(m.psm ? String(m.psm) : '-', 'Layout mode'),
      stat(fmt.ms(m.duration_ms), 'OCR time'));
    els.stats.title = 'Confidence is Tesseract\'s own estimate for each word. It shows where to look first, but it is not a measure of accuracy.';
  }

  /* ------------------------------------------------------------ form fields */
  function renderFields() {
    const form = state.ocr.form;
    const has = Boolean(form && form.matched && form.fields && form.fields.length);
    els.tabFields.classList.toggle('d-none', !has);
    els.formNote.classList.toggle('d-none', !(form && !form.matched));
    if (form && !form.matched) {
      els.formNote.replaceChildren(h('div.dv-notice.dv-notice-warn', null, DV.icon('exclamation-triangle-fill'), h('div', null, form.message || 'This page does not match the form template, so it was read as general text.')));
    }
    if (!has) { els.fields.replaceChildren(); return; }
    state.fields = form.fields.map((f) => ({ ...f }));
    state.savedFields = currentFieldValues();
    els.fieldsNote.textContent = `${form.template_name}. ${form.message || ''} Fields marked in amber were empty or read with low confidence.`;
    drawFields();
  }

  function drawFields() {
    els.fields.replaceChildren(...state.fields.map((f, i) => {
      const id = `fld-${f.key}`;
      const input = h('input.form-control', { id, type: 'text', value: f.value, maxlength: 2000, autocomplete: 'off' });
      input.addEventListener('input', () => {
        f.value = input.value;
        wasEl.textContent = f.value !== f.original_value ? `OCR read: ${f.original_value || '(empty)'}` : '';
        reasonEl.classList.toggle('d-none', f.value !== f.original_value); // the user has dealt with it
        updateButtons();
      });
      const wasEl = h('span.was', null, f.value !== f.original_value ? `OCR read: ${f.original_value || '(empty)'}` : '');
      const reasonEl = h('span.reason' + (f.needs_review && f.reason && f.value === f.original_value ? '' : '.d-none'), null, f.reason || '');
      const conf = f.confidence === null || f.confidence === undefined ? 'no text' : `${Math.round(f.confidence)}%`;
      const locate = h('button.btn.btn-outline-secondary', { type: 'button', title: 'Show where this field is on the page', 'aria-label': `Show ${f.label} on the page`, onclick: () => locateField(f) }, DV.icon('crosshair'));
      const restore = h('button.btn.btn-outline-secondary', { type: 'button', title: 'Restore the OCR value', 'aria-label': `Restore OCR value of ${f.label}`, onclick: () => { f.value = f.original_value; input.value = f.value; wasEl.textContent = ''; reasonEl.classList.toggle('d-none', !(f.needs_review && f.reason)); updateButtons(); } }, DV.icon('arrow-counterclockwise'));
      return h(`div.dv-field${f.needs_review ? '.needs-review' : ''}`, null,
        h('label.form-label.m-0', { for: id }, f.label, h('small.text-slate.fw-normal', null, f.needs_review ? `check this one (${conf})` : conf)),
        h('div.dv-field-row', null, input, locate, restore), reasonEl, wasEl);
    }));
  }

  function locateField(f) {
    const size = viewer.imageSize;
    if (!size || !f.region) return;
    const [rx, ry, rw, rh] = f.region;
    const box = { x: rx * size.width, y: ry * size.height, w: rw * size.width, h: rh * size.height };
    state.selectedField = box;
    state.selectedWord = -1;
    renderOverlay();
    viewer.focusBox(box, { minScale: Math.max(viewer.fitScale, 0.6) });
  }

  function activateTab(which) {
    const text = which === 'text';
    els.tabText.setAttribute('aria-selected', String(text));
    els.tabFields.setAttribute('aria-selected', String(!text));
    els.paneText.classList.toggle('d-none', !text);
    els.paneFields.classList.toggle('d-none', text);
  }
  els.tabText.addEventListener('click', () => activateTab('text'));
  els.tabFields.addEventListener('click', () => activateTab('fields'));

  /* ------------------------------------------------------------ load / save */
  function applyOcr(ocr, { keepTab } = {}) {
    state.ocr = ocr;
    els.text.disabled = false;
    els.text.value = ocr.corrected_text;
    state.savedText = ocr.corrected_text;
    els.psm.value = String((ocr.meta && ocr.meta.psm) || (state.doc && state.doc.document_type === 'form' ? 4 : 3));
    renderStats();
    renderFields();
    renderHighlights();
    renderOverlay();
    if (!keepTab) activateTab(ocr.form && ocr.form.matched && ocr.form.fields.length ? 'fields' : 'text');
    const warnings = (ocr.meta && ocr.meta.warnings) || [];
    if (ocr.meta && ocr.meta.empty) notice('warn', 'No text could be read from this page. Try another enhancement preset or layout mode, or check the page corners in the workspace.');
    else if (warnings.length) notice('warn', warnings.join(' '));
    else clearNotice();
    updateButtons();
  }

  async function save({ markReviewed = false } = {}) {
    if (!state.ocr || state.busy) return;
    state.busy = true; updateButtons();
    const body = { corrected_text: els.text.value };
    if (state.fields.length) body.fields = state.fields.map((f) => ({ key: f.key, value: f.value }));
    if (markReviewed) body.review_status = 'reviewed';
    try {
      const res = await api('PATCH', '/ocr', { json: body });
      state.doc = Object.assign({}, state.doc, res.document);
      state.ocr = Object.assign({}, state.ocr, { corrected_text: res.ocr.corrected_text, edited: res.ocr.edited, form: res.ocr.form, updated_at: res.ocr.updated_at });
      state.savedText = res.ocr.corrected_text;
      state.savedFields = currentFieldValues();
      renderHeader();
      DV.toast(markReviewed ? 'Saved and marked as reviewed.' : 'Changes saved.', 'success');
      if (markReviewed) notice('ok', 'This text is marked as reviewed. You can export it to Word now.');
    } catch (err) {
      notice('bad', `Your changes were not saved. ${DV.errorMessage(err)}`);
    } finally { state.busy = false; updateButtons(); }
  }

  els.save.addEventListener('click', () => save());
  els.reviewed.addEventListener('click', () => save({ markReviewed: true }));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!els.save.disabled) save(); }
  });

  els.reset.addEventListener('click', async () => {
    const ok = await DV.confirm({ title: 'Restore the OCR text?', message: 'Your edits to the text and form fields will be replaced by what the OCR engine originally read.', confirmText: 'Restore', danger: true });
    if (!ok) return;
    state.busy = true; updateButtons();
    try {
      const res = await api('PATCH', '/ocr', { json: { reset: true } });
      state.doc = Object.assign({}, state.doc, res.document);
      state.ocr = Object.assign({}, state.ocr, res.ocr);
      applyOcr(state.ocr, { keepTab: true });
      renderHeader();
      DV.toast('Original OCR text restored.', 'success');
    } catch (err) { notice('bad', DV.errorMessage(err)); } finally { state.busy = false; updateButtons(); }
  });

  els.reocr.addEventListener('click', async () => {
    const edited = isDirty() || (state.ocr && state.ocr.edited);
    if (edited) {
      const ok = await DV.confirm({ title: 'Read the page again?', message: 'A new reading replaces the current text, including any corrections you made.', confirmText: 'Read again', danger: true });
      if (!ok) return;
    }
    state.busy = true; updateButtons();
    els.reocr.replaceChildren(h('span.spinner-border.spinner-border-sm.me-2'), 'Reading');
    try {
      await api('POST', '/reprocess-ocr', { json: { psm: Number(els.psm.value) } });
      for (let i = 0; i < 300; i += 1) {
        await DV.sleep(700);
        const st = await api('GET', '/status');
        if (!st.active) {
          if (st.job && st.job.status === 'failed') throw new Error(st.job.error_message || 'Reading failed.');
          break;
        }
      }
      await load({ quiet: true });
      DV.toast('The page was read again.', 'success');
    } catch (err) { notice('bad', DV.errorMessage(err)); } finally {
      state.busy = false;
      els.reocr.textContent = 'Read again';
      updateButtons();
    }
  });

  async function load({ quiet } = {}) {
    try {
      const detail = await api('GET', '');
      state.doc = detail.document;
      renderHeader();
      if (!detail.document.has_enhanced) {
        notice('warn', 'This page has not been processed yet.');
        els.text.placeholder = 'Process the page first.';
        viewer.showEmpty(h('span', null, 'There is no processed page to show yet. ', h('a', { href: `/documents/${docId}/workspace` }, 'Open the processing workspace')));
        return;
      }
      if (!quiet || !viewer.img) {
        try { await viewer.setImage(`/api/documents/${docId}/enhanced?v=${Date.now()}`); } catch (e) { viewer.showEmpty('The enhanced image could not be loaded.'); }
      }
      const res = await api('GET', '/ocr');
      applyOcr(res.ocr);
      renderHeader();
    } catch (err) {
      if (err.status === 404 && /OCR/i.test(err.message)) {
        notice('warn', 'The text has not been read yet. Process the page with text recognition switched on, or read it from the workspace.');
        els.text.placeholder = 'No recognised text yet.';
      } else notice('bad', DV.errorMessage(err));
    }
  }

  load();
})();
