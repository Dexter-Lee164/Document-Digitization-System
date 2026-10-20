/* PageViewer: a canvas viewer (zoom, pan, pinch) that can also edit the four page corners.
   All corner coordinates are ORIGINAL IMAGE PIXELS: the canvas transform maps between screen and image space in
   toScreen()/toImage(), so a handle dragged on screen lands on exactly the pixel the server will receive.
   The same class draws word boxes / field regions on the review page (setHighlights). */
(function () {
  'use strict';
  const DV = (window.DV = window.DV || {});
  const { h } = DV;

  const MIN_SIDE_PX = 20; // same limits as the server (perspective.validate_corners)
  const MIN_AREA_RATIO = 0.01;
  const HANDLE_R = 9;
  const NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  /** Same rule as the server: order clockwise around the centroid, then require a convex quad of sensible size. */
  function analyzeQuad(corners, width, height) {
    if (!Array.isArray(corners) || corners.length !== 4) return { ok: false, message: 'Four corners are needed.' };
    const cx = corners.reduce((s, p) => s + p[0], 0) / 4;
    const cy = corners.reduce((s, p) => s + p[1], 0) / 4;
    const ordered = corners.map((p) => ({ p, a: Math.atan2(p[1] - cy, p[0] - cx) })).sort((a, b) => a.a - b.a).map((o) => o.p);
    for (let i = 0; i < 4; i += 1) {
      const a = ordered[i];
      const b = ordered[(i + 1) % 4];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < MIN_SIDE_PX) return { ok: false, message: 'Two corners are too close together.' };
    }
    const signs = ordered.map((p, i) => Math.sign(cross(p, ordered[(i + 1) % 4], ordered[(i + 2) % 4])));
    if (!signs.every((s) => s !== 0 && s === signs[0])) return { ok: false, message: 'The corners must form a convex four-sided shape. Move a handle back inside.' };
    let area = 0;
    ordered.forEach((p, i) => { const q = ordered[(i + 1) % 4]; area += p[0] * q[1] - q[0] * p[1]; });
    area = Math.abs(area) / 2;
    if (width && height && area < MIN_AREA_RATIO * width * height) return { ok: false, message: 'The selected area is smaller than 1% of the photo.' };
    return { ok: true, message: '', area_ratio: width && height ? area / (width * height) : null };
  }

  class PageViewer {
    constructor(container, options = {}) {
      this.opts = Object.assign({ editable: false, label: 'Page image', toolbar: true }, options);
      this.root = container;
      container.classList.add('dv-view');
      this.canvas = h('canvas', { tabindex: 0, role: 'application', 'aria-label': this.opts.label });
      container.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.img = null;
      this.scale = 1; this.fitScale = 1; this.tx = 0; this.ty = 0; this.fitted = true;
      this.corners = null; this.selected = -1; this.dragging = -1; this.hover = -1;
      this.highlights = []; this.overlayCorners = true;
      this.pointers = new Map(); this.pan = null; this.pinch = null;
      this.onCornersChange = null; this.onViewChange = null; this.onHighlightClick = null;
      this._raf = 0;

      if (this.opts.toolbar) this._buildToolbar();
      this._bind();
      this._observer = new ResizeObserver(() => this._resize());
      this._observer.observe(container);
      this._resize();
    }

    /* ------------------------------------------------------------ toolbar + overlays */
    _buildToolbar() {
      const btn = (icon, label, fn) => h('button', { type: 'button', title: label, 'aria-label': label, onclick: fn }, DV.icon(icon));
      this.readout = h('span.zoom-readout', { 'aria-live': 'off' }, '100%');
      this.toolbar = h('div.dv-view-tools', { role: 'toolbar', 'aria-label': 'Zoom controls' },
        btn('dash-lg', 'Zoom out', () => this.zoomBy(1 / 1.25)),
        this.readout,
        btn('plus-lg', 'Zoom in', () => this.zoomBy(1.25)),
        btn('arrows-fullscreen', 'Fit page to view', () => this.fit()),
        btn('1-square', 'Actual size (100%)', () => this.zoomActual()));
      this.root.appendChild(this.toolbar);
    }

    showEmpty(content) {
      this.clearEmpty();
      this.emptyEl = h('div.dv-view-empty', null, h('div', null, content));
      this.root.appendChild(this.emptyEl);
    }

    clearEmpty() { if (this.emptyEl) { this.emptyEl.remove(); this.emptyEl = null; } }

    busy(on) {
      if (on && !this.busyEl) {
        this.busyEl = h('div.dv-view-busy', { role: 'status' }, h('div.spinner-border.text-primary', null, h('span.visually-hidden', null, 'Loading')));
        this.root.appendChild(this.busyEl);
      } else if (!on && this.busyEl) { this.busyEl.remove(); this.busyEl = null; }
    }

    /* ------------------------------------------------------------ image + view */
    setImage(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          this.img = img;
          this.clearEmpty();
          this.fit();
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.onerror = () => reject(new Error('The image could not be loaded.'));
        img.src = url;
      });
    }

    clearImage() { this.img = null; this.corners = null; this.highlights = []; this.requestDraw(); }
    get imageSize() { return this.img ? { width: this.img.naturalWidth, height: this.img.naturalHeight } : null; }

    _resize() {
      const r = this.root.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.cw = Math.max(1, Math.round(r.width));
      this.ch = Math.max(1, Math.round(r.height));
      this.dpr = dpr;
      this.canvas.width = Math.round(this.cw * dpr);
      this.canvas.height = Math.round(this.ch * dpr);
      if (this.img) {
        const keepFit = this.fitted;
        this._computeFit();
        if (keepFit) this.fit(); else this._clampPan();
      }
      this.requestDraw();
    }

    _computeFit() {
      const pad = 16;
      this.fitScale = Math.min((this.cw - pad * 2) / this.img.naturalWidth, (this.ch - pad * 2) / this.img.naturalHeight);
      if (!Number.isFinite(this.fitScale) || this.fitScale <= 0) this.fitScale = 1;
    }

    fit() {
      if (!this.img) return;
      this._computeFit();
      this.scale = this.fitScale;
      this.tx = (this.cw - this.img.naturalWidth * this.scale) / 2;
      this.ty = (this.ch - this.img.naturalHeight * this.scale) / 2;
      this.fitted = true;
      this._viewChanged();
    }

    zoomActual() { this._zoomTo(1, this.cw / 2, this.ch / 2); }
    zoomBy(f) { this._zoomTo(this.scale * f, this.cw / 2, this.ch / 2); }

    _zoomTo(newScale, cx, cy) {
      if (!this.img) return;
      const min = this.fitScale * 0.6;
      const max = Math.max(10, this.fitScale * 20);
      const s = Math.min(max, Math.max(min, newScale));
      const ix = (cx - this.tx) / this.scale;
      const iy = (cy - this.ty) / this.scale;
      this.scale = s;
      this.tx = cx - ix * s;
      this.ty = cy - iy * s;
      this.fitted = Math.abs(s - this.fitScale) < 1e-6;
      this._clampPan();
      this._viewChanged();
    }

    _clampPan() {
      if (!this.img) return;
      const w = this.img.naturalWidth * this.scale;
      const hgt = this.img.naturalHeight * this.scale;
      const keep = 60; // always leave some of the page on screen
      this.tx = Math.min(this.cw - keep, Math.max(keep - w, this.tx));
      this.ty = Math.min(this.ch - keep, Math.max(keep - hgt, this.ty));
    }

    _viewChanged() {
      if (this.readout) this.readout.textContent = `${Math.round(this.scale * 100)}%`;
      this.requestDraw();
      if (this.onViewChange) this.onViewChange(this);
    }

    /** Pan/zoom so that an image-space box is centred and comfortably visible. */
    focusBox(box, { minScale } = {}) {
      if (!this.img || !box) return;
      const target = Math.min(this.cw / (box.w * 6 || 1), this.ch / (box.h * 6 || 1));
      const s = Math.min(Math.max(this.scale, minScale || 0, Math.min(target, 3)), 10);
      this.scale = s;
      this.tx = this.cw / 2 - (box.x + box.w / 2) * s;
      this.ty = this.ch / 2 - (box.y + box.h / 2) * s;
      this.fitted = false;
      this._clampPan();
      this._viewChanged();
    }

    toScreen(x, y) { return [this.tx + x * this.scale, this.ty + y * this.scale]; }
    toImage(px, py) { return [(px - this.tx) / this.scale, (py - this.ty) / this.scale]; }

    /* ------------------------------------------------------------ corners + highlights */
    setCorners(corners) {
      this.corners = corners ? corners.map((p) => [p[0], p[1]]) : null;
      this.selected = -1;
      this.requestDraw();
    }
    getCorners() { return this.corners ? this.corners.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]) : null; }
    quadStatus() {
      const size = this.imageSize;
      return analyzeQuad(this.corners, size && size.width, size && size.height);
    }
    setCorner(i, x, y, { final = true } = {}) {
      if (!this.corners || !this.img) return;
      this.corners[i] = [Math.min(this.img.naturalWidth - 1, Math.max(0, x)), Math.min(this.img.naturalHeight - 1, Math.max(0, y))];
      this.requestDraw();
      if (this.onCornersChange) this.onCornersChange({ corners: this.getCorners(), index: i, final, status: this.quadStatus() });
    }
    setHighlights(list) { this.highlights = list || []; this.requestDraw(); }

    /* ------------------------------------------------------------ input */
    _local(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    _hitHandle(p, pointerType) {
      if (!this.corners || !this.opts.editable) return -1;
      const radius = pointerType === 'touch' || pointerType === 'pen' ? 28 : 16;
      let best = -1;
      let bestD = radius;
      this.corners.forEach((c, i) => {
        const [sx, sy] = this.toScreen(c[0], c[1]);
        const d = Math.hypot(sx - p.x, sy - p.y);
        if (d <= bestD) { best = i; bestD = d; }
      });
      return best;
    }

    _hitHighlight(p) {
      if (!this.onHighlightClick) return null;
      const [ix, iy] = this.toImage(p.x, p.y);
      for (let i = this.highlights.length - 1; i >= 0; i -= 1) {
        const b = this.highlights[i];
        if (b.clickable !== false && ix >= b.x && ix <= b.x + b.w && iy >= b.y && iy <= b.y + b.h) return b;
      }
      return null;
    }

    _bind() {
      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => {
        if (!this.img) return;
        c.focus({ preventScroll: true });
        c.setPointerCapture(e.pointerId);
        const p = this._local(e);
        this.pointers.set(e.pointerId, p);
        if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale };
          this.dragging = -1; this.pan = null;
          return;
        }
        const hit = this._hitHandle(p, e.pointerType);
        if (hit >= 0) {
          this.dragging = hit; this.selected = hit;
          this._dragOffset = (() => { const [sx, sy] = this.toScreen(this.corners[hit][0], this.corners[hit][1]); return { x: sx - p.x, y: sy - p.y }; })();
          this.requestDraw();
        } else {
          this.pan = { x: p.x, y: p.y, tx: this.tx, ty: this.ty, moved: false };
          c.classList.add('is-panning');
        }
      });

      c.addEventListener('pointermove', (e) => {
        if (!this.img) return;
        const p = this._local(e);
        if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
        if (this.pinch && this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          this._zoomTo(this.pinch.scale * (dist / this.pinch.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
          return;
        }
        if (this.dragging >= 0) {
          const [ix, iy] = this.toImage(p.x + this._dragOffset.x, p.y + this._dragOffset.y);
          this.setCorner(this.dragging, ix, iy, { final: false });
        } else if (this.pan) {
          if (Math.abs(p.x - this.pan.x) + Math.abs(p.y - this.pan.y) > 3) this.pan.moved = true;
          this.tx = this.pan.tx + (p.x - this.pan.x);
          this.ty = this.pan.ty + (p.y - this.pan.y);
          this.fitted = false;
          this._clampPan();
          this._viewChanged();
        } else {
          const hv = this._hitHandle(p, e.pointerType);
          if (hv !== this.hover) { this.hover = hv; c.classList.toggle('on-handle', hv >= 0); this.requestDraw(); }
        }
      });

      const end = (e) => {
        const p = this._local(e);
        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2) this.pinch = null;
        if (this.dragging >= 0) {
          const i = this.dragging;
          this.dragging = -1;
          this.requestDraw();
          if (this.onCornersChange) this.onCornersChange({ corners: this.getCorners(), index: i, final: true, status: this.quadStatus() });
        }
        if (this.pan) {
          if (!this.pan.moved && e.type === 'pointerup') {
            const hit = this._hitHighlight(p);
            if (hit) this.onHighlightClick(hit);
          }
          this.pan = null;
          c.classList.remove('is-panning');
        }
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('pointerleave', () => { if (this.hover !== -1 && this.dragging < 0) { this.hover = -1; this.requestDraw(); } });

      c.addEventListener('wheel', (e) => {
        if (!this.img) return;
        e.preventDefault();
        const p = this._local(e);
        this._zoomTo(this.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), p.x, p.y);
      }, { passive: false });

      c.addEventListener('dblclick', (e) => {
        if (!this.img || this._hitHandle(this._local(e), 'mouse') >= 0) return;
        if (this.fitted) { const p = this._local(e); this._zoomTo(Math.max(1, this.fitScale * 2.5), p.x, p.y); } else this.fit();
      });

      c.addEventListener('keydown', (e) => this._key(e));
      c.addEventListener('blur', () => { this.selected = -1; this.requestDraw(); });
    }

    _key(e) {
      if (!this.img) return;
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (this.opts.editable && this.corners && /^[1-4]$/.test(e.key)) {
        this.selected = Number(e.key) - 1; this.requestDraw(); e.preventDefault(); return;
      }
      if (arrows[e.key]) {
        const step = e.shiftKey ? 10 : 1;
        if (this.opts.editable && this.corners && this.selected >= 0) {
          const c = this.corners[this.selected];
          this.setCorner(this.selected, c[0] + arrows[e.key][0] * step, c[1] + arrows[e.key][1] * step, { final: true });
        } else {
          this.tx -= arrows[e.key][0] * 40; this.ty -= arrows[e.key][1] * 40; this.fitted = false; this._clampPan(); this._viewChanged();
        }
        e.preventDefault();
      } else if (e.key === '+' || e.key === '=') { this.zoomBy(1.25); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { this.zoomBy(1 / 1.25); e.preventDefault(); }
      else if (e.key === '0') { this.fit(); e.preventDefault(); }
      else if (e.key === 'Escape') { this.selected = -1; this.requestDraw(); }
    }

    /* ------------------------------------------------------------ drawing */
    requestDraw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
    }

    _draw() {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.cw, this.ch);
      ctx.fillStyle = '#dfe6ef';
      ctx.fillRect(0, 0, this.cw, this.ch);
      if (!this.img) return;

      const iw = this.img.naturalWidth;
      const ih = this.img.naturalHeight;
      const s = this.scale;
      ctx.save();
      ctx.shadowColor = 'rgba(15,23,42,0.28)';
      ctx.shadowBlur = 14;
      ctx.fillStyle = '#fff';
      ctx.fillRect(this.tx, this.ty, iw * s, ih * s);
      ctx.restore();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.img, this.tx, this.ty, iw * s, ih * s);

      for (const b of this.highlights) {
        const [x, y] = this.toScreen(b.x, b.y);
        const w = b.w * s;
        const hh = b.h * s;
        ctx.fillStyle = b.fill || 'rgba(245, 158, 11, 0.28)';
        ctx.strokeStyle = b.stroke || 'rgba(217, 119, 6, 0.95)';
        ctx.lineWidth = b.width || 1.25;
        ctx.fillRect(x, y, w, hh);
        ctx.strokeRect(x + 0.5, y + 0.5, w, hh);
      }

      if (this.corners && this.overlayCorners) this._drawQuad(ctx, iw, ih);
    }

    _drawQuad(ctx, iw, ih) {
      const pts = this.corners.map((c) => this.toScreen(c[0], c[1]));
      const status = this.quadStatus();
      const color = status.ok ? '#2563eb' : '#dc2626';

      // dim everything outside the selected page area
      ctx.save();
      ctx.beginPath();
      const [x0, y0] = this.toScreen(0, 0);
      ctx.rect(x0, y0, iw * this.scale, ih * this.scale);
      ctx.moveTo(pts[0][0], pts[0][1]);
      pts.slice(1).forEach((p) => ctx.lineTo(p[0], p[1]));
      ctx.closePath();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.34)';
      ctx.fill('evenodd');
      ctx.restore();

      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      pts.slice(1).forEach((p) => ctx.lineTo(p[0], p[1]));
      ctx.closePath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();

      if (!this.opts.editable) return;
      pts.forEach((p, i) => {
        const active = i === this.dragging || i === this.selected;
        const hovered = i === this.hover;
        const r = HANDLE_R + (active || hovered ? 3 : 0);
        ctx.beginPath();
        ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
        ctx.fillStyle = active ? color : '#fff';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = active ? '#fff' : color;
        ctx.fillText(String(i + 1), p[0], p[1] + 0.5);
      });

      if (this.dragging >= 0) this._drawLoupe(ctx, pts[this.dragging], color);
    }

    /** Magnified view of the area under the dragged handle, so the corner can be placed to the pixel. */
    _drawLoupe(ctx, p, color) {
      const R = 58;
      const zoom = 4; // magnification relative to the on-screen size
      const onLeft = p[0] < this.cw / 2 && p[1] < this.ch / 2;
      const lx = onLeft ? this.cw - R - 14 : R + 14;
      const ly = R + 14;
      const [ix, iy] = this.toImage(p[0], p[1]);
      const srcSize = (R * 2) / (this.scale * zoom);
      ctx.save();
      ctx.beginPath();
      ctx.arc(lx, ly, R, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#fff';
      ctx.fillRect(lx - R, ly - R, R * 2, R * 2);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.img, ix - srcSize / 2, iy - srcSize / 2, srcSize, srcSize, lx - R, ly - R, R * 2, R * 2);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(lx, ly, R, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(lx - 10, ly); ctx.lineTo(lx + 10, ly); ctx.moveTo(lx, ly - 10); ctx.lineTo(lx, ly + 10);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    destroy() {
      this._observer.disconnect();
      cancelAnimationFrame(this._raf);
      this.canvas.remove();
    }
  }

  DV.PageViewer = PageViewer;
  DV.analyzeQuad = analyzeQuad;
  DV.cornerNames = NAMES;
})();
