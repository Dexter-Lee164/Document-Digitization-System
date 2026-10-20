/* Sign-in / register page behaviour: show-password toggle, password strength hint, client-side checks (the server re-validates). */
(function () {
  'use strict';

  document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = btn.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.firstElementChild.className = show ? 'bi bi-eye-slash' : 'bi bi-eye';
    });
  });

  const form = document.querySelector('[data-register]');
  if (form) {
    const pw = form.querySelector('#password');
    const meter = form.querySelector('[data-pw-meter]');
    pw.addEventListener('input', () => {
      const v = pw.value;
      let score = 0;
      if (v.length >= 8) score += 1;
      if (/[A-Za-z]/.test(v) && /[0-9]/.test(v)) score += 1;
      if (v.length >= 12) score += 1;
      if (/[^A-Za-z0-9]/.test(v) && v.length >= 8) score += 1;
      meter.style.width = `${(score / 4) * 100}%`;
      meter.style.background = score <= 1 ? '#dc2626' : score === 2 ? '#d97706' : '#16a34a';
    });
  }

  document.querySelectorAll('[data-auth-form]').forEach((f) => {
    f.addEventListener('submit', (e) => {
      const email = f.querySelector('input[name="email"]');
      const password = f.querySelector('input[name="password"]');
      const confirm = f.querySelector('input[name="confirm_password"]');
      let message = '';
      if (!email.value.trim()) message = 'Enter your email address.';
      else if (!password.value) message = 'Enter your password.';
      else if (f.hasAttribute('data-register')) {
        if (password.value.length < 8 || !/[A-Za-z]/.test(password.value) || !/[0-9]/.test(password.value)) message = 'Password must be at least 8 characters with a letter and a number.';
        else if (confirm && confirm.value !== password.value) message = 'The two passwords do not match.';
      }
      if (message) {
        e.preventDefault();
        let box = f.parentElement.querySelector('.dv-notice[data-client]');
        if (!box) {
          box = document.createElement('div');
          box.className = 'dv-notice dv-notice-bad mb-3';
          box.setAttribute('role', 'alert');
          box.setAttribute('data-client', '');
          f.parentElement.insertBefore(box, f);
        }
        box.textContent = message;
        return;
      }
      const submit = f.querySelector('button[type="submit"]');
      submit.disabled = true;
      submit.textContent = f.hasAttribute('data-register') ? 'Creating account...' : 'Signing in...';
    });
  });
})();
