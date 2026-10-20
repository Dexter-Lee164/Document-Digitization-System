/* Processing workspace: corner editing, presets and parameters, real-progress polling, previews and the processing report. */
(function () {
  'use strict';
  const { $, $$, h, fmt } = DV;

  const root = $('#ws');
  const docId = Number(root.dataset.docId);
  const api = (method, path, opts) => DV.api(method, `/api/documents/${docId}${path}`, opts);

  const state = {
    doc: null, geometry: null, enhancement: null, job: null, schema: null,
    corners: null, cornersMode: 'auto', rotation: 0, angle: 0,
    preset: 'automatic', params: {}, docType: 'general',
    polling: false, lastScope: 'full', dirtySinceRun: false, imgVersion: Date.now(), detecting: false,
  };

  const els = {
    process: $('#btn-process'), enhanceOnly: $('#btn-enhance-only'), ocrOnly: $('#btn-ocr-only'),
    docType: $('#doc-type'), presetList: $('#preset-list'), params: $('#params'), paramsNote: $('#params-note'),
    autoOrient: $('#auto-orient'), autoDeskew: $('#auto-deskew'), angle: $('#angle'), angleVal: $('#angle-val'), rotReadout: $('#rot-readout'),
    runOcr: $('#run-ocr'), psm: $('#psm'), cornerMode: $('#corner-mode'), cornerGrid: $('#corner-grid'), cornerStatus: $('#corner-status'),
    pending: $('#pending-note'), rail: $('#rail'), jobError: $('#job-error'), jobDone: $('#job-done'), jobBadge: $('#job-badge'),
    report: $('#report'), alert: $('#ws-alert'), meta: $('#ws-meta'), goReview: $('#go-review'), goExport: $('#go-export'),
    wrap: $('#viewer-wrap'),
  };

  const viewIn = new DV.PageViewer($('#view-in'), { editable: true, label: 'Original photo with four draggable page corners. Press 1 to 4 to select a corner, then use the arrow keys.' });
  const viewOut = new DV.PageViewer($('#view-out'), { editable: false, label: 'Processed page' });

  /* ------------------------------------------------------------ helpers */
  const pretty = (s) => String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const imgUrl = (kind) => `/api/documents/${docId}/${kind}?v=${state.imgVersion}`;

  function notice(tone, message, { html } = {}) {
    els.alert.replaceChildren(h(`div.dv-notice.dv-notice-${tone}.mb-3`, { role: tone === 'bad' ? 'alert' : 'status' },
      DV.icon(tone === 'bad' ? 'exclamation-octagon-fill' : tone === 'warn' ? 'exclamation-triangle-fill' : tone === 'ok' ? 'check-circle-fill' : 'info-circle-fill'),
      h('div', null, message, html || null)));
  }
  const clearNotice = () => els.alert.replaceChildren();

  function markDirty() {
    if (state.polling) return;
    state.dirtySinceRun = true;
    updatePending();
  }
  function updatePending() {
    const show = state.dirtySinceRun && state.doc && state.doc.has_enhanced && !state.polling;
    els.pending.classList.toggle('d-none', !show);
  }

  /* ------------------------------------------------------------ header + buttons */
  function renderHeader() {
    const d = state.doc;
    els.meta.replaceChildren(
      DV.badge('processing', d.processing_status), DV.badge('review', d.review_status),
      h('span', null, DV.typeLabel(d.document_type)), h('span.tnum', null, `${d.image_width} x ${d.image_height} px`));
    const ready = d.has_ocr;
    [els.goReview, els.goExport].forEach((a) => { a.classList.toggle('disabled', !ready); a.setAttribute('aria-disabled', String(!ready)); a.tabIndex = ready ? 0 : -1; });
    els.enhanceOnly.disabled = !d.has_corrected || state.polling;
    els.ocrOnly.classList.toggle('d-none', !d.has_enhanced || state.polling);
    els.ocrOnly.innerHTML = '';
    els.ocrOnly.append(DV.icon('fonts', 'me-1'), d.has_ocr ? 'Read the text again' : 'Read the text');
  }

  function setControlsDisabled(disabled) {
    viewIn.opts.editable = !disabled; // no corner edits while a job is running
    viewIn.requestDraw();
    $$('.dv-controls input, .dv-controls select, .dv-controls button').forEach((c) => { c.disabled = disabled; });
    if (!disabled) { applyPresetLock(); els.enhanceOnly.disabled = !(state.doc && state.doc.has_corrected); updateProcessAvailability(); }
  }

  function updateProcessAvailability() {
    const manualBad = state.cornersMode === 'manual' && !viewIn.quadStatus().ok;
    els.process.disabled = state.polling || manualBad || state.detecting;
    els.process.title = manualBad ? 'Fix the page corners first.' : '';
    if (!state.polling) els.enhanceOnly.disabled = !(state.doc && state.doc.has_corrected);
  }

  /* ------------------------------------------------------------ presets + parameters */
  function buildPresets() {
    els.presetList.replaceChildren(...Object.entries(state.schema.presets).map(([key, p]) => {
      const input = h('input', { type: 'radio', name: 'preset', value: key, checked: key === state.preset });
      input.addEventListener('change', () => selectPreset(key));
      return h('label.dv-preset', null, input, h('strong', null, p.label), h('small', null, p.description));
    }));
  }

  function currentParamValues() {
    if (state.preset === 'custom') return state.params;
    if (state.preset === 'automatic' && state.enhancement && state.enhancement.preset === 'automatic') return state.enhancement.resolved_params;
    return (state.schema.presets[state.preset] || {}).params || {};
  }

  function buildParams() {
    const values = currentParamValues();
    const locked = state.preset !== 'custom';
    const controls = [];
    for (const [key, spec] of Object.entries(state.schema.parameters)) {
      const value = values[key] !== undefined ? values[key] : spec.default;
      const id = `p-${key}`;
      const wrap = h('div.dv-param', { 'aria-disabled': locked ? 'true' : null });
      if (spec.type === 'bool') {
        const input = h('input.form-check-input', { type: 'checkbox', role: 'switch', id, checked: Boolean(value), disabled: locked });
        input.addEventListener('change', () => { state.params[key] = input.checked; markDirty(); });
        wrap.append(h('div.dv-switch', null, h('label', { for: id }, spec.label), h('div.form-check.form-switch.m-0', null, input)));
      } else if (spec.type === 'enum') {
        const select = h('select.form-select.form-select-sm', { id, disabled: locked }, spec.values.map((v) => h('option', { value: v, selected: v === value }, pretty(v))));
        select.addEventListener('change', () => { state.params[key] = select.value; markDirty(); });
        wrap.append(h('label', { for: id }, spec.label), select);
      } else {
        const isInt = spec.type === 'int';
        const step = isInt ? (spec.odd ? 2 : 1) : (spec.max <= 3 ? 0.05 : 0.1);
        const readout = h('span.val', null, String(value));
        const input = h('input.form-range', { type: 'range', id, min: spec.min, max: spec.max, step, value, disabled: locked });
        input.addEventListener('input', () => {
          let v = Number(input.value);
          if (spec.odd && v % 2 === 0) v += 1;
          v = isInt ? Math.round(v) : Math.round(v * 100) / 100;
          readout.textContent = String(v);
          state.params[key] = v;
          markDirty();
        });
        wrap.append(h('label', { for: id }, spec.label, readout), input);
      }
      if (spec.help) wrap.append(h('span.hint', null, spec.help));
      controls.push(wrap);
    }
    els.params.replaceChildren(...controls);
    els.paramsNote.textContent = locked
      ? (state.preset === 'automatic' && !(state.enhancement && state.enhancement.preset === 'automatic')
        ? 'Automatic measures your page when you process it, then fills these in. They are shown here afterwards.'
        : 'These are the settings the selected preset uses. Choose Custom to change them.')
      : 'Custom: every value below is sent as you set it.';
  }

  function applyPresetLock() {
    const locked = state.preset !== 'custom';
    $$('input, select', els.params).forEach((c) => { c.disabled = locked; });
  }

  function selectPreset(key) {
    if (key === 'custom' && state.preset !== 'custom') state.params = JSON.parse(JSON.stringify(currentParamValues()));
    state.preset = key;
    buildParams();
    if (key === 'custom') $('#params-details').open = true;
    markDirty();
  }

  /* ------------------------------------------------------------ geometry controls */
  function renderRotation() {
    els.rotReadout.textContent = `${state.rotation}°`;
  }
  $('#rot-right').addEventListener('click', () => { state.rotation = (state.rotation + 90) % 360; renderRotation(); markDirty(); });
  $('#rot-left').addEventListener('click', () => { state.rotation = (state.rotation + 270) % 360; renderRotation(); markDirty(); });
  els.angle.addEventListener('input', () => { state.angle = Number(els.angle.value); els.angleVal.textContent = `${state.angle.toFixed(1)}°`; markDirty(); });
  els.autoOrient.addEventListener('change', markDirty);
  els.autoDeskew.addEventListener('change', markDirty);
  els.runOcr.addEventListener('change', markDirty);
  els.psm.addEventListener('change', markDirty);
  els.docType.addEventListener('change', () => {
    state.docType = els.docType.value;
    els.psm.value = state.docType === 'form' ? '4' : '3';
    markDirty();
  });

  function renderCornerGrid() {
    const cs = viewIn.getCorners();
    els.cornerGrid.replaceChildren(...(cs || []).map((c, i) => {
      const x = h('input.form-control.form-control-sm', { type: 'number', step: 1, value: Math.round(c[0]), 'aria-label': `Corner ${i + 1} x` });
      const y = h('input.form-control.form-control-sm', { type: 'number', step: 1, value: Math.round(c[1]), 'aria-label': `Corner ${i + 1} y` });
      const apply = () => { setManual(); viewIn.setCorner(i, Number(x.value), Number(y.value)); };
      x.addEventListener('change', apply); y.addEventListener('change', apply);
      return h('div.dv-cc', null, h('b', null, String(i + 1)), x, y);
    }));
  }

  function syncCornerInputs() {
    const cs = viewIn.getCorners();
    const inputs = $$('input', els.cornerGrid);
    if (!cs || inputs.length !== 8) return renderCornerGrid();
    cs.forEach((c, i) => { inputs[i * 2].value = Math.round(c[0]); inputs[i * 2 + 1].value = Math.round(c[1]); });
    return undefined;
  }

  function renderCornerStatus() {
    const mode = state.cornersMode;
    const tone = mode === 'manual' ? 'primary' : 'success';
    els.cornerMode.className = `dv-badge dv-badge-${state.detecting ? 'secondary' : tone}`;
    els.cornerMode.textContent = state.detecting ? 'Detecting...' : mode === 'manual' ? 'Manual corners' : 'Automatic corners';
    const st = viewIn.corners ? viewIn.quadStatus() : { ok: true };
    els.cornerStatus.replaceChildren(...(st.ok ? [] : [DV.icon('exclamation-triangle-fill', 'text-danger me-1'), h('span.text-danger', null, st.message)]));
    updateProcessAvailability();
  }

  function setManual() {
    if (state.cornersMode !== 'manual') { state.cornersMode = 'manual'; renderCornerStatus(); }
    markDirty();
  }

  viewIn.onCornersChange = ({ final }) => {
    state.cornersMode = 'manual';
    markDirty(); // every corner move is a change the last result does not include, even when the corners were already manual
    syncCornerInputs();
    if (final) renderCornerStatus(); else { const st = viewIn.quadStatus(); els.cornerStatus.replaceChildren(...(st.ok ? [] : [h('span.text-danger', null, st.message)])); }
  };

  async function detectCorners({ quiet } = {}) {
    state.detecting = true;
    renderCornerStatus();
    viewIn.busy(true);
    try {
      const res = await api('POST', '/detect');
      state.corners = res.corners;
      viewIn.setCorners(res.corners);
      state.cornersMode = 'auto';
      renderCornerGrid();
      if (!quiet || !res.detected) {
        notice(res.detected ? 'info' : 'warn', res.message || (res.detected ? 'Page edges found.' : 'The page edges could not be found automatically.'));
      }
      if (res.detected && quiet) clearNotice();
      if (!res.detected) state.cornersMode = 'manual';
      if (res.detected) markDirty();
    } catch (err) {
      notice('bad', DV.errorMessage(err));
    } finally {
      state.detecting = false;
      viewIn.busy(false);
      renderCornerStatus();
    }
  }
  $('#btn-detect').addEventListener('click', () => detectCorners());
  $('#btn-fullframe').addEventListener('click', () => {
    const { width, height } = viewIn.imageSize;
    viewIn.setCorners([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]]);
    renderCornerGrid();
    setManual();
    renderCornerStatus();
  });

  /* ------------------------------------------------------------ view layout */
  const savedPref = DV.store.get('dv.ws.view', null);
  function applyViewMode(mode, persist) {
    els.wrap.dataset.mode = mode;
    const r = $(`input[name="viewmode"][value="${mode}"]`);
    if (r) r.checked = true;
    if (persist) DV.store.set('dv.ws.view', mode);
    requestAnimationFrame(() => { viewIn._resize(); viewOut._resize(); });
  }
  $$('input[name="viewmode"]').forEach((r) => r.addEventListener('change', () => applyViewMode(r.value, true)));
  // Without a saved preference: edit corners on a large original first, switch to side by side once there is a result.
  if (['split', 'original', 'result'].includes(savedPref)) applyViewMode(savedPref, false);

  let outKind = 'enhanced';
  $$('input[name="outview"]').forEach((r) => r.addEventListener('change', () => { outKind = r.value; loadOut(); }));

  async function loadOut() {
    const d = state.doc;
    const available = outKind === 'enhanced' ? d.has_enhanced : d.has_corrected;
    if (!available) {
      viewOut.clearImage();
      viewOut.showEmpty(state.polling
        ? h('span', null, 'Working on it. The result appears here as soon as this stage finishes.')
        : h('span', null, d.has_enhanced || d.has_corrected ? 'That stage has not been produced yet.' : 'Process the page to see the straightened and enhanced result here.'));
      return;
    }
    viewOut.busy(true);
    try { await viewOut.setImage(imgUrl(outKind)); } catch (err) { viewOut.showEmpty(DV.errorMessage(err)); } finally { viewOut.busy(false); }
  }

  /* ------------------------------------------------------------ pipeline rail */
  const STAGES = [
    { key: 'geometry', title: 'Find and straighten the page', timing: 'geometry_ms' },
    { key: 'enhancement', title: 'Enhance the image', timing: 'enhancement_ms' },
    { key: 'ocr', title: 'Read the text', timing: 'ocr_ms' },
  ];

  function stageSummary(key) {
    const g = state.geometry && state.geometry.report;
    const e = state.enhancement;
    if (key === 'geometry' && g) {
      const bits = [];
      bits.push(g.corners_source === 'manual' ? 'Your corners' : g.corners_source === 'auto' ? 'Edges found automatically' : 'Whole photo used');
      if (g.orientation && g.orientation.applied_cw) bits.push(`rotated ${g.orientation.applied_cw}°`);
      if (g.deskew && g.deskew.applied) bits.push(`skew ${Number(g.deskew.angle).toFixed(1)}° fixed`);
      return bits.join(', ');
    }
    if (key === 'enhancement' && e) return `${state.schema.presets[e.preset] ? state.schema.presets[e.preset].label : e.preset}, ${(e.report.steps || []).length} steps`;
    return '';
  }

  function renderRail() {
    const job = state.job;
    const timings = (job && job.stage_timings) || {};
    const active = job && (job.status === 'queued' || job.status === 'running');
    const currentIdx = job ? STAGES.findIndex((s) => s.key === job.stage) : -1;
    const d = state.doc;
    els.rail.replaceChildren(...STAGES.map((s, i) => {
      let status = 'pending';
      let detail = '';
      if (job && job.kind === 'ocr' && s.key !== 'ocr') status = d[s.key === 'geometry' ? 'has_corrected' : 'has_enhanced'] ? 'done' : 'pending';
      else if (job && active) {
        if (state.lastScope === 'enhance' && s.key === 'geometry') status = 'skipped';
        else if (i < currentIdx) status = 'done';
        else if (i === currentIdx) status = 'active';
      } else if (job && job.status === 'failed') {
        if (i < currentIdx) status = 'done'; else if (i === currentIdx) status = 'failed';
      } else if (job && job.status === 'completed') {
        status = timings[s.timing] !== undefined ? 'done' : (d[s.key === 'geometry' ? 'has_corrected' : s.key === 'enhancement' ? 'has_enhanced' : 'has_ocr'] ? 'done' : 'skipped');
      } else {
        status = (s.key === 'geometry' && d.has_corrected) || (s.key === 'enhancement' && d.has_enhanced) || (s.key === 'ocr' && d.has_ocr) ? 'done' : 'pending';
      }
      if (timings[s.timing] !== undefined) detail = fmt.ms(timings[s.timing]);
      const summary = status === 'done' ? stageSummary(s.key) : status === 'skipped' ? 'Not run this time' : status === 'active' ? 'Working...' : '';
      return h(`li.is-${status}`, null, h('span.dv-rail-dot'), h('div', null, h('strong', null, s.title), h('small', null, [detail, summary].filter(Boolean).join(' - ') || ' ')));
    }));

    els.jobBadge.replaceChildren(...(job ? [job.status === 'completed' ? DV.badge('processing', 'processed') : job.status === 'failed' ? DV.badge('processing', 'failed') : DV.badge('processing', 'processing')] : []));
    els.jobError.classList.toggle('d-none', !(job && job.status === 'failed'));
    if (job && job.status === 'failed') {
      els.jobError.replaceChildren(DV.icon('exclamation-octagon-fill'), h('div', null, h('strong', null, 'Processing stopped. '), job.error_message || 'An unknown error occurred.'));
    }
    const done = job && job.status === 'completed';
    els.jobDone.classList.toggle('d-none', !done);
    if (done) {
      els.jobDone.replaceChildren(h('div.small.text-slate.mb-2', null, `Finished in ${fmt.ms(job.processing_time_ms)}.`),
        d.has_ocr ? h('a.btn.btn-primary.w-100', { href: `/documents/${docId}/review` }, DV.icon('pencil-square', 'me-2'), 'Review the text') : null);
    }
  }

  /* ------------------------------------------------------------ report */
  function kv(rows) {
    return h('dl.dv-kv', null, rows.filter((r) => r[1] !== undefined && r[1] !== null && r[1] !== '').flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  }

  function renderReport() {
    const g = state.geometry && state.geometry.report;
    const e = state.enhancement;
    if (!g && !e) return;
    const parts = [];
    if (g) {
      const det = g.detection || {};
      parts.push(h('details', { open: true }, h('summary', null, 'Page geometry'), kv([
        ['Corners', g.corners_source === 'manual' ? 'Set by you' : g.corners_source === 'auto' ? `Detected automatically${det.confidence !== undefined ? ` (score ${Math.round(det.confidence * 100)}%)` : ''}` : 'Whole photo (no page edges found)'],
        ['Detection', det.message],
        ['Perspective', g.perspective && g.perspective.applied ? `Flattened to ${g.perspective.output_size[0]} x ${g.perspective.output_size[1]} px` : 'Not needed'],
        ['Page proportions', g.perspective && g.perspective.size_method ? `${g.perspective.size_method === 'camera_model' ? 'Estimated from the camera view' : 'Measured from edge lengths'}${g.perspective.page_aspect_ratio ? ` (width/height ${Number(g.perspective.page_aspect_ratio).toFixed(3)})` : ''}` : ''],
        ['Orientation', g.orientation ? `${g.orientation.message || ''}${g.orientation.method ? ` [${g.orientation.method}]` : ''}` : ''],
        ['Skew', g.deskew ? g.deskew.message : ''],
        ['Manual', (g.manual && (g.manual.rotation_cw || g.manual.angle_cw)) ? `${g.manual.rotation_cw}° rotation, ${g.manual.angle_cw}° fine angle` : ''],
        ['Time', fmt.ms(g.total_ms)],
      ])));
    }
    if (e) {
      const a = e.analysis || {};
      parts.push(h('details', { open: true }, h('summary', null, 'Enhancement steps'),
        h('ul.dv-steps-list', null, (e.report.steps || []).map((s) => h('li', null, h('span', null, pretty(s.stage), s.note ? h('span.text-slate', null, ` - ${s.note}`) : null), h('span.t', null, fmt.ms(s.ms))))),
        kv([['Output', `${e.report.output_size[0]} x ${e.report.output_size[1]} px, ${e.report.output_mode}`]])));
      if (Object.keys(a).length) {
        parts.push(h('details', null, h('summary', null, 'What the page measured'), kv([
          ['Noise (sigma)', a.noise_sigma], ['Contrast (std dev)', a.contrast_std], ['Uneven lighting', a.illumination_variation],
          ['Sharpness (Laplacian)', a.sharpness_laplacian_var], ['Mean brightness', a.mean_intensity],
        ])));
      }
      parts.push(h('details', null, h('summary', null, 'Parameters used'), kv(Object.entries(e.resolved_params || {}).map(([k, v]) => [(state.schema.parameters[k] || {}).label || pretty(k), String(v)]))));
    }
    els.report.replaceChildren(...parts);
  }

  /* ------------------------------------------------------------ requests + polling */
  function buildRequest(scope) {
    const body = {
      document_type: state.docType, preset: state.preset, scope, run_ocr: els.runOcr.checked, psm: Number(els.psm.value),
      auto_detect: state.cornersMode === 'auto', auto_orient: els.autoOrient.checked, auto_deskew: els.autoDeskew.checked,
      manual_rotation: state.rotation, manual_angle: state.angle,
    };
    if (state.preset === 'custom') body.params = state.params;
    if (state.cornersMode === 'manual') body.corners = viewIn.getCorners();
    return body;
  }

  async function startProcess(scope) {
    clearNotice();
    if (state.cornersMode === 'manual' && !viewIn.quadStatus().ok) { notice('warn', viewIn.quadStatus().message); return; }
    try {
      state.lastScope = scope;
      const res = await api('POST', '/process', { json: buildRequest(scope) });
      state.job = res.job;
      state.doc = res.document;
      state.dirtySinceRun = false;
      poll();
    } catch (err) {
      notice('bad', DV.errorMessage(err));
    }
  }

  async function startOcrOnly() {
    clearNotice();
    try {
      const res = await api('POST', '/reprocess-ocr', { json: { psm: Number(els.psm.value) } });
      if (res.replaces_edits) DV.toast('Your earlier text edits were replaced by the new reading.', 'warning');
      state.lastScope = 'ocr';
      state.job = res.job;
      poll();
    } catch (err) {
      notice('bad', DV.errorMessage(err));
    }
  }

  async function reload() {
    const detail = await api('GET', '');
    state.doc = detail.document; state.geometry = detail.geometry; state.enhancement = detail.enhancement; state.job = detail.job;
    if (!viewIn.corners) applyStoredCorners(); // first run on a new upload: the handles appear once the page edges are known
  }

  /** Show the corners saved on the document in the editor. Returns false when there are none or the image is not loaded. */
  function applyStoredCorners() {
    const stored = state.doc && state.doc.corners;
    if (!viewIn.img || !stored || stored.length !== 4) return false;
    state.corners = stored;
    viewIn.setCorners(stored);
    renderCornerGrid();
    renderCornerStatus();
    return true;
  }

  async function poll() {
    if (state.polling) return;
    state.polling = true;
    setControlsDisabled(true);
    updatePending();
    renderHeader();
    renderRail();
    loadOut();
    let failures = 0;
    try {
      for (;;) {
        let st;
        try {
          st = await api('GET', '/status');
          failures = 0;
        } catch (err) {
          failures += 1;
          if (failures >= 5) throw err;
          await DV.sleep(1500);
          continue;
        }
        state.doc = st.document;
        state.job = st.job;
        renderHeader();
        renderRail();
        if (!st.active) break;
        await DV.sleep(600);
      }
      await reload();
      state.imgVersion = Date.now();
      state.polling = false;
      renderAll();
      if (state.job && state.job.status === 'completed') {
        DV.toast(state.doc.has_ocr ? 'Processing finished. The text is ready to review.' : 'Processing finished.', 'success');
        if (outKind !== 'enhanced') { outKind = 'enhanced'; $('#ov-enhanced').checked = true; loadOut(); }
        if (!savedPref && els.wrap.dataset.mode === 'original') applyViewMode('split', false);
      } else if (state.job && state.job.status === 'failed') {
        DV.toast('Processing failed. See the pipeline panel for the reason.', 'danger');
      }
    } catch (err) {
      notice('bad', `Lost contact with the server while processing: ${DV.errorMessage(err)} Reload the page to see the current state.`);
    } finally {
      state.polling = false;
      setControlsDisabled(false);
      updatePending();
      renderHeader();
    }
  }

  $('#btn-process').addEventListener('click', () => startProcess('full'));
  els.enhanceOnly.addEventListener('click', () => startProcess('enhance'));
  els.ocrOnly.addEventListener('click', startOcrOnly);

  function renderAll() {
    renderHeader(); renderRail(); renderReport(); loadOut(); updatePending();
  }

  /* ------------------------------------------------------------ init */
  async function init() {
    try {
      const [detail, schema] = await Promise.all([api('GET', ''), DV.api('GET', '/api/processing/schema')]);
      state.doc = detail.document; state.geometry = detail.geometry; state.enhancement = detail.enhancement; state.job = detail.job; state.schema = schema;
    } catch (err) {
      notice('bad', DV.errorMessage(err));
      return;
    }
    const d = state.doc;
    state.docType = d.document_type;
    els.docType.value = d.document_type;
    els.psm.value = d.document_type === 'form' ? '4' : '3';
    state.preset = (state.enhancement && state.schema.presets[state.enhancement.preset]) ? state.enhancement.preset : (state.schema.presets[root.dataset.defaultPreset] ? root.dataset.defaultPreset : 'automatic');
    if (state.preset === 'custom' && state.enhancement) state.params = Object.assign({}, state.enhancement.resolved_params);

    const opts = state.geometry && state.geometry.options;
    if (opts) {
      els.autoOrient.checked = opts.auto_orient !== false;
      els.autoDeskew.checked = opts.auto_deskew !== false;
      state.rotation = opts.manual_rotation || 0;
      state.angle = opts.manual_angle || 0;
      els.angle.value = state.angle;
      els.angleVal.textContent = `${Number(state.angle).toFixed(1)}°`;
      state.cornersMode = opts.corners === 'manual' ? 'manual' : 'auto';
    }
    renderRotation();
    if (!savedPref) applyViewMode(d.has_enhanced ? 'split' : 'original', false);
    buildPresets();
    buildParams();
    if (state.preset === 'custom') $('#params-details').open = true; // the values the last run used are the point of reopening a custom page
    renderAll();

    viewIn.busy(true);
    try {
      await viewIn.setImage(`/api/documents/${docId}/original`);
    } catch (err) {
      viewIn.showEmpty('The original image could not be loaded. It may have been removed from storage.');
    } finally { viewIn.busy(false); }

    const job = state.job;
    const jobActive = Boolean(job && (job.status === 'queued' || job.status === 'running')) || state.doc.processing_status === 'processing';
    const justStarted = new URLSearchParams(window.location.search).has('started');
    // A running job decides the corners itself; asking for a second detection now would only be refused as "busy".
    if (!applyStoredCorners() && viewIn.img && !jobActive && !justStarted) await detectCorners({ quiet: true });

    if (jobActive || justStarted) poll();
    else if (job && job.status === 'failed') renderRail();
  }

  document.addEventListener('dv:health', (e) => {
    const h2 = e.detail;
    if (h2.cv_service.status === 'offline' && !state.polling) notice('warn', 'The image-processing service is offline, so this page cannot be processed right now. Start it with "npm run start:cv" and try again.');
  });

  DV.workspace = { viewIn, viewOut, state }; // exposed so automated UI tests can inspect the viewers
  init();
})();
