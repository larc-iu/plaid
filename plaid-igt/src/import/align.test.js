import { describe, it, expect } from 'vitest';
import {
  makeCpIndexer,
  matchesAt,
  foldChar,
  splitAnalyzed,
  surfaceOf,
  alignWords,
} from './align.js';

describe('makeCpIndexer', () => {
  it('is the identity for a string with no astral characters', () => {
    const at = makeCpIndexer('perros corren');
    expect([at(0), at(6), at(13)]).toEqual([0, 6, 13]);
  });

  it('counts a surrogate pair as one code point', () => {
    const s = 'a😀b'; // 4 UTF-16 units, 3 code points
    const at = makeCpIndexer(s);
    expect(s.length).toBe(4);
    expect([at(0), at(1), at(3), at(4)]).toEqual([0, 1, 2, 3]);
  });

  it('clamps out-of-range indexes rather than returning undefined', () => {
    for (const s of ['abc', 'a😀b']) {
      const at = makeCpIndexer(s);
      expect(at(-5)).toBe(0);
      expect(at(999)).toBe([...s].length);
    }
  });

  it('agrees with the naive conversion at every code-point boundary', () => {
    const s = 'a😀b́c𝔘d ẞ😀';
    const at = makeCpIndexer(s);
    let u = 0;
    for (const ch of s) {
      expect(at(u)).toBe([...s.slice(0, u)].length);
      u += ch.length;
    }
    expect(at(s.length)).toBe([...s].length);
  });

  it('maps an index inside a surrogate pair to the code point containing it', () => {
    // Offsets never split a code point in practice (matching advances whole
    // code points), so this only has to be defined, not equal to the naive
    // conversion, which would count a lone surrogate as a character.
    const at = makeCpIndexer('a😀b');
    expect(at(2)).toBe(1);
  });
});

describe('matchesAt', () => {
  it('matches case-foldedly and returns the index just past the match', () => {
    expect(matchesAt('За что', 0, 'за')).toBe(2);
    expect(matchesAt('За что', 0, 'xx')).toBe(false);
    expect(matchesAt('abc', 2, 'cd')).toBe(false);
  });

  it('folds the Turkish dotted capital I onto i', () => {
    expect(foldChar('İ')).toBe('i');
  });
});

describe('splitAnalyzed / surfaceOf', () => {
  it('splits on both Leipzig joints and remembers which one preceded each piece', () => {
    expect(splitAnalyzed('perro=s')).toEqual([
      { form: 'perro', before: null },
      { form: 's', before: '=' },
    ]);
    expect(splitAnalyzed('un-break-able').map((p) => p.form)).toEqual(['un', 'break', 'able']);
  });

  it('treats an unsegmented word as one piece, and never returns nothing', () => {
    expect(splitAnalyzed('corren')).toEqual([{ form: 'corren', before: null }]);
    expect(splitAnalyzed('')).toEqual([{ form: '', before: null }]);
  });

  it('recovers the surface form by dropping the joints', () => {
    expect(surfaceOf('perro=s')).toBe('perros');
    expect(surfaceOf('un-break-able')).toBe('unbreakable');
  });
});

describe('alignWords', () => {
  const align = (body, forms) => alignWords(body, 0, body.length, forms);

  it('finds each word in order and returns its offsets', () => {
    const { spans, warnings } = align('perros corren.', ['perro=s', 'corren']);
    expect(spans).toEqual([
      { beginU16: 0, endU16: 6 },
      { beginU16: 7, endU16: 13 },
    ]);
    expect(warnings).toEqual([]);
  });

  it('prefers a verbatim match, so a real hyphen in the text wins', () => {
    // "well-known" is one word in the text AND has a morpheme joint.
    const { spans } = align('a well-known fact', ['a', 'well-known', 'fact']);
    expect(spans[1]).toEqual({ beginU16: 2, endU16: 12 });
  });

  it('falls back to the joint-stripped surface when the text is unsegmented', () => {
    const { spans } = align('unbreakable', ['un-break-able']);
    expect(spans[0]).toEqual({ beginU16: 0, endU16: 11 });
  });

  it('matches case-insensitively', () => {
    const { spans } = align('За что', ['за', 'что']);
    expect(spans[0]).toEqual({ beginU16: 0, endU16: 2 });
  });

  it('finds a form inside a run that carries punctuation', () => {
    const { spans, warnings } = align('¡Hola amigo!', ['Hola', 'amigo']);
    expect(spans[0]).toEqual({ beginU16: 1, endU16: 5 });
    expect(spans[1]).toEqual({ beginU16: 6, endU16: 11 });
    expect(warnings).toEqual([]);
  });

  it('covers the whole word when the analysis accounts for only part of it', () => {
    // Real Tsez: the text writes "yegirxo" but the analysis is "y-egir-x",
    // dropping the final vowel. Matching alone left that "o" outside every
    // token, where it could not be annotated and would not tile on export.
    const body = 'ciqaɣort’a yegirxo zown.';
    const { spans } = align(body, ['ciq-aɣor-t’a', 'y-egir-x', 'zow-n']);
    const at = (s) => body.slice(s.beginU16, s.endU16);
    expect(spans.map(at)).toEqual(['ciqaɣort’a', 'yegirxo', 'zown']);
  });

  it('still leaves edge punctuation out of the word it follows', () => {
    const body = 'hola, amigo!';
    const { spans } = align(body, ['hola', 'amigo']);
    const at = (s) => body.slice(s.beginU16, s.endU16);
    expect(spans.map(at)).toEqual(['hola', 'amigo']);
  });

  it('never cuts a word in half, whatever the analysis says', () => {
    // The structural guarantee behind the "yegirxo" fix: a span is always a
    // whole run minus edge punctuation, so no span can end (or start) with a
    // letter still attached to it. Morphemes carry no extent of their own, so
    // a decomposition must never be able to narrow the word it describes.
    const cases = [
      ['Axʷa ciqaɣort’a yegirxo zown.', ['ax-a', 'ciq-aɣor-t’a', 'y-egir-x', 'zow-n']],
      ['perros corren.', ['perro=s', 'corren']],
      ['¡Hola, amigo!', ['Hola', 'amigo']],
      ['a well-known fact', ['a', 'well-known', 'fact']],
      ['Allahes ašuni bukayn.', ['Allah-s', 'ašuni', 'b-ukad-n']],
      ['uno dos tres', ['un', 'do', 'tre']],
    ];
    const letter = (c) => c !== undefined && /\p{L}|\p{N}/u.test(c);
    for (const [body, forms] of cases) {
      const { spans } = alignWords(body, 0, body.length, forms);
      for (const s of spans) {
        if (!s) continue;
        expect(letter(body[s.endU16])).toBe(false);
        expect(letter(body[s.beginU16 - 1])).toBe(false);
      }
    }
  });

  it('falls back to the word in that position when the form is not in the text', () => {
    // The morphophonemic analysis of a surface form, which is the normal case
    // in a real corpus: "Allah-s" is written *Allahes*, "b-ukad-n" is *bukayn*.
    const { spans } = align('Allahes ašuni bukayn.', ['Allah-s', 'ašuni', 'b-ukad-n']);
    const at = (s) => 'Allahes ašuni bukayn.'.slice(s.beginU16, s.endU16);
    expect(spans.map(at)).toEqual(['Allahes', 'ašuni', 'bukayn']);
  });

  it('drops edge punctuation from a positionally aligned word', () => {
    const body = 'ɣˤana-xediw.';
    // An en dash in the analysis where the text has a hyphen: no character match.
    const { spans } = alignWords(body, 0, body.length, ['ɣˤana\u2013xediw']);
    expect(body.slice(spans[0].beginU16, spans[0].endU16)).toBe('ɣˤana-xediw');
  });

  it('skips only as many runs as the analysis can afford to leave out', () => {
    // Three runs, two forms: the standalone comma may be skipped, and is.
    const body = 'Hola , amigo';
    const { spans } = alignWords(body, 0, body.length, ['Hola', 'amigo']);
    expect(spans.map((s) => body.slice(s.beginU16, s.endU16))).toEqual(['Hola', 'amigo']);
  });

  it('mixes exact matches and positional fallbacks within one sentence', () => {
    // A real Tsez line: "yiła-a" and "ašuni-q" are morphophonemic and appear
    // nowhere in the text, "neła-q" and "harizi" do occur, and the third word
    // is parenthesized in the text but not in the analysis.
    const body = 'Yiła nełaq (ašunoq) harizi';
    const forms = ['yiła-a', 'neła-q', 'ašuni-q', 'harizi'];
    const { spans, warnings } = alignWords(body, 0, body.length, forms);
    expect(spans.map((s) => body.slice(s.beginU16, s.endU16))).toEqual([
      'Yiła',
      'nełaq',
      'ašunoq',
      'harizi',
    ]);
    expect(warnings).toEqual([]);
  });

  it('reports having run out of text, and keeps going', () => {
    const { spans, warnings } = align('perros corren', ['perros', 'corren', 'ladran']);
    expect(spans[2]).toBeNull();
    expect(warnings.join(' ')).toMatch(/no text left to align "ladran"/);
  });

  it('warns when the two sequences are not the same length', () => {
    const { warnings } = align('uno dos tres', ['uno', 'dos']);
    expect(warnings.join(' ')).toMatch(/2 analyzed words for 3 words of text/);
  });

  it('never runs past the end of its sentence', () => {
    const body = 'uno dos\ntres';
    const { spans } = alignWords(body, 0, 7, ['uno', 'tres']);
    // "tres" is in the next sentence, so position 2 is "dos", not "tres".
    expect(body.slice(spans[1].beginU16, spans[1].endU16)).toBe('dos');
  });
});
