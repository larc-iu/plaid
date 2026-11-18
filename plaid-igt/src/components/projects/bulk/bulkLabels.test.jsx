import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { IsolatedLabel } from '@ui/components/shared/IsolatedLabel.jsx';
import { labelText } from '@ui/lib/bidi.js';
import { respellLabel } from './RespellPanel.jsx';
import { fieldApplyLabel } from './FieldPanel.jsx';
import { replaceLabel } from '@/components/vocabularies/ReplaceDialog.jsx';

vi.mock('@/utils/feedback', () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
  notifySuccess: vi.fn(),
  humanizeError: (e) => String(e),
}));

// REV-G4-R2-2: Bulk Edit and the vocabulary's Replace save their History
// labels plain, and History draws each value in a <bdi> where it shows them,
// so nothing invisible is stored for good.
const AR = '\u0630\u0647\u0628 Ahmed';
const AR2 = '\u0643\u062a\u0628';
const ISOLATES = /[\u2066-\u2069]/;

describe('the History labels Bulk Edit and Replace save', () => {
  const labels = [
    [respellLabel(AR, AR2), [AR, AR2]],
    [fieldApplyLabel(AR, AR2, 'Gloss'), [AR, AR2]],
    [fieldApplyLabel(AR, '', 'Gloss'), [AR]],
    [
      replaceLabel({ filling: false, find: AR, repl: AR2, field: 'Gloss', vocabularyName: 'Lex' }),
      [AR, AR2],
    ],
    [
      replaceLabel({ filling: true, find: '', repl: AR2, field: 'Gloss', vocabularyName: 'Lex' }),
      [AR2],
    ],
  ];

  it('hold no isolate character', () => {
    for (const [label] of labels) expect(label).not.toMatch(ISOLATES);
    expect(labels.map(([l]) => l)).toEqual([
      `Respell “${AR}” → “${AR2}”`,
      `Replace “${AR}” → “${AR2}” in Gloss`,
      `Clear “${AR}” in Gloss`,
      `Replace “${AR}” → “${AR2}” in Gloss of Lex`,
      `Set Gloss to “${AR2}” where empty in Lex`,
    ]);
  });

  it('are drawn in History with each value in a <bdi>, the text the stored label', async () => {
    for (const [label, values] of labels) {
      const view = await renderComponent(<IsolatedLabel label={label} />);
      expect(view.container.textContent).toBe(label);
      const innermost = [...view.container.querySelectorAll('bdi')]
        .filter((b) => !b.querySelector('bdi'))
        .map((b) => b.textContent);
      expect(innermost).toEqual(values);
      await view.unmount();
    }
  });

  // Entries saved before this stored the isolates. They are left as they are:
  // drawn, the text is still exactly what was stored, with nothing added.
  it('draws a label stored with isolates as it was stored', async () => {
    const stored = `Respell “\u2068${AR}\u2069” → “\u2068${AR2}\u2069”`;
    expect(labelText([stored])).toBe(stored);
    const view = await renderComponent(<IsolatedLabel label={stored} />);
    expect(view.container.textContent).toBe(stored);
    await view.unmount();
  });
});
