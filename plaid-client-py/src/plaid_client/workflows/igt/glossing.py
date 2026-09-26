"""How plaid-igt reads a gloss and a morpheme: which part of a gloss is a word
and which a grammatical abbreviation, which morph types are bound, and what
the zero morph is.

The Python side of three rules plaid-igt owns: ``lexicalFlags`` and
``isLexicalPart`` in ``domain/tagsets.js`` (tagset checks, LaTeX small caps),
``isBoundType`` in ``domain/affixMarkers.js`` and ``isZeroMorph`` in
``domain/zeroMorph.js``. A service that reads glosses (the UMR skeleton) reads
them by these, so a gloss the app sets in small caps is one the service takes
for an abbreviation. ``tests/test_igt_glossing_mirror.py`` runs the three
JavaScript files and fails when the two sides answer differently.

**The case rule.** The Leipzig Glossing Rules write a grammatical gloss in
capitals and digits (``NOM``, ``1SG``, ``PST``) and a lexical gloss as an
ordinary word (``dog``). So a part is lexical when it has a lower case letter,
or letters but no capital (a word in a script with no case, ``水``), unless it
is a person and number in either case (``3sg`` is never a word) or a known
abbreviation spelled exactly as listed.

**The lenient reading.** A glossing tradition may write its abbreviations in
lower case inside a compound gloss (Lamkang ``sbj:3.pfv``). Where one part of
a morpheme's gloss is grammatical by the case rule, a known abbreviation of
two letters or more beside it in the same morpheme is grammatical too
(``pfv``). A part in another morpheme does not count (``3SG-pfv`` keeps
``pfv``).

**The fall-back.** When the lenient reading leaves a unit with no lexical part
where the case rule found one, the case rule stands for the whole unit:
``pass.PST`` is the verb ``pass``, not two abbreviations. The unit is what the
caller reads as one: a cell in the app, all of one word's glosses in the
skeleton.
"""

import re
import unicodedata
from typing import FrozenSet, Iterable, List, Optional, Sequence

#: The zero morph as IGT writes it (``Alt+0`` types U+2205). The digit 0 is a
#: real form, a numeral, and only looks like one.
ZERO_MORPH = '∅'


def is_zero_morph(form) -> bool:
    """Whether a morpheme's form is the zero morph (``isZeroMorph``)."""
    return form == ZERO_MORPH


def is_clitic(morph_type) -> bool:
    """A clitic of any kind: clitic, enclitic, proclitic (``isClitic``)."""
    return isinstance(morph_type, str) and 'clitic' in morph_type.lower()


def is_bound_type(morph_type) -> bool:
    """An affix or a clitic, by IGT's morph type (FLEx's names): never the
    morpheme that names a word (``isBoundType``)."""
    return isinstance(morph_type, str) and (
        is_clitic(morph_type) or morph_type.lower().endswith('fix'))


#: The abbreviations a gloss part may stand for, upper case: the Leipzig
#: Glossing Rules list, with Lamkang's POS beside POSS and the tense, aspect
#: and number marks the UMR skeleton reads. Single letters are listed, but
#: the lenient reading never takes a single letter for one.
GLOSS_ABBREVIATIONS: FrozenSet[str] = frozenset('''
    1 2 3 4 A ABL ABS ACC ADJ ADV AGR ALL ANTIP APPL ART AUX BEN CAUS CLF COM COMP
    COMPL COND COP CVB DAT DECL DEF DEM DET DIST DISTR DU DUR ERG EXCL F FOC FUT GEN
    HAB IMP INCL IND INDF INF INS INTR IPFV IRR LOC M N NEG NMLZ NOM NPST NSG OBJ OBL
    P PASS PAUC PFV PL POS POSS PRED PRF PROG PROH PROX PRS PST PTCP PURP Q QUOT
    REAL RECP REFL REL RES S SBJ SBJV SG TOP TR TRI VOC
'''.split())

#: A person and number written as one abbreviation, in either case: ``3SG``,
#: ``1pl``, ``2DU``.
PERSON_NUMBER = re.compile(r'^([1-4])(SG|PL|DU|TRI|PAUC|NSG)$', re.IGNORECASE | re.ASCII)

#: What a gloss is cut into morphemes on (``dog-PL``, ``3SG=go``, ``go out``),
#: and what one morpheme's gloss is cut into parts on, the Leipzig separators
#: for one form that means several things (``bark.PRS``, ``sbj:3.pfv``,
#: ``hit;PST``, ``sing\\PST``).
MORPHEME_CUT = re.compile(r'[\-=~<>\s]+')
PART_CUT = re.compile(r'[.:;\\]+')


def _category(part: str, prefix: str) -> bool:
    return any(unicodedata.category(c).startswith(prefix) for c in part)


def _is_case_lexical(part: str, known: Iterable[str]) -> bool:
    if PERSON_NUMBER.match(part) or part in known:
        return False
    if _category(part, 'Ll'):
        return True
    return _category(part, 'L') and not (_category(part, 'Lu') or _category(part, 'Lt'))


def _is_mark(part: str) -> bool:
    """A grammatical part that sets off the lenient reading: one with a letter
    or a digit, not a stray symbol."""
    return _category(part, 'L') or _category(part, 'N')


def _strict_flags(morphemes, known) -> List[List[bool]]:
    return [[_is_case_lexical(p, known) for p in parts] for parts in morphemes]


def _lenient_flags(morphemes, strict, known) -> List[List[bool]]:
    lenient = []
    for parts, flags in zip(morphemes, strict):
        mixed = len(parts) > 1 and any(not f and _is_mark(p) for p, f in zip(parts, flags))
        lenient.append([f and not (mixed and len(p) > 1 and p.upper() in known)
                        for p, f in zip(parts, flags)])
    return lenient


def lexical_flags(morphemes: Sequence[Sequence[str]],
                  known: Optional[Iterable[str]] = None) -> List[List[bool]]:
    """Which parts of one unit are lexical, morpheme by morpheme: the case
    rule, the lenient reading within each morpheme, and the fall-back over the
    unit. ``morphemes`` is a list of morphemes, each a list of parts.
    ``known`` is the abbreviations, ``GLOSS_ABBREVIATIONS`` by default."""
    known = GLOSS_ABBREVIATIONS if known is None else frozenset(known)
    strict = _strict_flags(morphemes, known)
    lenient = _lenient_flags(morphemes, strict, known)
    if any(any(f) for f in strict) and not any(any(f) for f in lenient):
        return strict
    return lenient


def lenient_flags(morphemes: Sequence[Sequence[str]],
                  known: Optional[Iterable[str]] = None) -> List[List[bool]]:
    """``lexical_flags`` without the fall-back: for a gloss that can never
    name its word (an affix's, a clitic's), which the fall-back is not there
    to serve. ``sbj:3.pfv`` stays all grammatical."""
    known = GLOSS_ABBREVIATIONS if known is None else frozenset(known)
    return _lenient_flags(morphemes, _strict_flags(morphemes, known), known)


def is_lexical_part(part, known: Optional[Iterable[str]] = None) -> bool:
    """Whether one part, read on its own, is a lexical gloss (``isLexicalPart``)."""
    return lexical_flags([[part if isinstance(part, str) else '']], known)[0][0]


def gloss_morphemes(value) -> List[List[str]]:
    """A gloss value cut into morphemes, each a list of its parts, empty parts
    left out (``glossMorphemes``)."""
    out = []
    for morpheme in MORPHEME_CUT.split(str(value if value is not None else '')):
        parts = [p for p in PART_CUT.split(morpheme) if p]
        if parts:
            out.append(parts)
    return out


__all__ = ['ZERO_MORPH', 'is_zero_morph', 'is_clitic', 'is_bound_type', 'GLOSS_ABBREVIATIONS',
           'PERSON_NUMBER', 'MORPHEME_CUT', 'PART_CUT', 'lexical_flags', 'lenient_flags',
           'is_lexical_part', 'gloss_morphemes']
