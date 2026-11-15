"""What a job fills, and THE rule for what is empty (the owner's steer of
2026-11-15: any word-, morpheme- or sentence-level annotation, never one task
with the rest as exceptions).

A job's plan names its TARGETS (plan_work's ``fills``): segmentation into
morphemes, and any of the project's annotation fields at word, morpheme or
sentence level, each read from the project's configuration and named by the
field's display name, never guessed from it. The plan keeps a target by its
id: ``segmentation``, or the field's layer id.

A unit is EMPTY for a target when it holds no value for it (:func:`empty`):

- a word, for segmentation, when it holds no morpheme analysis (its stored
  state is "unanalyzed": ``plaid_client.workflows.igt.derive.word_state``),
- a word, for a word field, when the field holds no value on it,
- a morpheme, for a morpheme field, when the field holds no value on it (an
  unsegmented word's derived morpheme is a morpheme here),
- a sentence, for a sentence field, when the field holds no value on it.

There is no other notion of "analysed" or "blank": the walk, the planner's
counts, what a piece is told is empty, the evidence, Left blank and not
reached all ask this module.
"""

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple

from plaid_client.workflows.igt.derive import word_state as _stored_word_state

from .project import SCOPES, Field, IgtProject, Morpheme, Sentence, Word

SEGMENTATION = 'segmentation'
#: How a level is named to the model.
LEVEL = {'Word': 'word', 'Morpheme': 'morpheme', 'Sentence': 'sentence'}


@dataclass(frozen=True)
class Target:
    """One thing a job fills: ``id`` as the plan keeps it, ``name`` as the
    model reads it, ``scope`` the level of its units (segmentation's units
    are words), ``field`` (None for segmentation) and whether it is linked
    to the lexicon (``lexicon``: segmentation, whose morphemes link to
    entries, or a field the configuration pairs with a lexicon entry field,
    ``igt.lexiconField``)."""
    id: str
    name: str
    scope: str
    field: Optional[Field] = None
    lexicon: bool = False

    @property
    def label(self) -> str:
        """The target as the planning message lists it."""
        if self.field is None:
            return f'{SEGMENTATION} (word level: words into morphemes)'
        return f'"{self.name}" ({LEVEL[self.scope]} level)'


#: Segmentation as a target, whatever the project: what :func:`empty` asks of
#: a word the job analysed (``Written``).
SEGMENTED = Target(SEGMENTATION, SEGMENTATION, 'Word')


def word_state(w: Word) -> str:
    """``plaid_client.workflows.igt.derive.word_state`` of a parsed word: the
    one rule every machine writer of igt holds a word to."""
    morphs = [m for m in w.morphemes if not m.virtual]
    return _stored_word_state({
        'surface': w.surface,
        'morphs': [{'id': m.id, 'metadata': m.metadata} for m in morphs],
        'morph_spans': {m.id: [(n, {'metadata': sp.metadata}) for n, sp in m.fields.items()] for m in morphs},
        'morph_links': {m.id: [{'metadata': m.link.metadata}] for m in morphs if m.link is not None},
    })


def _target(project: IgtProject, f: Field) -> Target:
    return Target(f.layer_id, f.name, f.scope, f, bool(f.lexicon_field) and bool(project.vocabs))


def fillable(project: IgtProject) -> List[Target]:
    """Everything a job on ``project`` can fill, in the order the planning
    message lists it: segmentation (when the project has a morpheme layer),
    then the fields by level, word, morpheme and sentence."""
    out = []
    if project.morpheme_layer_id:
        out.append(Target(SEGMENTATION, SEGMENTATION, 'Word', None, bool(project.vocabs)))
    for scope in SCOPES:
        out += [_target(project, f) for f in project.fields_by_scope(scope)]
    return out


def of_ids(project: IgtProject, ids: Optional[Iterable[str]]) -> List[Target]:
    """The targets a plan keeps (``fills``), in its order; an id the project
    no longer has (a field deleted since) is left out."""
    by = {t.id: t for t in fillable(project)}
    return [by[i] for i in ids or () if i in by]


def named(project: IgtProject, names: Iterable[str]) -> Tuple[List[Target], List[str]]:
    """``(targets, unknown names)`` for the names a planner gives: each a
    target's name as the planning message lists it, case aside, with or
    without its quotes and its level."""
    by: Dict[str, Target] = {}
    for t in fillable(project):
        by.setdefault(t.name.casefold(), t)
        by.setdefault(f'{t.name} ({LEVEL[t.scope]})'.casefold(), t)
        by.setdefault(f'{t.name} ({LEVEL[t.scope]} level)'.casefold(), t)
    out, unknown = [], []
    for name in names:
        key = str(name).strip().replace('"', '').casefold()
        t = by.get(key)
        if t is None:
            unknown.append(str(name))
        elif t not in out:
            out.append(t)
    return out, unknown


def app_default(project: IgtProject) -> List[Target]:
    """What a job fills when its plan names nothing (planning failed): the
    app's configured default, segmentation (when there is a morpheme layer),
    the morpheme field ``gloss_field("Morpheme")`` names and the sentence
    field ``gloss_field("Sentence")`` names (read from the configuration:
    the field paired with the lexicon's gloss role, the field whose sentence
    role is translation, else each level's first)."""
    out = [t for t in fillable(project) if t.id == SEGMENTATION]
    for scope in ('Morpheme', 'Sentence'):
        f = project.gloss_field(scope)
        if f is not None:
            out.append(_target(project, f))
    return out


def holds_nothing(metadata: Optional[dict], values, link) -> bool:
    """A stored morpheme with no form, no type, no value and no link of its
    own (``metadata`` as stored, ``values`` its span values): the editor's
    default before 2026-09-11, every field of it derivable from the word.
    The keep rule (``tools.in_place``) keeps no word whose one morpheme is
    such, so an analysis given to its word is written whole, form included,
    as for a word with no morpheme stored (FX), and :func:`unsegmented`
    counts such a word as one with no morpheme of its own."""
    md = metadata or {}
    return (md.get('form') in (None, '') and not md.get('morphType') and not link
            and all(v in (None, '') for v in values))


def unsegmented(w: Word) -> bool:
    """Whether ``w`` has no morpheme of its own: none stored (it has its
    derived one), or one stored that holds nothing (:func:`holds_nothing`).
    Either is ONE unit for a morpheme field (:func:`units`): a storage
    detail the model cannot see never splits a word in two (REV-DF-D-4)."""
    stored = [m for m in w.morphemes if not m.virtual]
    return not stored or (len(stored) == 1 and holds_nothing(
        stored[0].metadata, [sp.value for sp in stored[0].fields.values()], stored[0].link))


def _holds(holder, f: Field) -> bool:
    sp = holder.fields.get(f.name) if holder is not None else None
    return sp is not None and sp.value not in (None, '')


def empty(t: Target, s: Optional[Sentence] = None, w: Optional[Word] = None,
          m: Optional[Morpheme] = None) -> bool:
    """THE rule: whether the unit of ``t``'s level (a word for segmentation
    and a word field, a morpheme, a sentence) holds no value for ``t``."""
    if t.field is None:
        return word_state(w) == 'unanalyzed'
    return not _holds(m if t.scope == 'Morpheme' else w if t.scope == 'Word' else s, t.field)


def word_level(targets: Iterable[Target]) -> List[Target]:
    return [t for t in targets if t.scope in ('Word', 'Morpheme')]


def sentence_level(targets: Iterable[Target]) -> List[Target]:
    return [t for t in targets if t.scope == 'Sentence']


def empty_in_word(w: Word, targets: Iterable[Target]) -> List[Target]:
    """The word- and morpheme-level targets for which ``w`` is empty, or
    holds a morpheme that is."""
    out = []
    for t in word_level(targets):
        if t.scope == 'Morpheme':
            if any(empty(t, m=m) for m in w.morphemes):
                out.append(t)
        elif empty(t, w=w):
            out.append(t)
    return out


def empty_in_sentence(s: Sentence, targets: Iterable[Target]) -> List[Target]:
    """The sentence-level targets for which ``s`` is empty."""
    return [t for t in sentence_level(targets) if empty(t, s=s)]


def units(s: Sentence, targets: Iterable[Target], words: Optional[set] = None,
          fields: Optional[Iterable[Target]] = None) -> List[Tuple[str, str, Target]]:
    """Every unit of ``s`` empty for a target, ``(ref, form, target)`` in the
    order of the targets and then of the text: ``wN`` for a word, ``wN.mK``
    for a morpheme, the form as typed; a sentence field's unit has ref and
    form ''. An :func:`unsegmented` word is one morpheme for a morpheme
    field, named as the tool that fills it takes it: ``wN`` when the job
    also segments it (the analysis tool takes the word), else ``wN.m1``
    (set_field takes it, REV-DF-D-3). ``words`` (word ids) and ``fields``
    (sentence level targets), when given, are all that may be named (a
    stretch's: what the job wrote is left out)."""
    out = []
    fields = None if fields is None else list(fields)
    segments = [t for t in targets if t.field is None]
    for t in targets:
        if t.scope == 'Sentence':
            if empty(t, s=s) and (fields is None or t in fields):
                out.append(('', '', t))
            continue
        for w in s.words:
            if words is not None and w.id not in words:
                continue
            if t.scope == 'Morpheme' and unsegmented(w):
                if empty(t, m=w.morphemes[0]):
                    whole = any(empty(x, w=w) for x in segments)
                    out.append((f'w{w.index}' if whole else f'w{w.index}.m1', w.surface, t))
            elif t.scope == 'Morpheme':
                for m in w.morphemes:
                    if empty(t, m=m):
                        out.append((f'w{w.index}.m{m.index}', m.form, t))
            elif empty(t, w=w):
                out.append((f'w{w.index}', w.surface, t))
    return out


def count(sentences: Iterable[Sentence], t: Target) -> int:
    """How many units of ``sentences`` are empty for ``t``."""
    n = 0
    for s in sentences:
        if t.scope == 'Sentence':
            n += empty(t, s=s)
        else:
            for w in s.words:
                n += sum(1 for m in w.morphemes if empty(t, m=m)) if t.scope == 'Morpheme' else empty(t, w=w)
    return n


def empty_line(s: Sentence, targets: List[Target], words: Optional[set] = None,
               fields: Optional[Iterable[Target]] = None) -> Optional[str]:
    """What a piece is told is empty in ``s`` of what the job fills, or None
    when nothing is: ``Empty in s2: segmentation and Morph Gloss in w1 "ka",
    w3 "ta" | Morph Gloss in w2.m2 "di" | Translation.`` Units empty for the
    same targets are named together."""
    groups: Dict[Tuple[str, ...], List[str]] = {}
    by_unit: Dict[str, List[str]] = {}
    shown: Dict[str, str] = {}
    sentence_names = []
    for ref, form, t in units(s, targets, words, fields):
        if t.scope == 'Sentence':
            sentence_names.append(t.name)
            continue
        by_unit.setdefault(ref, []).append(t.name)
        shown[ref] = f'{ref} "{form}"'
    for ref, names in by_unit.items():
        groups.setdefault(tuple(names), []).append(shown[ref])
    parts = [f'{" and ".join(names)} in {", ".join(refs)}' for names, refs in groups.items()] + sentence_names
    if not parts:
        return None
    return f'Empty in s{s.index}: ' + ' | '.join(parts) + '.'
