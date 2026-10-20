/* Camera capture with the MediaDevices API.
   DV.camera.start(videoEl, deviceId) / stop() / capture() -> Promise<File>. The page script (upload.js) owns the UI. */
(function () {
  'use strict';
  const DV = (window.DV = window.DV || {});

  let stream = null;
  let video = null;

  function explain(err) {
    const name = err && err.name;
    if (!window.isSecureContext || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      return 'Camera capture needs a secure page. Open DocuVision at http://localhost (not by IP address) or over HTTPS.';
    }
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Camera access was blocked. Allow the camera for this site in the address bar, then try again.';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No camera was found on this computer.';
    if (name === 'NotReadableError' || name === 'TrackStartError') return 'The camera is being used by another program. Close it and try again.';
    if (name === 'SecurityError') return 'The browser did not allow camera access for this page.';
    return `The camera could not be started${err && err.message ? ` (${err.message})` : ''}.`;
  }

  async function open(constraints) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  const camera = {
    supported() {
      return Boolean(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    },

    async listDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput');
    },

    /** Start streaming into `videoEl`. Prefers the rear camera and a high resolution; falls back to anything available. */
    async start(videoEl, deviceId) {
      camera.stop();
      if (!camera.supported()) throw new Error(explain());
      const wanted = deviceId
        ? { video: { deviceId: { exact: deviceId }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false }
        : { video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false };
      try {
        try {
          stream = await open(wanted);
        } catch (err) {
          if (err && err.name === 'OverconstrainedError') stream = await open({ video: true, audio: false });
          else throw err;
        }
      } catch (err) {
        throw new Error(explain(err));
      }
      video = videoEl;
      video.srcObject = stream;
      await video.play().catch(() => {});
      await new Promise((resolve) => {
        if (video.videoWidth) return resolve();
        video.addEventListener('loadedmetadata', resolve, { once: true });
        return undefined;
      });
      const track = stream.getVideoTracks()[0];
      return { width: video.videoWidth, height: video.videoHeight, deviceId: track && track.getSettings ? track.getSettings().deviceId : undefined, label: track ? track.label : '' };
    },

    stop() {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
      stream = null;
      video = null;
    },

    /** Draw the current frame to a canvas at the camera's native resolution and return it as a JPEG File. */
    capture() {
      return new Promise((resolve, reject) => {
        if (!video || !video.videoWidth) { reject(new Error('The camera is not ready yet.')); return; }
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('The photo could not be saved.')); return; }
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          resolve(new File([blob], `camera-capture-${stamp}.jpg`, { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.92);
      });
    },
  };

  DV.camera = camera;
  window.addEventListener('pagehide', camera.stop);
})();
