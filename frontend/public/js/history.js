/* History: processing runs (with real per-stage timings) and exported Word files. */
(function () {
  'use strict';
  const { $, h, fmt } = DV;

  const state = { jobs: { page: 1 }, exports: { page: 1 } };

  function pager(el, res, key, load) {
    if (res.pages <= 1) { el.classList.add('d-none'); return; }
    el.classList.remove('d-none');
    el.replaceChildren(h('span', null, `${res.total} total`),
      h('div.btn-group', null,
        h('button.btn.btn-sm.btn-outline-secondary', { type: 'button', disabled: res.page <= 1, onclick: () => { state[key].page -= 1; load(); } }, DV.icon('chevron-left'), h('span.visually-hidden', null, 'Previous page')),
        h('span.btn.btn-sm.btn-outline-secondary.disabled', null, `Page ${res.page} of ${res.pages}`),
        h('button.btn.btn-sm.btn-outline-secondary', { type: 'button', disabled: res.page >= res.pages, onclick: () => { state[key].page += 1; load(); } }, DV.icon('chevron-right'), h('span.visually-hidden', null, 'Next page'))));
  }

  const empty = (icon, title, text) => h('div.dv-empty', null, DV.icon(icon), h('h3', null, title), h('p', null, text));
  const failure = (err, retry) => h('div.dv-empty', null, DV.icon('exclamation-diamond'), h('h3', null, 'Could not load this list'), h('p', null, DV.errorMessage(err)), h('button.btn.btn-outline-secondary', { type: 'button', onclick: retry }, 'Try again'));

  async function loadJobs() {
    const body = $('#jobs-body');
    try {
      const res = await DV.api('GET', `/api/jobs?page=${state.jobs.page}&page_size=20`);
      if (!res.items.length) { body.replaceChildren(empty('clock-history', 'No processing runs yet', 'When you process a page, each run is listed here with how long every stage took.')); $('#jobs-pager').classList.add('d-none'); return; }
      const tone = { completed: 'success', failed: 'danger', running: 'primary', queued: 'primary' };
      const label = { completed: 'Completed', failed: 'Failed', running: 'Running', queued: 'Queued' };
      body.replaceChildren(h('div.dv-table-wrap', null, h('table.dv-table', null,
        h('thead', null, h('tr', null, ...['Document', 'Run', 'Preset', 'Status', 'Geometry', 'Enhance', 'OCR', 'Total', 'When'].map((t, i) => h(i >= 4 && i <= 7 ? 'th.num' : 'th', null, t)))),
        h('tbody', null, res.items.map((j) => {
          const t = j.stage_timings || {};
          return h('tr', null,
            h('td', null, h('a.dv-link-strong.dv-ellipsis', { href: `/documents/${j.document_id}/workspace`, title: j.original_filename }, j.original_filename)),
            h('td.nowrap', null, j.kind === 'ocr' ? 'Text only' : 'Full'),
            h('td.nowrap', null, j.preset ? j.preset.replace(/_/g, ' ') : '-'),
            h('td', null, h(`span.dv-badge.dv-badge-${tone[j.status]}`, { title: j.error_message || '' }, label[j.status])),
            h('td.num', null, t.geometry_ms !== undefined ? fmt.ms(t.geometry_ms) : '-'),
            h('td.num', null, t.enhancement_ms !== undefined ? fmt.ms(t.enhancement_ms) : '-'),
            h('td.num', null, t.ocr_ms !== undefined ? fmt.ms(t.ocr_ms) : '-'),
            h('td.num', null, j.processing_time_ms ? fmt.ms(j.processing_time_ms) : '-'),
            h('td.nowrap.text-slate.small', { title: fmt.date(j.created_at) }, fmt.ago(j.created_at)));
        })))));
      pager($('#jobs-pager'), res, 'jobs', loadJobs);
    } catch (err) { body.replaceChildren(failure(err, loadJobs)); }
  }

  async function loadExports() {
    const body = $('#exports-body');
    try {
      const res = await DV.api('GET', `/api/exports?page=${state.exports.page}&page_size=20`);
      if (!res.items.length) { body.replaceChildren(empty('file-earmark-word', 'No Word exports yet', 'Review a document, then choose Export to create a .docx.')); $('#exports-pager').classList.add('d-none'); return; }
      body.replaceChildren(...res.items.map((it) => h('div.dv-export-row', null,
        DV.icon('file-earmark-word', 'fs-4 text-primary'),
        h('div.grow', null, h('div.fw-semibold.dv-ellipsis', { title: it.filename }, it.filename),
          h('div.small.text-slate', null, `From ${it.document_name}, ${it.export_type === 'form' ? 'form table' : 'text document'}, ${fmt.date(it.created_at)}`)),
        h('a.btn.btn-sm.btn-primary', { href: it.download_url, download: it.filename }, DV.icon('download', 'me-1'), 'Download'),
        h('button.btn.btn-sm.btn-outline-secondary', { type: 'button', 'aria-label': `Delete ${it.filename}`, title: 'Delete this export', onclick: async () => {
          const ok = await DV.confirm({ title: 'Delete this export?', message: `"${it.filename}" will be removed from DocuVision. Copies you already downloaded are not affected.`, confirmText: 'Delete', danger: true });
          if (!ok) return;
          try { await DV.api('DELETE', `/api/exports/${it.id}`); DV.toast('Export deleted.', 'success'); loadExports(); } catch (err) { DV.toast(DV.errorMessage(err), 'danger'); }
        } }, DV.icon('trash')))));
      pager($('#exports-pager'), res, 'exports', loadExports);
    } catch (err) { body.replaceChildren(failure(err, loadExports)); }
  }

  function showTab(name) {
    $('#h-jobs').checked = name === 'jobs';
    $('#h-exports').checked = name === 'exports';
    $('#panel-jobs').classList.toggle('d-none', name !== 'jobs');
    $('#panel-exports').classList.toggle('d-none', name !== 'exports');
    if (name === 'exports') loadExports();
  }
  document.querySelectorAll('input[name="htab"]').forEach((r) => r.addEventListener('change', () => { if (r.checked) showTab(r.value); }));
  // A link such as /history#exports also works when the page is already open (the hash changes without a reload).
  window.addEventListener('hashchange', () => showTab(window.location.hash === '#exports' ? 'exports' : 'jobs'));
  if (window.location.hash === '#exports') showTab('exports');
  loadJobs();
})();
