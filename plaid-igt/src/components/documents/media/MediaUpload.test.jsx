import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderComponent, all } from '../../../test/renderComponent.jsx';
import { MediaUpload } from './MediaUpload.jsx';

// The upload card shows the upload: the bytes as a bar with a count while
// they go up, then a pulsing bar while the server checks and saves the file.

const bar = (container) => container.querySelector('[role="progressbar"]');

describe('MediaUpload', () => {
  it('offers the file picker when nothing is uploading', async () => {
    const r = await renderComponent(<MediaUpload onUpload={vi.fn()} isUploading={false} />);
    expect(all(r.container, 'button')).toHaveLength(1);
    expect(bar(r.container)).toBeNull();
    await r.unmount();
  });

  it('shows the file, the percentage and the byte count while the bytes go up', async () => {
    const r = await renderComponent(
      <MediaUpload
        onUpload={vi.fn()}
        isUploading
        progress={{ name: 'talk.wav', loaded: 250, total: 1000 }}
      />,
    );
    expect(all(r.container, 'button')).toHaveLength(0);
    expect(r.container.textContent).toContain('talk.wav');
    expect(r.container.textContent).toContain('25%');
    expect(r.container.textContent).toContain('250 bytes of 1.0 KB');
    expect(bar(r.container).getAttribute('aria-valuenow')).toBe('25');
    await r.unmount();
  });

  it('pulses without a number once every byte is up and the server is at work', async () => {
    const r = await renderComponent(
      <MediaUpload
        onUpload={vi.fn()}
        isUploading
        progress={{ name: 'talk.wav', loaded: 1000, total: 1000 }}
      />,
    );
    expect(r.container.textContent).toContain('Processing…');
    expect(r.container.textContent).not.toContain('100%');
    expect(bar(r.container).hasAttribute('aria-valuenow')).toBe(false);
    await r.unmount();
  });
});
