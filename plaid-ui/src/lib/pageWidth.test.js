import { describe, it, expect } from 'vitest';
import { FORM_PAGE_WIDTH, LIST_PAGE_WIDTH } from './pageWidth.js';

// The two page widths, as ruled: lists and tables 1320px, settings and forms
// 1024px (Tailwind's max-w-5xl). A change here moves every app at once.
describe('page widths', () => {
  it('gives lists and tables 1320px', () => {
    expect(LIST_PAGE_WIDTH).toBe('max-w-[1320px]');
  });

  it('gives settings and forms 1024px', () => {
    expect(FORM_PAGE_WIDTH).toBe('max-w-5xl');
  });
});
