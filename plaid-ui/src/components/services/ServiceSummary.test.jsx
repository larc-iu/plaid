// @vitest-environment jsdom
// A service's summary is Markdown its author hard-wraps at about 80 columns,
// as every service in this repository does. A single newline inside a
// paragraph flows as a space, as Markdown has it. A blank line still starts a
// paragraph and a list item its own line.
//
// Under jsdom, which parses markup as Chrome does: under happy-dom the
// sanitizer's parse drops the first <p> of the summary.
import { describe, it, expect, afterEach } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { ServiceSummary } from './ServiceSummary.jsx';

const SUMMARY = `**PolyGloss** (Ginn et al. 2026) proposes a morpheme **segmentation** and
**glosses** for every word of the document in one pass, from the words and each
sentence's free translation.

- **Language** / **Metalanguage**: the object language's name as the model
  would know it (e.g. \`Lezgian\`) and the translation's language.
- **Gloss field**: the morpheme-scope field that receives the glosses.

Everything it writes is stamped machine-made.
`;

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

// Laid out, a newline in the text is a space.
const flowed = (node) => node.textContent.replace(/\s+/g, ' ').trim();

const openBubble = async (service) => {
  view = await renderComponent(<ServiceSummary service={service} />);
  const button = view.container.querySelector('button');
  await view.step(() => button.click());
  return document.querySelector('[data-radix-popper-content-wrapper] .md-body');
};

describe('ServiceSummary', () => {
  it('flows a hard-wrapped paragraph and keeps paragraphs and list items apart', async () => {
    const body = await openBubble({ serviceName: 'PolyGloss', extras: { summary: SUMMARY } });
    expect(body).not.toBeNull();
    expect(body.querySelectorAll('br')).toHaveLength(0);
    const paragraphs = [...body.querySelectorAll('p')].map(flowed);
    expect(paragraphs).toEqual([
      "PolyGloss (Ginn et al. 2026) proposes a morpheme segmentation and glosses for every word of the document in one pass, from the words and each sentence's free translation.",
      'Everything it writes is stamped machine-made.',
    ]);
    const items = [...body.querySelectorAll('li')].map(flowed);
    expect(items).toEqual([
      "Language / Metalanguage: the object language's name as the model would know it (e.g. Lezgian) and the translation's language.",
      'Gloss field: the morpheme-scope field that receives the glosses.',
    ]);
  });

  it('flows a description too, when there is no summary', async () => {
    const body = await openBubble({
      serviceName: 'Probe',
      description: 'One line\nand the next',
    });
    expect(body.querySelectorAll('br')).toHaveLength(0);
    expect(flowed(body)).toBe('One line and the next');
  });
});
