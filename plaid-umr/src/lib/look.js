// TEMPORARY: switches for the visual review's second batch, so the same
// sentences can be rendered with each option and compared. Read once from
// `localStorage['umr-look']` (space-separated names), off unless set, and
// deleted once the options are chosen. See docs/umr/CANVAS.md, "VISUAL
// REVIEW".
const read = () => {
  try {
    return window.localStorage.getItem('umr-look') || '';
  } catch {
    return '';
  }
};

export const LOOK_ATTR = typeof window === 'undefined' ? '' : read();
export const LOOK = new Set(LOOK_ATTR.split(/\s+/).filter(Boolean));
