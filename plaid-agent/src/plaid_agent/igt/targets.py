"""What a job fills, and THE rule for what is empty (the owner's steer of
2026-11-15: any word-, morpheme- or sentence-level annotation, never one task
with the rest as exceptions).

A job's plan names its TARGETS (plan_work's ``fills``): segmentation into
morphemes, and any of the project's annotation fields at word, morpheme or
sentence level, each read from the project's configuration and named by the
field's display name, never guessed from it. The plan keeps a target by its
id: ``segmentation``, or the field's layer id.

A unit is EMPTY for a target when it holds no value for it (:func:`empty`):

- a word, for segmentation, when it holds no morpheme of its own
  (:func:`unsegmented`: none stored, or one that holds no form, no type, no
  value and no link, the keep rule's :func:`holds_nothing`),
- a word, for a word field, when the field holds no value on it,
- a word, for an orthography (a second writing of the word, such as IPA),
  when it holds no value in it,
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
#: How an orthography's target id begins.
ORTHOGRAPHY = 'orthography'
#: How a level is named to the model.
LEVEL = {'Word': 'word', 'Morpheme': 'morpheme', 'Sentence': 'sentence'}


@dataclass(frozen=True)
class Target:
    """One thing a job fills: ``id`` as the plan keeps it, ``name`` as the
    model reads it, ``scope`` the level of its units (segmentation's units
    are words), ``field`` (None for segmentation) and whether it is linked
    to the lexicon (``lexicon``: segmentation, whose morphemes link to
    entries, or a field the configuration pairs with a lexicon entry field,
    ``igt.lexiconField``). An orthography of the project is a word level
    target too (``orthography`` its name, ``field`` None)."""
    id: str
    name: str
    scope: str
    field: Optional[Field] = None
    lexicon: bool = False
    orthography: Optional[str] = None

    @property
    def segments(self) -> bool:
        """Whether the target is segmentation into morphemes."""
        return self.id == SEGMENTATION

    @property
    def label(self) -> str:
        """The target as the planning message lists it."""
        return self.labelled('"')

    def labelled(self, quote: str = '') -> str:
        """The target with its level, its name in ``quote``: ``"Case" (word
        level)``, ``IPA (orthography, word level)``."""
        if self.segments:
            return f'{SEGMENTATION} (word level: words into morphemes)'
        if self.orthography is not None:
            return f'{quote}{self.name}{quote} (orthography, word level)'
        return f'{quote}{self.name}{quote} ({LEVEL[self.scope]} level)'


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
    then the fields by level, word, morpheme and sentence, then the
    orthographies (word level, kept as ``orthography:<name>``)."""
    out = []
    if project.morpheme_layer_id:
        out.append(Target(SEGMENTATION, SEGMENTATION, 'Word', None, bool(project.vocabs)))
    for scope in SCOPES:
        out += [_target(project, f) for f in project.fields_by_scope(scope)]
    return out + [Target(f'{ORTHOGRAPHY}:{o}', o, 'Word', orthography=o) for o in project.orthographies]


def of_ids(project: IgtProject, ids: Optional[Iterable[str]]) -> List[Target]:
    """The targets a plan keeps (``fills``), in its order; an id the project
    no longer has (a field deleted since) is left out."""
    by = {t.id: t for t in fillable(project)}
    return [by[i] for i in ids or () if i in by]


def _keys(t: Target) -> Tuple[List[str], List[str]]:
    """Every way a planner may name ``t``, quotes and case aside: its name
    and label, for a field its name with its level, and for an orthography
    "<name> (orthography)", never a field's "(word level)" (REV-DF3-3: a
    word field sharing an orthography's name is named by its label); then,
    looked up only when nothing else answers to it, segmentation with a
    level (a field named "Segmentation" owns "Segmentation (word level)")."""
    first = [t.name, t.label]
    later = [f'{t.name} ({LEVEL[t.scope]})', f'{t.name} ({LEVEL[t.scope]} level)']
    if t.orthography is not None:
        first, later = first + [f'{t.name} (orthography)'], []
    if not t.segments:
        first, later = first + later, []
    fold = lambda ks: list(dict.fromkeys(k.replace('"', '').casefold() for k in ks))  # noqa: E731
    return fold(first), fold(later)


def named(project: IgtProject, names: Iterable[str]) -> Tuple[List[Target], List[str]]:
    """``(targets, unknown names)`` for the names a planner gives: each a
    target's name as the planning message lists it, case aside, with or
    without its quotes and its level. A name two targets answer to (a field
    named "Segmentation", an orthography named as a field) names neither:
    only each one's label does (REV-DF-D-21)."""
    first: Dict[str, List[Target]] = {}
    later: Dict[str, List[Target]] = {}
    for t in fillable(project):
        a, b = _keys(t)
        for k in a:
            first.setdefault(k, []).append(t)
        for k in b:
            later.setdefault(k, []).append(t)
    out, unknown = [], []
    for name in names:
        key = str(name).strip().replace('"', '').casefold()
        hit = first.get(key) or later.get(key) or []
        if len(hit) != 1:
            unknown.append(str(name))
        elif hit[0] not in out:
            out.append(hit[0])
    return out, unknown


def shown_names(project: IgtProject, targets: Iterable[Target]) -> List[str]:
    """Each of ``targets`` as a person and a model are told it: its name, or,
    where two targets of ``project`` share that name (a word field and an
    orthography both "IPA"), its label without quotes, "IPA (word level)",
    which :func:`named` reads back. THE rule for every list that names
    targets: a refusal's, the job card's, the setup line's (REV-SU-B-2)."""
    seen: Dict[str, int] = {}
    for t in fillable(project):
        seen[t.name.casefold()] = seen.get(t.name.casefold(), 0) + 1
    return [t.name if seen.get(t.name.casefold(), 0) <= 1 else t.labelled() for t in targets]


def listed_names(project: IgtProject) -> List[str]:
    """Every target of ``project`` as a refusal names it (:func:`shown_names`)."""
    return shown_names(project, fillable(project))


def resolve_fills(project: IgtProject, fills) -> List[Target]:
    """The targets ``fills`` names (plan_work's and propose_job's), or a
    ToolError naming what a job on ``project`` can fill. Required: a list,
    [] for a job that fills nothing (REV-DF-D-1: one left out made a job
    that filled nothing and said nothing). A list of one comma string is
    read as the string is (``core.args.names_list``)."""
    import json
    from ..core.args import names_list
    from ..core.tools import ToolError
    listed = listed_names(project)
    if fills is None:
        raise ToolError('fills: say what the job fills, each named as listed under What a job can fill: '
                        + ', '.join(listed) + '. Give [] when it fills nothing, such as a check or a summary.',
                        kind='invalid-argument')
    fills = names_list(fills, lambda n: not named(project, [n])[1])
    if fills is None:
        raise ToolError('fills is a list of names, such as ' + json.dumps(listed[:2], ensure_ascii=False)
                        + '. Name each as listed under What a job can fill: ' + ', '.join(listed) + '.',
                        kind='invalid-argument')
    chosen, unknown = named(project, fills)
    if unknown:
        raise ToolError('fills: not something a job on this project can fill: '
                        + ', '.join(f'"{u}"' for u in unknown[:5]) + '. Name each as listed under What a job can '
                        'fill: ' + ', '.join(listed) + '.', kind='invalid-argument')
    return chosen


# --- what a job was set up to fill (BRIEF-SU) ------------------------------------------

@dataclass(frozen=True)
class Setup:
    """What a job was set up to do, from its ``setup`` (``{fills: [{id,
    name}], text, conversation}``, the card the person started): ``targets``
    the targets it names that the project still has, in its order, ``text``
    whether it may edit the text, and ``gone`` the card's fills the project
    no longer has (``{id, name}``, the name the person saw), which the plan
    row keeps (REV-SU-B-3). Compared by id only. ``names`` are the targets as
    :func:`shown_names` tells them."""
    targets: Tuple[Target, ...]
    text: bool
    gone: Tuple[Dict[str, str], ...] = ()
    names: Tuple[str, ...] = ()

    @property
    def ids(self) -> Tuple[str, ...]:
        return tuple(t.id for t in self.targets)

    @property
    def all_gone(self) -> bool:
        """Whether it named targets and the project has none of them now."""
        return bool(self.gone) and not self.targets

    @property
    def line(self) -> str:
        """:func:`setup_line` of the targets the project still has."""
        return setup_line(self.names, self.text)


def setup_of(project: IgtProject, setup) -> Optional[Setup]:
    """The :class:`Setup` of a job's ``setup``, or None for a job with none
    (no limit)."""
    if not isinstance(setup, dict):
        return None
    fills = setup.get('fills')
    fills = [f for f in fills if isinstance(f, dict) and f.get('id')] if isinstance(fills, list) else []
    targets = of_ids(project, [str(f['id']) for f in fills])
    have = {t.id for t in targets}
    gone = tuple({'id': str(f['id']), 'name': str(f.get('name') or f['id'])} for f in fills
                 if str(f['id']) not in have)
    return Setup(tuple(targets), setup.get('text') is True, gone, tuple(shown_names(project, targets)))


def _names(names: Iterable[str], deleted: Iterable[int] = ()) -> str:
    deleted = set(deleted)
    quoted = [f'"{n}"' + (' (deleted)' if i in deleted else '') for i, n in enumerate(names)]
    return quoted[0] if len(quoted) == 1 else ', '.join(quoted[:-1]) + ' and ' + quoted[-1]


def setup_fills(names: List[str], deleted: Iterable[int] = ()) -> str:
    """What a job was set up to fill, as a clause: ``fill only "Case"``,
    ``fill nothing``, those at the places ``deleted`` marked ``"Case"
    (deleted)``."""
    return f'fill only {_names(names, deleted)}' if names else 'fill nothing'


def setup_line(names: List[str], text: bool, deleted: Iterable[int] = ()) -> str:
    """The one fixed line said of a job's setup, ``names`` the targets it
    may fill and ``text`` whether it may edit the text: to the planning
    context (the targets the project still has), in read_job and to the
    final context (the names the person saw on the card, each the plan
    found gone marked, ``deleted`` their places)."""
    return f'This job was set up to {setup_fills(names, deleted)}. ' + ('It may edit the text.' if text
                                                                        else 'It may not edit the text.')


def gone_ids(plan) -> List[str]:
    """The ids of the setup's targets a job's plan row found gone (its
    ``gone``, REV-SU-B-3), or none."""
    gone = plan.get('gone') if isinstance(plan, dict) else None
    return [str(g.get('id')) for g in gone if isinstance(g, dict)] if isinstance(gone, list) else []


def said_setup(setup, gone: Iterable[str] = ()) -> Optional[str]:
    """:func:`setup_line` of a job's ``setup`` as core holds it, by the
    names on the card, each whose id is among ``gone`` (:func:`gone_ids`)
    marked deleted, or None for a job with none."""
    if not isinstance(setup, dict):
        return None
    fills = setup.get('fills') if isinstance(setup.get('fills'), list) else []
    fills = [f for f in fills if isinstance(f, dict) and (f.get('name') or f.get('id'))]
    gone = set(gone)
    return setup_line([str(f.get('name') or f.get('id')) for f in fills], setup.get('text') is True,
                      [i for i, f in enumerate(fills) if str(f.get('id')) in gone])


def gone_text(plan) -> str:
    """The plan row's ``gone`` by the names the person saw: "Animacy, Part
    of Speech"."""
    gone = plan.get('gone') if isinstance(plan, dict) else None
    return ', '.join(str(g.get('name') or g.get('id')) for g in gone if isinstance(g, dict)) \
        if isinstance(gone, list) else ''


def outside_setup(project: IgtProject, setup: Setup, chosen: Iterable[Target], edits_text: bool) -> Optional[str]:
    """plan_work's refusal of a plan that goes past the job's setup: a
    target outside it (by id), or edits_text when the setup keeps the text.
    None when the plan is inside it. Each target named as
    :func:`shown_names` tells it."""
    out = []
    extra = shown_names(project, [t for t in chosen if t.id not in setup.ids])
    if extra:
        out.append(f'fills: this job was set up to {setup_fills(setup.names)}. Leave out {_names(extra)}.')
    if edits_text and not setup.text:
        out.append('edits_text: this job was set up not to edit the text. Give false.')
    return ' '.join(out) or None


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
    and a word field, a morpheme, a sentence) holds no value for ``t``. A
    word is empty for segmentation when it is :func:`unsegmented`: a word
    segmented as one morpheme, its form and no value, is segmented, though
    ``word_state`` reads it unanalyzed (REV-DF3-4)."""
    if t.segments:
        return unsegmented(w)
    if t.orthography is not None:
        return not w.orthographies.get(t.orthography)
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
    for a morpheme, the form as typed (its word's when it has none); a sentence field's unit has ref and
    form ''. An :func:`unsegmented` word is one morpheme for a morpheme
    field, named as the tool that fills it takes it: ``wN`` when the job
    also segments it (the analysis tool takes the word), else ``wN.m1``
    (set_field takes it, REV-DF-D-3). ``words`` (word ids) and ``fields``
    (sentence level targets), when given, are all that may be named (a
    stretch's: what the job wrote is left out)."""
    out = []
    fields = None if fields is None else list(fields)
    segments = [t for t in targets if t.segments]
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
                        # A morpheme stored with no form is named by its word,
                        # as an unsegmented word's is (REV-DF3-8).
                        out.append((f'w{w.index}.m{m.index}', m.form or w.surface, t))
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


def document_fact(doc, project: IgtProject) -> Dict[str, object]:
    """What is said of one document where a job is planned or set up: its
    name, its sentences and words, its length as rendered, and how many units
    are empty for each thing a job on ``project`` can fill (``empty``,
    target id -> count, by :func:`count`)."""
    from .project import render_sentence
    return {'id': doc.id, 'name': doc.name, 'sentences': len(doc.sentences),
            'words': sum(len(s.words) for s in doc.sentences),
            'empty': {t.id: count(doc.sentences, t) for t in fillable(project)},
            'characters': sum(len(render_sentence(s, project)) + 1 for s in doc.sentences)}


def _n(n: int, word: str) -> str:
    return f'{n} {word}{"" if n == 1 else "s"}'


def fill_lines(fill: List[Target], facts: List[Dict[str, object]], tool: str, heading: str,
               setup: Optional[str] = None) -> List[str]:
    """What a job can fill and how much of it is empty in each document, as
    the planning context is shown it and as propose_job's facts answer it
    (one text, BRIEF-SU): ``fill`` the targets listed, ``facts`` each
    document's :func:`document_fact`, ``tool`` the tool whose ``fills``
    names them, ``heading`` the documents' heading before their count, and
    ``setup`` a line said under the list. At most JOB_PLAN_DOCUMENT_LINES
    document lines, each naming at most JOB_PLAN_EMPTY_TARGETS targets."""
    from ..core.limits import JOB_PLAN_DOCUMENT_LINES, JOB_PLAN_EMPTY_TARGETS
    names = {t.id: t.name for t in fill}
    order = {t.id: k for k, t in enumerate(fill)}
    lines = [f'What a job can fill (name them in {tool}\'s fills):', *[f'- {t.label}' for t in fill]]
    if setup:
        lines.append(setup)
    lines += ['', f'{heading} ({len(facts)}):']
    for f in facts[:JOB_PLAN_DOCUMENT_LINES]:
        # Only the targets with something empty, the most first (the
        # configuration's order on a tie), at most JOB_PLAN_EMPTY_TARGETS,
        # the rest counted: a project with many fields keeps short lines.
        some = sorted(((i, n) for i, n in (f.get('empty') or {}).items() if i in names and n),
                      key=lambda x: (-x[1], order[x[0]]))
        empties = ', '.join(f'{names[i]} {n:,}' for i, n in some[:JOB_PLAN_EMPTY_TARGETS])
        if len(some) > JOB_PLAN_EMPTY_TARGETS:
            empties += f', and {len(some) - JOB_PLAN_EMPTY_TARGETS} more'
        said = f' Empty: {empties}.' if empties else (' Nothing empty.' if fill else '')
        lines.append(f'- "{f["name"]}": {_n(f["sentences"], "sentence")}, {_n(f["words"], "word")}, '
                     f'{f["characters"]:,} characters.{said}')
    if len(facts) > JOB_PLAN_DOCUMENT_LINES:
        lines.append(f'and {len(facts) - JOB_PLAN_DOCUMENT_LINES} more documents not shown')
    return lines


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
