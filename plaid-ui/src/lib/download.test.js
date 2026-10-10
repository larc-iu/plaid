import { describe, it, expect, vi } from 'vitest';
import { copyText, sanitizeFilename } from './download.js';
import { notifyError } from './notify.js';

vi.mock('./notify.js', () => ({ notifyError: vi.fn() }));

describe('sanitizeFilename', () => {
  it('strips path separators and reserved characters', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });
  it('keeps unicode, spaces, and hyphens', () => {
    expect(sanitizeFilename('Лезги текст — copy-2')).toBe('Лезги текст — copy-2');
    expect(sanitizeFilename('نص')).toBe('نص');
  });
  it('trims leading/trailing dots and falls back when empty', () => {
    expect(sanitizeFilename('..hidden..')).toBe('hidden');
    expect(sanitizeFilename('///')).toBe('untitled');
    expect(sanitizeFilename('  ')).toBe('untitled');
    expect(sanitizeFilename(null)).toBe('untitled');
  });
  it('caps length by code points, never stranding a surrogate half', () => {
    expect(sanitizeFilename('x'.repeat(300)).length).toBe(120);
    const astral = sanitizeFilename('𝕒'.repeat(130));
    expect([...astral].length).toBe(120);
    expect(astral.isWellFormed()).toBe(true);
  });
});

describe('copyText', () => {
  it('says the failure when the clipboard refuses', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      expect(await copyText('x', 'Copy it by hand.')).toBe(false);
      expect(notifyError).toHaveBeenCalledWith('Copy it by hand.', 'Failed to copy');
      writeText.mockResolvedValue(undefined);
      notifyError.mockClear();
      expect(await copyText('x', 'Copy it by hand.')).toBe(true);
      expect(notifyError).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
