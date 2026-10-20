/* My Documents: search, filter, sort, paginate; open, review, download, delete. Filters live in the URL so links can point at them. */
(function () {
  'use strict';
  const { $, h, fmt } = DV;

  const body = $('#docs-body');
  const pager = $('#pager');
  const f = { search: $('#f-search'), status: $('#f-status'), review: $('#f-review'), type: $('#f-type'), sort: $('#f-sort') };
  const query = { page: 1 };

  const params = new URLSearchParams(window.location.search);
  f.search.value = params.get('search') || '';
  for (const key of ['status', 'review', 'type', 'sort']) { if (params.get(key)) f[key].value = params.get(key); }
  query.page = Math.max(1, Number(params.get('page')) || 1);

  function syncUrl() {
    const p = new URLSearchParams();
    if (f.search.value.trim()) p.set('search', f.search.value.trim());
    for (const key of ['status', 'review', 'type']) if (f[key].value) p.set(key, f[key].value);
    if (f.sort.value && f.sort.value !== 'newest') p.set('sort', f.sort.value);
    if (query.page > 1) p.set('page', String(query.page));
    const qs = p.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }

  function confidenceCell(c) {
    if (c === null || c === undefined) return h('span.text-slate', null, '-');
    const cls = c >= 80 ? '' : c >= 60 ? 'is-mid' : 'is-low';
    return h('span.dv-conf', null, `${Math.round(c)}%`, h(`span.dv-conf-bar${cls ? '.' + cls : ''}`, { 'aria-hidden': 'true' }, h('span', { style: `width:${Math.max(2, Math.min(100, c))}%` })));
  }

  async function remove(doc) {
    const ok = await DV.confirm({
      title: 'Delete this document?',
      message: `"${doc.original_filename}", its processed images, recognised text and Word exports will be permanently deleted. This cannot be undone.`,
      confirmText: 'Delete document', danger: true,
    });
    if (!ok) return;
    try {
      await DV.api('DELETE', `/api/documents/${doc.id}`);
      DV.toast('Document deleted.', 'success');
      load();
    } catch (err) { DV.toast(DV.errorMessage(err), 'danger'); }
  }

  function row(doc) {
    const actions = [h('a.btn.btn-sm.btn-outline-secondary', { href: `/documents/${doc.id}/workspace` }, doc.has_enhanced ? 'Open' : 'Process')];
    if (doc.has_enhanced) actions.push(h('a.btn.btn-sm.btn-outline-secondary', { href: `/documents/${doc.id}/review` }, 'Review text'));
    if (doc.latest_export_id) actions.push(h('a.btn.btn-sm.btn-outline-secondary', { href: `/api/exports/${doc.latest_export_id}/download`, title: 'Download the latest Word export' }, DV.icon('download', 'me-1'), '.docx'));
    actions.push(h('button.btn.btn-sm.btn-outline-secondary', { type: 'button', title: 'Delete', 'aria-label': `Delete ${doc.original_filename}`, onclick: () => remove(doc) }, DV.icon('trash')));
    return h('tr', null,
      h('td', null, h('a.dv-link-strong.dv-ellipsis', { href: `/documents/${doc.id}/workspace`, title: doc.original_filename }, doc.original_filename), h('div.small.text-slate', null, `${DV.typeLabel(doc.document_type)}, ${doc.image_width}x${doc.image_height} px, ${fmt.bytes(doc.file_size)}`)),
      h('td', null, DV.badge('processing', doc.processing_status)),
      h('td', null, DV.badge('review', doc.review_status)),
      h('td', null, confidenceCell(doc.confidence)),
      h('td.nowrap.text-slate.small', { title: fmt.date(doc.created_at) }, fmt.ago(doc.created_at)),
      h('td', null, h('div.dv-row-actions', null, actions)));
  }

  function renderEmpty(filtered) {
    return h('div.dv-empty', null, DV.icon(filtered ? 'search' : 'files'),
      h('h3', null, filtered ? 'No documents match these filters' : 'No documents yet'),
      h('p', null, filtered ? 'Clear a filter or change the search to see more.' : 'Scan or upload a page and it will appear here.'),
      filtered ? h('button.btn.btn-outline-secondary', { type: 'button', onclick: () => { f.search.value = ''; ['status', 'review', 'type'].forEach((k) => { f[k].value = ''; }); query.page = 1; load(); } }, 'Clear filters')
        : h('a.btn.btn-primary', { href: '/scan/new' }, 'Add your first page'));
  }

  let seq = 0;
  async function load() {
    const mine = ++seq;
    syncUrl();
    const p = new URLSearchParams({ page: String(query.page), page_size: '15', sort: f.sort.value });
    if (f.search.value.trim()) p.set('search', f.search.value.trim());
    for (const key of ['status', 'review', 'type']) if (f[key].value) p.set(key, f[key].value);
    let res;
    try {
      res = await DV.api('GET', `/api/documents?${p}`);
    } catch (err) {
      if (mine !== seq) return;
      body.replaceChildren(h('div.dv-empty', null, DV.icon('exclamation-diamond'), h('h3', null, 'Documents could not be loaded'), h('p', null, DV.errorMessage(err)), h('button.btn.btn-outline-secondary', { type: 'button', onclick: load }, 'Try again')));
      return;
    }
    if (mine !== seq) return; // a newer request already replaced this one
    if (res.page > res.pages) { query.page = res.pages; load(); return; }
    const filtered = Boolean(f.search.value.trim() || f.status.value || f.review.value || f.type.value);
    if (!res.items.length) {
      body.replaceChildren(renderEmpty(filtered));
      pager.classList.add('d-none');
      return;
    }
    body.replaceChildren(h('div.dv-table-wrap', null, h('table.dv-table', null,
      h('thead', null, h('tr', null, h('th', null, 'Document'), h('th', null, 'Processing'), h('th', null, 'Review'), h('th', null, 'OCR confidence'), h('th', null, 'Added'), h('th', null, h('span.visually-hidden', null, 'Actions')))),
      h('tbody', null, res.items.map(row)))));
    pager.classList.remove('d-none');
    const from = (res.page - 1) * res.page_size + 1;
    pager.replaceChildren(
      h('span', null, `${from}-${from + res.items.length - 1} of ${res.total}`),
      h('div.btn-group', null,
        h('button.btn.btn-sm.btn-outline-secondary', { type: 'button', disabled: res.page <= 1, onclick: () => { query.page -= 1; load(); } }, DV.icon('chevron-left'), h('span.visually-hidden', null, 'Previous page')),
        h('span.btn.btn-sm.btn-outline-secondary.disabled', null, `Page ${res.page} of ${res.pages}`),
        h('button.btn.btn-sm.btn-outline-secondary', { type: 'button', disabled: res.page >= res.pages, onclick: () => { query.page += 1; load(); } }, DV.icon('chevron-right'), h('span.visually-hidden', null, 'Next page'))));
    // keep refreshing while something is processing
    if (res.items.some((d) => d.processing_status === 'processing')) setTimeout(() => { if (mine === seq && !document.hidden) load(); }, 3000);
  }

  $('#filters').addEventListener('submit', (e) => e.preventDefault());
  const reload = () => { query.page = 1; load(); };
  f.search.addEventListener('input', DV.debounce(reload, 250));
  ['status', 'review', 'type', 'sort'].forEach((k) => f[k].addEventListener('change', reload));
  load();
})();
