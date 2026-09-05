// Word–concept linking: choosing a meaning is client-side (it only changes which
// words show as linked); clicking a word posts the toggle and the server re-renders
// the slot with the same meaning active.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.concept-btn');
  if (!btn) return;
  const linker = btn.closest('.linker');
  const concept = btn.closest('.concept').dataset.concept;
  linker.dataset.active = concept;
  const hidden = linker.querySelector('input[name=concept]');
  if (hidden) hidden.value = concept;
  linker.querySelectorAll('.concept').forEach((li) => li.classList.toggle('active', li.dataset.concept === concept));
  linker.querySelectorAll('.word').forEach((w) => {
    const linked = w.dataset.concepts ? w.dataset.concepts.split('|') : [];
    w.classList.toggle('on', linked.includes(concept));
  });
});

// After a translation is saved, move on to the next segment.
document.addEventListener('htmx:afterSwap', (e) => {
  const form = e.detail && e.detail.requestConfig && e.detail.requestConfig.elt;
  if (!form || !form.matches || !form.matches('form[data-advance]')) return;
  const slot = e.detail.target.closest ? e.detail.target.closest('.slot') : null;
  const next = slot && slot.nextElementSibling && slot.nextElementSibling.classList.contains('slot')
    ? slot.nextElementSibling : null;
  const input = next && next.querySelector('input[name=text]');
  if (input && !input.readOnly) { input.focus(); input.select(); }
});
