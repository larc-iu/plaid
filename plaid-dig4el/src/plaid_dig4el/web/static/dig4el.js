// Word–concept linking: choosing a meaning is client-side (it only changes which
// words show as linked); clicking a word posts the toggle and the server re-renders
// the slot with the same meaning active.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.concept-btn');
  if (!btn) return;
  const linker = btn.closest('.linker');
  const chip = btn.closest('.concept');
  const concept = chip.dataset.concept;
  linker.dataset.active = concept;
  linker.style.setProperty('--active-color', chip.style.getPropertyValue('--c'));
  const hidden = linker.querySelector('input[name=concept]');
  if (hidden) hidden.value = concept;
  linker.querySelectorAll('.concept').forEach((li) => li.classList.toggle('active', li.dataset.concept === concept));
  linker.querySelectorAll('.word').forEach((w) => w.classList.toggle('on', linkedTo(w).includes(concept)));
});

// Hovering a meaning paints the words linked to it in its color.
const linkedTo = (word) => (word.dataset.concepts ? word.dataset.concepts.split('|') : []);
document.addEventListener('mouseover', (e) => {
  const chip = e.target.closest('.concept');
  if (!chip) return;
  const linker = chip.closest('.linker');
  linker.style.setProperty('--hl-color', chip.style.getPropertyValue('--c'));
  linker.querySelectorAll('.word').forEach((w) => w.classList.toggle('hl', linkedTo(w).includes(chip.dataset.concept)));
});
document.addEventListener('mouseout', (e) => {
  const chip = e.target.closest('.concept');
  if (!chip || chip.contains(e.relatedTarget)) return;
  chip.closest('.linker').querySelectorAll('.word.hl').forEach((w) => w.classList.remove('hl'));
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

// Typeahead for the WALS and Grambank names: the server sends the matches; picking
// one fills the field. Selection happens on mousedown so the input keeps focus.
document.addEventListener('mousedown', (e) => {
  const item = e.target.closest('.typeahead-item');
  if (!item) return;
  e.preventDefault();
  const ta = item.closest('.typeahead');
  ta.querySelector('input').value = item.dataset.value;
  ta.querySelector('.typeahead-menu').replaceChildren();
});
document.addEventListener('focusout', (e) => {
  const ta = e.target.closest && e.target.closest('.typeahead');
  if (ta) ta.querySelector('.typeahead-menu').replaceChildren();
});
document.addEventListener('keydown', (e) => {
  const ta = e.target.closest && e.target.closest('.typeahead');
  if (!ta) return;
  const menu = ta.querySelector('.typeahead-menu');
  const items = Array.from(menu.querySelectorAll('.typeahead-item'));
  if (e.key === 'Escape') { menu.replaceChildren(); return; }
  if (!items.length) return;
  let i = items.findIndex((it) => it.classList.contains('active'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    i = e.key === 'ArrowDown' ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0);
    items.forEach((it, k) => it.classList.toggle('active', k === i));
    items[i].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const pick = i >= 0 ? items[i] : items[0];
    ta.querySelector('input').value = pick.dataset.value;
    menu.replaceChildren();
  }
});
