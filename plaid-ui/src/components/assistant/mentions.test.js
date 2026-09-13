import { describe, it, expect } from 'vitest';
import { activeMention, filterMentions, insertMention } from './mentions.js';

// The composer is a textarea that sends on Enter, so everything about `@` has
// to be decided from the text and the caret alone. These are the cases that
// bite: a caret in the middle of a finished message, an `@` that is part of an
// address rather than a mention, and a name with a space in it.

const at = (text) => [text.replace('|', ''), text.indexOf('|')];

describe('activeMention', () => {
  it('finds the run the caret is in', () => {
    expect(activeMention(...at('about @s5|'))).toEqual({ query: 's5', from: 6, to: 9 });
  });

  it('opens on the bare @, so the list can show everything', () => {
    expect(activeMention(...at('about @|'))).toEqual({ query: '', from: 6, to: 7 });
  });

  it('takes the LAST @ before the caret, not the first', () => {
    const m = activeMention(...at('@s5 and @s1|'));
    expect(m.query).toBe('s1');
    expect(m.from).toBe(8);
  });

  it('keeps spaces, because document names have them', () => {
    expect(activeMention(...at('@Text 3|')).query).toBe('Text 3');
  });

  it('is not a mention when the @ is attached to a word', () => {
    // An email address, which is the one thing readers type with an @ in it.
    expect(activeMention(...at('mail a@b.com|'))).toBeNull();
  });

  it('reads only up to the caret, leaving the rest of the message alone', () => {
    expect(activeMention(...at('@s5| and more')).query).toBe('s5');
  });

  it('ends at a newline and at a runaway length', () => {
    expect(activeMention(...at('@s5\nnext line|'))).toBeNull();
    expect(activeMention(...at(`@${'x'.repeat(200)}|`))).toBeNull();
  });

  it('is null with no @ at all, and tolerates nonsense', () => {
    expect(activeMention(...at('nothing here|'))).toBeNull();
    expect(activeMention(null, 0)).toBeNull();
    expect(activeMention('@', -1)).toBeNull();
  });
});

describe('insertMention', () => {
  it('replaces the run and leaves one space after it', () => {
    const [text, caret] = at('about @s|');
    expect(insertMention(text, caret, 's5')).toEqual({ text: 'about s5 ', caret: 9 });
  });

  it('does not double the space when one is already there', () => {
    const [text, caret] = at('about @s| and more');
    expect(insertMention(text, caret, 's5')).toEqual({ text: 'about s5 and more', caret: 8 });
  });

  it('writes a reference with spaces in it', () => {
    const [text, caret] = at('compare @Te|');
    expect(insertMention(text, caret, 'Text 3 s5').text).toBe('compare Text 3 s5 ');
  });

  it('changes nothing when no mention is active', () => {
    expect(insertMention('plain text', 5, 's5')).toEqual({ text: 'plain text', caret: 5 });
  });
});

describe('filterMentions', () => {
  const groups = [
    {
      group: 'Sentences',
      items: [
        { value: 's1', label: 's1', hint: 'the dog runs' },
        { value: 's2', label: 's2', hint: 'she sings' },
      ],
    },
    { group: 'Documents', items: [{ value: 'Text 3', label: 'Text 3' }] },
  ];

  it('matches what a sentence SAYS, not only what it is called', () => {
    // Nobody knows they want s1. They know it is the one about the dog.
    const out = filterMentions(groups, 'dog');
    expect(out).toHaveLength(1);
    expect(out[0].items.map((i) => i.value)).toEqual(['s1']);
  });

  it('still matches the label', () => {
    expect(filterMentions(groups, 'Text').map((g) => g.group)).toEqual(['Documents']);
  });

  it('drops a group with nothing left in it', () => {
    expect(filterMentions(groups, 'nothing at all')).toEqual([]);
  });

  it('gives everything back for an empty query', () => {
    expect(filterMentions(groups, '')).toHaveLength(2);
  });

  it('caps a group, because a long document is not a list to scroll', () => {
    const many = [
      {
        group: 'Sentences',
        items: Array.from({ length: 500 }, (_, i) => ({ value: `s${i}`, label: `s${i}` })),
      },
    ];
    expect(filterMentions(many, '')[0].items).toHaveLength(50);
  });
});
