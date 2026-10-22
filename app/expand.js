// "Expand beyond Seattle": an email and city sign-up box, posting to the endpoint in config.js.
import { CONFIG } from './config.js';

export function mountExpand(el, source) {
  const open = !!CONFIG.signup;
  el.innerHTML = `<h3>Expand beyond Seattle</h3>
    <div class="note">Want Skylanes over your city? Leave your email and city; we'll write when we add it.</div>
    <form novalidate>
      <input type="email" name="email" placeholder="you@example.com" autocomplete="email" required ${open ? '' : 'disabled'} aria-label="Email">
      <input type="text" name="city" placeholder="City" autocomplete="address-level2" ${open ? '' : 'disabled'} aria-label="City" style="max-width:9em">
      <button type="submit" ${open ? '' : 'disabled'}>${open ? 'Notify me' : 'Opening soon'}</button>
    </form>
    <div class="fine">${open ? 'Used only to tell you about new cities. Unsubscribe any time.' : 'Sign-ups are not connected yet.'}</div>`;
  if (!open) return;
  const form = el.querySelector('form'), fine = el.querySelector('.fine');
  form.onsubmit = async e => {
    e.preventDefault();
    const email = form.email.value.trim(), city = form.city.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { fine.textContent = 'That email does not look right.'; form.email.focus(); return; }
    form.querySelector('button').disabled = true;
    try {
      const s = CONFIG.signup;
      if (s.kind === 'formspree') {
        const r = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email, city, source }) });
        if (!r.ok) throw new Error(r.status);
      } else if (s.kind === 'google-form') {
        // Google Forms accepts the post but sends no CORS headers, so the response cannot be read.
        await fetch(s.url, { method: 'POST', mode: 'no-cors', body: new URLSearchParams({ [s.emailField]: email, [s.cityField]: city }) });
      }
      el.querySelector('form').remove();
      fine.textContent = `Thanks. We'll email ${email} when Skylanes reaches ${city || 'your city'}.`;
    } catch {
      form.querySelector('button').disabled = false;
      fine.textContent = 'Could not send just now. Try again in a moment.';
    }
  };
}
