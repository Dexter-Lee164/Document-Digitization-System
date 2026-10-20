/* DSP lab: run configurations A-D on one photo, show time / confidence / CER / WER, export CSV. */
(function () {
  'use strict';
  const { $, h, fmt } = DV;

  const els = {
    doc: $('#lab-doc'), preset: $('#lab-preset'), psm: $('#lab-psm'), ref: $('#lab-ref'), run: $('#lab-run'), err: $('#lab-error'), progress: $('#lab-progress'),
    body: $('#lab-results-body'), csv: $('#lab-csv'), hist: $('#lab-history'), histPanel: $('#lab-history-panel'), useReviewed: $('#lab-use-reviewed'),
  };

  function showError(msg) {
    els.err.classList.toggle('d-none', !msg);
    els.err.replaceChildren(...(msg ? [DV.icon('exclamation-octagon-fill'), h('div', null, msg)] : []));
  }

  const selectedConfigs = () => [...document.querySelectorAll('input[name="cfg"]:checked')].map((c) => c.value);

  /* ------------------------------------------------------------ results rendering */
  function bars(rows, { value, format, better, title }) {
    const vals = rows.map(value).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    if (!vals.length) return null;
    const max = Math.max(...vals, 1e-9);
    const best = better === 'low' ? Math.min(...vals) : Math.max(...vals);
    return h('div', null, h('div.fw-semibold.small.mb-2', null, title),
      h('div.dv-bars', null, rows.map((r) => {
        const v = value(r);
        const ok = v !== null && v !== undefined && Number.isFinite(v);
        return h('div.dv-bar-row', null, h('b', null, r.config),
          h('div.dv-bar-track', null, ok ? h(`span.dv-bar-fill${v === best && vals.length > 1 ? '.is-best' : ''}`, { style: `--w:${Math.max(1, (v / max) * 100)}%` }) : null),
          h('span.tnum.text-end', null, ok ? format(v) : 'n/a'));
      })));
  }

  function renderRun(run) {
    const rows = run.results.results || [];
    const hasRef = run.results.reference_provided;
    els.csv.href = `/api/experiments/${run.id}/csv`;
    els.csv.classList.remove('d-none');
    const th = (t, num) => h(num ? 'th.num' : 'th', null, t);
    const table = h('div.dv-table-wrap', null, h('table.dv-table', null,
      h('thead', null, h('tr', null, th('Configuration'), th('Geometry', 1), th('Enhance', 1), th('OCR', 1), th('Total', 1), th('Mean confidence', 1), th('Uncertain words', 1), th('CER', 1), th('WER', 1))),
      h('tbody', null, rows.map((r) => h('tr', null,
        h('td', null, h('b', null, `${r.config}. `), r.label.replace(/^[A-D][.:]?\s*/, ''), r.error ? h('div.small.text-danger', null, r.error) : null),
        h('td.num', null, r.geometry_ms ? fmt.ms(r.geometry_ms) : '-'),
        h('td.num', null, r.enhancement_ms ? fmt.ms(r.enhancement_ms) : '-'),
        h('td.num', null, fmt.ms(r.ocr_ms)),
        h('td.num', null, h('b', null, fmt.ms(r.total_ms))),
        h('td.num', null, r.confidence && r.confidence.mean !== null ? `${r.confidence.mean}%` : '-'),
        h('td.num', null, r.confidence && r.confidence.word_count ? `${r.confidence.low_confidence_count} of ${r.confidence.word_count}` : '-'),
        h('td.num', null, r.cer === null || r.cer === undefined ? 'needs reference' : fmt.ratio(r.cer, 2)),
        h('td.num', null, r.wer === null || r.wer === undefined ? 'needs reference' : fmt.ratio(r.wer, 2)))))));

    const charts = h('div.row.g-4.p-3', null,
      h('div.col-md-6', null, bars(rows, { title: 'Total time (lower is faster)', value: (r) => (r.error ? null : r.total_ms), format: fmt.ms, better: 'low' })),
      h('div.col-md-6', null, hasRef
        ? bars(rows, { title: 'Character error rate (lower is better)', value: (r) => r.cer, format: (v) => fmt.ratio(v, 2), better: 'low' })
        : bars(rows, { title: 'Mean engine confidence (higher is more certain)', value: (r) => (r.confidence ? r.confidence.mean : null), format: (v) => `${v}%`, better: 'high' })));

    const texts = h('div.p-3.pt-0', null, h('div.fw-semibold.small.mb-1', null, 'Recognised text per configuration'),
      rows.map((r) => h('details.mb-1', null, h('summary.small', null, `${r.config}. ${r.word_count} words`), h('pre.dv-textdiff', null, r.text || '(nothing was read)'))));

    els.body.replaceChildren(table, charts, texts,
      h('p.small.text-slate.px-3.pb-3.mb-0', null,
        hasRef ? 'CER and WER were computed against the text you supplied.' : 'No reference text was supplied, so CER and WER are not available. ',
        ' ', run.results.note || '', ` Run ${fmt.date(run.created_at)}.`));
  }

  /* ------------------------------------------------------------ run + history */
  async function loadHistory() {
    const id = els.doc.value;
    if (!id) { els.histPanel.classList.add('d-none'); return; }
    try {
      const { items } = await DV.api('GET', `/api/documents/${id}/experiments`);
      els.histPanel.classList.toggle('d-none', !items.length);
      els.hist.replaceChildren(...items.map((it) => h('div.dv-export-row', null,
        DV.icon('activity', 'text-primary'),
        h('div.grow', null, h('div.fw-semibold', null, fmt.date(it.created_at)),
          h('div.small.text-slate', null, `${(it.settings.configs || []).join(', ')}, ${it.settings.preset || ''} preset${it.has_reference ? ', with reference text' : ', no reference'}`)),
        h('button.btn.btn-sm.btn-outline-secondary', { type: 'button', onclick: async () => {
          try { renderRun((await DV.api('GET', `/api/experiments/${it.id}`)).run); window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { DV.toast(DV.errorMessage(e), 'danger'); }
        } }, 'View'),
        h('button.btn.btn-sm.btn-outline-secondary', { type: 'button', 'aria-label': 'Delete this run', title: 'Delete this run', onclick: async () => {
          try { await DV.api('DELETE', `/api/experiments/${it.id}`); loadHistory(); } catch (e) { DV.toast(DV.errorMessage(e), 'danger'); }
        } }, DV.icon('trash')))));
    } catch (e) { els.histPanel.classList.add('d-none'); }
  }

  els.run.addEventListener('click', async () => {
    showError('');
    const configs = selectedConfigs();
    if (!els.doc.value) return showError('Choose a photo first.');
    if (!configs.length) return showError('Select at least one configuration.');
    els.run.disabled = true;
    const started = Date.now();
    els.progress.classList.remove('d-none');
    const timer = setInterval(() => { els.progress.textContent = `Running ${configs.length} configuration${configs.length === 1 ? '' : 's'} on the server... ${Math.round((Date.now() - started) / 1000)} s`; }, 500);
    els.progress.textContent = 'Starting...';
    els.body.replaceChildren(h('div.dv-empty', null, h('div.spinner-border.text-primary.mb-3'), h('h3', null, 'Running the experiment'), h('p', null, 'Each configuration is processed and read once. Larger photos take longer.')));
    try {
      const res = await DV.api('POST', `/api/documents/${els.doc.value}/experiments`, { json: { configs, preset: els.preset.value, psm: Number(els.psm.value), reference_text: els.ref.value.trim() ? els.ref.value : undefined } });
      renderRun(res.run);
      loadHistory();
    } catch (err) {
      showError(DV.errorMessage(err));
      els.body.replaceChildren(h('div.dv-empty', null, DV.icon('exclamation-diamond'), h('h3', null, 'The experiment did not finish'), h('p', null, DV.errorMessage(err))));
    } finally {
      clearInterval(timer);
      els.progress.classList.add('d-none');
      els.run.disabled = false;
    }
    return undefined;
  });

  els.useReviewed.addEventListener('click', async () => {
    try {
      const { ocr } = await DV.api('GET', `/api/documents/${els.doc.value}/ocr`);
      els.ref.value = ocr.corrected_text;
    } catch (err) { DV.toast(DV.errorMessage(err), 'warning'); }
  });

  els.doc.addEventListener('change', () => { els.run.disabled = !els.doc.value; els.useReviewed.disabled = !els.doc.value; loadHistory(); });

  (async function init() {
    try {
      const { items } = await DV.api('GET', '/api/documents?page_size=50&sort=newest');
      if (!items.length) {
        els.doc.replaceChildren(h('option', { value: '' }, 'No documents yet'));
        els.body.replaceChildren(h('div.dv-empty', null, DV.icon('files'), h('h3', null, 'Add a photo first'), h('p', null, 'The lab compares processing stages on one of your uploads.'), h('a.btn.btn-primary', { href: '/scan/new' }, 'New scan')));
        return;
      }
      const wanted = new URLSearchParams(window.location.search).get('doc');
      els.doc.replaceChildren(...items.map((d) => h('option', { value: d.id, selected: String(d.id) === wanted }, `${d.original_filename} (${d.image_width}x${d.image_height})`)));
      els.run.disabled = false;
      els.useReviewed.disabled = false;
      loadHistory();
    } catch (err) { showError(DV.errorMessage(err)); }
  })();
})();
