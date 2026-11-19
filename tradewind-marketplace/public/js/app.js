// Small progressive enhancements (no framework needed)
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-toggle]');
  if (b) { document.querySelectorAll(b.dataset.toggle).forEach(el => el.classList.toggle('open')); }
  const c = e.target.closest('[data-confirm]');
  if (c && !window.confirm(c.dataset.confirm)) e.preventDefault();
  // close open dropdown menus when clicking elsewhere
  document.querySelectorAll('details.menu[open]').forEach(d => { if (!d.contains(e.target)) d.removeAttribute('open'); });
});
// Auto-submit filter forms when a select changes
document.querySelectorAll('form[data-autosubmit] select, form[data-autosubmit] input[type=checkbox]').forEach(el =>
  el.addEventListener('change', () => el.form.submit()));
// Scroll chat to the latest message
const chat = document.querySelector('.chat'); if (chat) chat.scrollTop = chat.scrollHeight;
// Print buttons (NDA document)
document.querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); window.print(); }));
// Capture the browser's time zone (used to show meeting times in local time)
try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; document.querySelectorAll('input[name=tz]').forEach(i => { i.value = tz; });
  document.querySelectorAll('select[data-default-tz]').forEach(s => { if (!s.dataset.set && [...s.options].some(o => o.value === tz)) s.value = tz; }); } catch (e) {}
// Meeting mode: show platform or location
document.querySelectorAll('select[name=mode]').forEach(sel => { const f = () => { const on = sel.value === 'in_person';
  document.querySelectorAll('[data-online]').forEach(x => x.style.display = on ? 'none' : ''); document.querySelectorAll('[data-inperson]').forEach(x => x.style.display = on ? '' : 'none'); };
  sel.addEventListener('change', f); f(); });
// Block casual right-click save in the secure vault viewer
document.querySelectorAll('.vault-frame').forEach(v => v.addEventListener('contextmenu', e => e.preventDefault()));
