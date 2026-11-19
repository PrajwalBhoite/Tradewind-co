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
