// The option shapes a Combobox takes and the walks over them, apart from the
// component so that files which only need the shapes (the mention list, a
// hook) import no React tree, and so the component file exports one thing.
const normalizeOption = (option) =>
  typeof option === 'string'
    ? { value: option, label: option }
    : { ...option, label: option.label ?? option.value };

/** Strings, `{value,label}` and `{group,items}` in, the last two out. */
export function normalizeOptions(options) {
  return (options || []).map((option) =>
    option && typeof option === 'object' && 'group' in option
      ? { ...option, items: (option.items || []).map(normalizeOption) }
      : normalizeOption(option),
  );
}

/** The options a keyboard walks, in display order, with the groups flattened away. */
export function flattenOptions(options) {
  return (options || []).flatMap((option) => ('group' in option ? option.items : [option]));
}

/** Substring match on the label, group-aware. What a call site gets if it names no filter. */
export function defaultFilter({ options, search }) {
  const q = (search || '').trim().toLowerCase();
  if (!q) return options;
  const keep = (option) => option.label.toLowerCase().includes(q);
  return options
    .map((option) => ('group' in option ? { ...option, items: option.items.filter(keep) } : option))
    .filter((option) => ('group' in option ? option.items.length > 0 : keep(option)));
}
