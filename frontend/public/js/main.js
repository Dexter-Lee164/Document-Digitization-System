/* DocuVision shared client code: API wrapper (CSRF + errors), DOM helpers, toasts, confirm dialog, formatting, shell behaviour.
   Everything that comes from the server or the user is inserted with textContent / attributes - never innerHTML. */
(function () {
  'use strict';

  const DV = (window.DV = window.DV || {});

  /* ---------------------------------------------------------------- DOM helpers */
  /** h('div.class#id', {attr: value, onclick: fn, dataset: {x: 1}}, child, 'text', [more children]) */
  DV.h = function h(spec, attrs, ...children) {
    const m = /^([a-z0-9-]+)((?:[.#][\w-]+)*)$/i.exec(spec);
    const el = document.createElement(m ? m[1] : 'div');
    if (m && m[2]) {
      m[2].replace(/([.#])([\w-]+)/g, (_, kind, name) => {
        if (kind === '.') el.classList.add(name); else el.id = name;
        return '';
      });
    }
    if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    } else if (attrs !== undefined) {
      children.unshift(attrs);
    }
    const add = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    children.forEach(add);
    return el;
  };
  DV.$ = (sel, root) => (root || document).querySelector(sel);
  DV.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  DV.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  DV.icon = (name, cls) => DV.h('i', { class: `bi bi-${name}${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true' });

  /* ---------------------------------------------------------------- API */
  class ApiError extends Error {
    constructor(status, code, message, details) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }
  DV.ApiError = ApiError;

  const csrfMeta = () => document.querySelector('meta[name="csrf-token"]');
  DV.csrf = () => (csrfMeta() ? csrfMeta().content : '');
  DV.setCsrf = (token) => {
    if (!token) return;
    if (csrfMeta()) csrfMeta().content = token;
    // Forms rendered by the server (sign out) carry the token in a hidden field; keep them valid after the session rotates.
    document.querySelectorAll('input[type="hidden"][name="_csrf"]').forEach((i) => { i.value = token; });
  };

  async function refreshCsrf() {
    const res = await fetch('/auth/csrf', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (res.ok) DV.setCsrf((await res.json()).csrfToken);
  }

  /** DV.api('POST', '/api/x', { json: {...} | form: FormData, signal }) -> parsed JSON (or Blob when `blob: true`). */
  DV.api = async function api(method, url, opts = {}, retried = false) {
    const headers = { Accept: 'application/json' };
    let body;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    if (opts.form) body = opts.form;
    if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = DV.csrf();

    let res;
    try {
      res = await fetch(url, { method, headers, body, credentials: 'same-origin', signal: opts.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new ApiError(0, 'network', 'Could not reach the DocuVision server. Check that it is still running, then try again.');
    }
    if (res.ok) {
      if (opts.blob) return res.blob();
      if (res.status === 204) return null;
      const type = res.headers.get('content-type') || '';
      return type.includes('json') ? res.json() : res.text();
    }
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* not JSON */ }
    const err = (payload && payload.error) || {};
    if (res.status === 403 && err.code === 'csrf_failed' && !retried) {
      await refreshCsrf();
      return DV.api(method, url, opts, true);
    }
    if (res.status === 401 && !opts.allow401) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    }
    throw new ApiError(res.status, err.code || 'error', err.message || `The request failed (${res.status}).`, err.details);
  };
  DV.errorMessage = (err) => (err instanceof ApiError || (err && err.message) ? err.message : 'Something went wrong. Please try again.');

  /* ---------------------------------------------------------------- formatting */
  DV.fmt = {
    bytes(n) {
      if (n === null || n === undefined) return '';
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
      return `${(n / 1024 / 1024).toFixed(1)} MB`;
    },
    ms(n) {
      if (n === null || n === undefined) return '-';
      if (n < 1000) return `${Math.round(n)} ms`;
      return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`;
    },
    date(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    },
    ago(iso) {
      if (!iso) return '';
      const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 45) return 'just now';
      if (s < 3600) return `${Math.round(s / 60)} min ago`;
      if (s < 86400) return `${Math.round(s / 3600)} h ago`;
      if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
      return DV.fmt.date(iso);
    },
    pct(n, digits = 1) {
      return n === null || n === undefined ? '-' : `${Number(n).toFixed(digits)}%`;
    },
    ratio(n, digits = 2) {
      return n === null || n === undefined ? '-' : `${(Number(n) * 100).toFixed(digits === 0 ? 0 : digits)}%`;
    },
  };

  const PROCESSING = {
    uploaded: ['Uploaded', 'secondary'],
    processing: ['Processing', 'primary'],
    processed: ['Processed', 'success'],
    failed: ['Failed', 'danger'],
  };
  const REVIEW = {
    not_started: ['Not read yet', 'secondary'],
    needs_review: ['Needs review', 'warning'],
    reviewed: ['Reviewed', 'success'],
  };
  DV.badge = function badge(kind, value) {
    const table = kind === 'review' ? REVIEW : PROCESSING;
    const [label, tone] = table[value] || [value, 'secondary'];
    return DV.h(`span.dv-badge.dv-badge-${tone}`, null, value === 'processing' ? DV.h('span.dv-dot-pulse') : null, label);
  };
  DV.typeLabel = (t) => (t === 'form' ? 'Structured form' : 'General document');

  /* ---------------------------------------------------------------- toasts */
  DV.toast = function toast(message, tone = 'info', { timeout = 5000 } = {}) {
    const host = document.getElementById('toast-host');
    if (!host) return;
    const icon = { success: 'check-circle-fill', danger: 'exclamation-octagon-fill', warning: 'exclamation-triangle-fill', info: 'info-circle-fill' }[tone] || 'info-circle-fill';
    const node = DV.h(`div.dv-toast.dv-toast-${tone}`, { role: tone === 'danger' ? 'alert' : 'status' },
      DV.icon(icon), DV.h('div.dv-toast-text', null, message),
      DV.h('button.btn-close', { type: 'button', 'aria-label': 'Dismiss', onclick: () => node.remove() }));
    host.appendChild(node);
    if (timeout) setTimeout(() => node.remove(), tone === 'danger' ? Math.max(timeout, 8000) : timeout);
  };

  /* ---------------------------------------------------------------- confirm dialog */
  DV.confirm = function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
    const modalEl = document.getElementById('confirm-modal');
    if (!modalEl || !window.bootstrap) return Promise.resolve(window.confirm(message));
    modalEl.querySelector('.modal-title').textContent = title;
    modalEl.querySelector('.modal-body').textContent = message;
    const ok = modalEl.querySelector('[data-confirm-ok]');
    ok.textContent = confirmText;
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    const modal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
    return new Promise((resolve) => {
      let result = false;
      const onOk = () => { result = true; modal.hide(); };
      const onHidden = () => { ok.removeEventListener('click', onOk); modalEl.removeEventListener('hidden.bs.modal', onHidden); resolve(result); };
      ok.addEventListener('click', onOk);
      modalEl.addEventListener('hidden.bs.modal', onHidden);
      modal.show();
    });
  };

  /* ---------------------------------------------------------------- misc helpers */
  DV.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  DV.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  DV.docId = () => {
    const root = document.querySelector('[data-doc-id]');
    return root ? Number(root.dataset.docId) : null;
  };
  DV.store = {
    get(key, fallback) { try { const v = window.localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* storage blocked */ } },
  };
  DV.setBusy = function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.innerHTML;
      button.disabled = true;
      button.replaceChildren(DV.h('span.spinner-border.spinner-border-sm.me-2', { 'aria-hidden': 'true' }), label || 'Working');
    } else {
      button.disabled = false;
      if (button.dataset.label !== undefined) { button.innerHTML = button.dataset.label; delete button.dataset.label; }
    }
  };

  /* ---------------------------------------------------------------- shell: sidebar, service status */
  function initShell() {
    const root = document.documentElement;
    const mobile = window.matchMedia('(max-width: 991.98px)');
    const toggle = document.querySelector('[data-sidebar-toggle]');
    const openBtn = document.querySelector('[data-sidebar-open]');

    if (toggle) {
      toggle.addEventListener('click', () => {
        const collapsed = root.getAttribute('data-sidebar') === 'collapsed';
        root.setAttribute('data-sidebar', collapsed ? 'expanded' : 'collapsed');
        DV.store.set('dv.sidebar', collapsed ? 'expanded' : 'collapsed');
        toggle.setAttribute('aria-expanded', String(collapsed));
      });
      toggle.setAttribute('aria-expanded', String(root.getAttribute('data-sidebar') !== 'collapsed'));
    }
    const closeMobile = () => root.classList.remove('dv-sidebar-open');
    if (openBtn) openBtn.addEventListener('click', () => root.classList.add('dv-sidebar-open'));
    document.querySelectorAll('[data-sidebar-close]').forEach((n) => n.addEventListener('click', closeMobile));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMobile(); });
    mobile.addEventListener('change', closeMobile);

    const pill = document.getElementById('service-status');
    if (pill) {
      const text = pill.querySelector('.dv-status-text');
      const paint = (tone, label, title) => { pill.className = `dv-status dv-status-${tone}`; text.textContent = label; pill.title = title || ''; };
      const check = async () => {
        if (document.hidden) return;
        try {
          const h = await DV.api('GET', '/api/health');
          DV.serviceHealth = h;
          if (h.cv_service.status === 'offline') paint('bad', 'Image service offline', 'Start the Python service: npm run start:cv (or npm run dev).');
          else if (!h.ocr.available) paint('warn', 'OCR unavailable', h.ocr.error || 'Tesseract was not found.');
          else paint('ok', 'Image service ready', `OpenCV ${h.cv_service.opencv} - Tesseract ${h.ocr.version}`);
          document.dispatchEvent(new CustomEvent('dv:health', { detail: h }));
        } catch (e) {
          paint('bad', 'Server unreachable', DV.errorMessage(e));
        }
      };
      check();
      setInterval(check, 30000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    }
  }

  document.addEventListener('DOMContentLoaded', initShell);
})();
