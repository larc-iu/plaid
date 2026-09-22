// User text takes its own direction, wherever the shared package draws it.
//
// The rule from `plaid_rtl_support.md`: LAYOUT takes the document's direction,
// a VALUE takes its own, which is `dir="auto"`. These three had been missed,
// and each carries text a person typed: the question in the assistant
// transcript (the composer it was typed in IS auto, so an Arabic question read
// right until it was sent), the name of a file they attached, and the label of
// the history entry a restore names.
import { describe, it, expect } from 'vitest';
import { renderComponent } from './renderComponent.jsx';
import { Turn } from '../components/assistant/Turn.jsx';
import { AttachmentChip } from '../components/assistant/AttachmentChip.jsx';
import { HistoryDrawer } from '../components/shared/HistoryDrawer.jsx';

const ARABIC = 'ما معنى هذه الجملة؟';

describe('text a person typed', () => {
  it('reads in its own direction in the assistant transcript', async () => {
    const view = await renderComponent(
      <Turn item={{ kind: 'user', text: ARABIC, files: [] }} projectId="p1" />,
    );
    const bubble = view.container.querySelector('.whitespace-pre-wrap');
    expect(bubble.textContent).toBe(ARABIC);
    expect(bubble.dir).toBe('auto');
    await view.unmount();
  });

  it('reads in its own direction on an attachment chip', async () => {
    const view = await renderComponent(
      <AttachmentChip file={{ id: 'f1', name: 'مفردات.csv', bytes: 120 }} />,
    );
    const name = view.container.querySelector('span.truncate');
    expect(name.textContent).toBe('مفردات.csv');
    expect(name.dir).toBe('auto');
    await view.unmount();
  });

  it('reads in its own direction on the history entry a restore names', async () => {
    const view = await renderComponent(
      <HistoryDrawer
        isOpen
        onClose={() => {}}
        auditEntries={[]}
        loading={false}
        error={null}
        onSelectEntry={() => {}}
        selectedEntry={{ id: 'e1', label: 'تصحيح الترجمة', time: '2026-09-01T00:00:00Z' }}
      />,
    );
    const label = view.container.querySelector('p.line-clamp-2');
    expect(label.textContent).toBe('تصحيح الترجمة');
    expect(label.dir).toBe('auto');
    await view.unmount();
  });
});
