/* New Scan page: choose a file (drag and drop, browse, sample or camera), validate it, upload with real progress, start processing. */
(function () {
  'use strict';
  const { $, h } = DV;

  const root = $('#scan-root');
  const maxBytes = Number(root.dataset.maxBytes);
  const ALLOWED = ['image/jpeg', 'image/png'];

  const dz = $('#dropzone');
  const input = $('#file-input');
  const fileCard = $('#file-card');
  const fileError = $('#file-error');
  const btnProcess = $('#btn-process');
  const btnOnly = $('#btn-upload-only');
  const preset = $('#preset');
  const submitError = $('#submit-error');

  let current = null; // { file, url, width, height }
  let busy = false;

  /* ----------------------------------------------------------- defaults from the user's settings */
  if ([...preset.options].some((o) => o.value === root.dataset.defaultPreset)) preset.value = root.dataset.defaultPreset;
  const typeRadio = document.querySelector(`input[name="doctype"][value="${root.dataset.defaultType}"]`);
  if (typeRadio) typeRadio.checked = true;

  /* ----------------------------------------------------------- steps */
  function setStep(n) {
    document.querySelectorAll('#scan-steps li').forEach((li) => {
      const s = Number(li.dataset.step);
      li.classList.toggle('is-done', s < n);
      li.classList.toggle('is-active', s === n);
    });
  }

  /* ----------------------------------------------------------- validation + preview */
  function showFileError(message) {
    fileError.classList.toggle('d-none', !message);
    fileError.replaceChildren(...(message ? [DV.icon('exclamation-octagon-fill'), h('div', null, message)] : []));
  }

  function readDimensions(file, url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('This file could not be opened as an image. It may be damaged.'));
      img.src = url;
    });
  }

  async function setFile(file, { type } = {}) {
    showFileError('');
    submitError.classList.add('d-none');
    if (!file) return;
    if (!ALLOWED.includes(file.type) && !/\.(jpe?g|png)$/i.test(file.name)) {
      showFileError('Only JPEG and PNG images are supported. Convert the page to one of those formats and try again.');
      return;
    }
    if (file.size === 0) { showFileError('That file is empty.'); return; }
    if (file.size > maxBytes) {
      showFileError(`That image is ${DV.fmt.bytes(file.size)}. The limit is ${root.dataset.maxMb} MB. Reduce the photo resolution or save it with more compression.`);
      return;
    }
    const url = URL.createObjectURL(file);
    let dims;
    try {
      dims = await readDimensions(file, url);
    } catch (err) {
      URL.revokeObjectURL(url);
      showFileError(err.message);
      return;
    }
    clearFile(true);
    current = { file, url, width: dims.width, height: dims.height };
    if (type) {
      const r = document.querySelector(`input[name="doctype"][value="${type}"]`);
      if (r) r.checked = true;
    }
    $('#file-thumb').src = url;
    $('#file-name').textContent = file.name;
    $('#file-name').title = file.name;
    $('#file-info').textContent = `${dims.width} x ${dims.height} px, ${DV.fmt.bytes(file.size)}`;
    const warn = $('#file-warning');
    const longSide = Math.max(dims.width, dims.height);
    if (longSide < 1200) {
      warn.textContent = 'Low resolution. Text may be hard to read; a long side of 1500 px or more works best.';
      warn.className = 'small mt-1 text-warning-emphasis';
    } else {
      warn.className = 'small mt-1 d-none';
    }
    fileCard.classList.remove('d-none');
    dz.classList.add('d-none');
    btnProcess.disabled = btnOnly.disabled = false;
    setStep(2);
  }

  function clearFile(keepSteps) {
    if (current) URL.revokeObjectURL(current.url);
    current = null;
    fileCard.classList.add('d-none');
    dz.classList.remove('d-none');
    input.value = '';
    btnProcess.disabled = btnOnly.disabled = true;
    if (!keepSteps) setStep(1);
  }

  /* ----------------------------------------------------------- drop zone */
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => setFile(input.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
  dz.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    if (files.length > 1) showFileError('Only one page at a time. The first image was used.');
    setFile(files[0]).then(() => { if (files.length > 1) showFileError('Only one page at a time. The first image was used.'); });
  });
  // A drop outside the zone must not make the browser navigate to the image.
  ['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { if (!dz.contains(e.target)) e.preventDefault(); }));
  $('#file-clear').addEventListener('click', () => clearFile(false));

  /* ----------------------------------------------------------- samples */
  document.querySelectorAll('[data-sample]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      setSource('file');
      try {
        const res = await fetch(`/static/assets/samples/${encodeURIComponent(btn.dataset.sample)}`);
        if (!res.ok) throw new Error('The sample could not be loaded.');
        const blob = await res.blob();
        await setFile(new File([blob], btn.dataset.name, { type: blob.type }), { type: btn.dataset.type });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        showFileError(err.message);
      }
    });
  });

  /* ----------------------------------------------------------- camera */
  const srcFile = $('#src-file');
  const srcCam = $('#src-camera');
  const paneFile = $('#pane-file');
  const paneCam = $('#pane-camera');
  const video = $('#cam-video');
  const camMsg = $('#cam-msg');
  const camDevice = $('#cam-device');
  const camCapture = $('#cam-capture');

  function setSource(which) {
    (which === 'camera' ? srcCam : srcFile).checked = true;
    paneFile.classList.toggle('d-none', which === 'camera');
    paneCam.classList.toggle('d-none', which !== 'camera');
    if (which === 'camera') startCamera(); else DV.camera.stop();
  }
  srcFile.addEventListener('change', () => setSource('file'));
  srcCam.addEventListener('change', () => setSource('camera'));

  async function startCamera(deviceId) {
    camCapture.disabled = true;
    camMsg.classList.remove('d-none');
    camMsg.textContent = 'Starting the camera...';
    try {
      const info = await DV.camera.start(video, deviceId);
      camMsg.classList.add('d-none');
      camCapture.disabled = false;
      const devices = await DV.camera.listDevices();
      camDevice.replaceChildren(...devices.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === info.deviceId }, d.label || `Camera ${i + 1}`)));
      camDevice.classList.toggle('d-none', devices.length < 2);
    } catch (err) {
      camMsg.textContent = err.message;
      camMsg.classList.remove('d-none');
    }
  }
  camDevice.addEventListener('change', () => startCamera(camDevice.value));
  camCapture.addEventListener('click', async () => {
    try {
      const file = await DV.camera.capture();
      DV.camera.stop();
      setSource('file');
      await setFile(file);
      DV.toast('Photo captured. Check it below, then process it.', 'success');
    } catch (err) {
      DV.toast(err.message, 'danger');
    }
  });

  /* ----------------------------------------------------------- upload with real progress (XHR) */
  function uploadFile(file, documentType, onProgress, retried) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/documents');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('X-CSRF-Token', DV.csrf());
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onerror = () => reject(new DV.ApiError(0, 'network', 'The upload failed. Check that the server is still running and try again.'));
      xhr.onload = async () => {
        let payload = null;
        try { payload = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && payload) return resolve(payload);
        const err = (payload && payload.error) || {};
        if (xhr.status === 403 && err.code === 'csrf_failed' && !retried) {
          try {
            const r = await fetch('/auth/csrf', { headers: { Accept: 'application/json' } });
            DV.setCsrf((await r.json()).csrfToken);
            return resolve(uploadFile(file, documentType, onProgress, true));
          } catch (e) { /* fall through */ }
        }
        if (xhr.status === 401) { window.location.assign('/login?next=/scan/new'); return undefined; }
        return reject(new DV.ApiError(xhr.status, err.code || 'error', err.message || `The upload failed (${xhr.status}).`));
      };
      const fd = new FormData();
      fd.append('document_type', documentType);
      fd.append('file', file, file.name);
      xhr.send(fd);
    });
  }

  async function submit(processNow) {
    if (!current || busy) return;
    busy = true;
    btnProcess.disabled = btnOnly.disabled = true;
    submitError.classList.add('d-none');
    const progress = $('#upload-progress');
    const bar = $('#upload-progress-bar');
    const pct = $('#upload-progress-pct');
    const label = $('#upload-progress-label');
    progress.classList.remove('d-none');
    setStep(3);
    const documentType = document.querySelector('input[name="doctype"]:checked').value;
    try {
      label.textContent = 'Uploading';
      const { document: doc } = await uploadFile(current.file, documentType, (f) => {
        bar.style.width = `${Math.round(f * 100)}%`;
        pct.textContent = `${Math.round(f * 100)}%`;
      });
      label.textContent = 'Checking the image';
      pct.textContent = '';
      if (processNow) {
        label.textContent = 'Starting processing';
        await DV.api('POST', `/api/documents/${doc.id}/process`, { json: { preset: preset.value, run_ocr: $('#run-ocr').checked, document_type: documentType } });
        window.location.assign(`/documents/${doc.id}/workspace?started=1`);
      } else {
        window.location.assign(`/documents/${doc.id}/workspace`);
      }
    } catch (err) {
      busy = false;
      btnProcess.disabled = btnOnly.disabled = false;
      progress.classList.add('d-none');
      bar.style.width = '0%';
      setStep(2);
      submitError.replaceChildren(DV.icon('exclamation-octagon-fill'), h('div', null, DV.errorMessage(err)));
      submitError.classList.remove('d-none');
    }
  }
  btnProcess.addEventListener('click', () => submit(true));
  btnOnly.addEventListener('click', () => submit(false));

  if (!DV.camera.supported()) {
    srcCam.parentElement.title = 'Camera capture needs http://localhost or HTTPS.';
  }
  if (window.location.hash === '#samples') document.getElementById('samples').scrollIntoView();
})();
