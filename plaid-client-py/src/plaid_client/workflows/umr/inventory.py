"""The closed relation sets of UMR, and why a relation is not in them.

The Python side of ``plaid-umr/src/domain/format/inventory.js`` (the
``validator`` sets, the ones umrtools ``validate.py`` enforces) and of the two
checks ``validate.js`` builds on them, ``unknownRelationProblem`` and
``unknownDocRelationProblem``. The app refuses a relation outside these sets on
every editor path, and whatever writes UMR from Python refuses the same.

The sets are copied, not read, because this package cannot reach plaid-umr's
source once installed. ``plaid-agent/tests/test_umr_inventory_mirror.py`` runs
``inventory.js`` and fails when the two differ, so a relation added there is a
failing test here rather than a silent drift.
"""

import difflib
import re
from typing import Dict, Optional, Tuple

#: Every sentence-level relation the validator knows, participant, modifier or
#: attribute: ``KNOWN_RELATIONS`` in ``inventory.js``. An inverse (``-of``) and a
#: numbered ``:opN`` are read as their base.
KNOWN_RELATIONS = frozenset({
    ':ARG0', ':ARG1', ':ARG10', ':ARG11', ':ARG2', ':ARG3', ':ARG4', ':ARG5', ':ARG6',
    ':ARG7', ':ARG8', ':ARG9', ':FR', ':according-to', ':actor', ':affectee', ':age',
    ':anchor', ':apprehensive', ':aspect', ':axis', ':beneficiary', ':calendar', ':cause',
    ':causer', ':century', ':clausal-marker', ':co-actor', ':color', ':companion',
    ':compared-to', ':comparison', ':conceiver', ':concession', ':concessive-condition',
    ':concessive-conditional', ':condition', ':configuration', ':conj-as-if', ':consist',
    ':content', ':contrast', ':day', ':dayperiod', ':decade', ':degree', ':destination',
    ':direction', ':domain', ':duration', ':effect', ':end-state', ':era', ':example',
    ':experiencer', ':extent', ':force', ':framework', ':frequency', ':goal', ':group',
    ':instrument', ':interjection', ':lat', ':level', ':li', ':list-item', ':long',
    ':manner', ':material', ':medium', ':mod', ':modal-predicate', ':modal-strength',
    ':mode', ':month', ':name', ':op1', ':ord', ':ordinal-entity', ':orientation',
    ':other-role', ':parenthesis', ':part', ':part-of-phraseme', ':path', ':perspective',
    ':place', ':polarity', ':polite', ':possessor', ':predicative-noun', ':prep-against',
    ':prep-as', ':prep-by', ':prep-for', ':prep-from', ':prep-in', ':prep-on',
    ':prep-on-behalf', ':prep-to', ':prep-under', ':prep-with', ':prep-without',
    ':pure-addition', ':purpose', ':quant', ':quarter', ':quote', ':range', ':range-start',
    ':range-trajectory', ':ratio', ':reason', ':recipient', ':refer-definiteness',
    ':refer-number', ':refer-person', ':regard', ':result', ':rise-axis', ':run-axis',
    ':scale', ':scope', ':season', ':sentence1', ':sentence2', ':sentence3', ':size',
    ':smood', ':snt1', ':snt2', ':source', ':start', ':stimulus', ':subevent', ':subset',
    ':substitute', ':subtraction', ':temporal', ':theme', ':time', ':timezone', ':topic',
    ':undergoer', ':unit', ':value', ':vocative', ':weekday', ':wiki', ':x', ':y', ':year',
    ':year2', ':z'})

#: The document-level relations by group: ``DOC_RELATIONS[group].validator`` in
#: ``inventory.js``. ``:contains`` is in two groups.
DOC_RELATIONS: Dict[str, Tuple[str, ...]] = {
    'temporal': (':contained', ':contains', ':before', ':after', ':overlap', ':depends-on'),
    'modal': (':modal', ':full-affirmative', ':partial-affirmative',
              ':strong-partial-affirmative', ':weak-partial-affirmative',
              ':neutral-affirmative', ':strong-neutral-affirmative',
              ':weak-neutral-affirmative', ':full-negative', ':partial-negative',
              ':strong-partial-negative', ':weak-partial-negative', ':neutral-negative',
              ':strong-neutral-negative', ':weak-neutral-negative', ':unspecified'),
    'coref': (':same-entity', ':same-event', ':subset-of', ':contains', ':subset'),
}

#: The nodes of a document-level relation that are not sentence variables
#: (``DOC_CONSTANTS`` in ``inventory.js``).
DOC_CONSTANTS = ('root', 'author', 'null-conceiver', 'have-condition-91',
                 'document-creation-time', 'past-reference', 'present-reference',
                 'future-reference')

#: The groups a document-level relation falls in.
GROUPS = tuple(DOC_RELATIONS)

_OP = re.compile(r'^:op[1-9][0-9]*$')


def _as_relation(relation) -> str:
    text = str(relation if relation is not None else '').strip()
    return text if text.startswith(':') else f':{text}'


def is_known_relation(relation) -> bool:
    """Whether ``relation`` is a sentence-level UMR relation, an inverse or a
    numbered ``:opN`` read as its base (``knownRelation`` in ``validate.js``)."""
    base = re.sub(r'-of$', '', _as_relation(relation))
    return base in KNOWN_RELATIONS or bool(_OP.match(base))


def _squash(name: str) -> str:
    return name.lower().replace('-', '').replace('_', '')


def nearest(relation, names) -> Optional[str]:
    """The one of ``names`` a mistyped ``relation`` most likely meant, or None:
    a name it abbreviates (``:poss`` for ``:possessor``), else the closest
    spelling. Case and hyphens are ignored (``:FullAff``)."""
    names = sorted(set(names))
    want = _squash(_as_relation(relation))
    if len(want) > 3:
        starts = [n for n in names if _squash(n).startswith(want)]
        if starts:
            return min(starts, key=len)
    by_squashed = {_squash(n): n for n in names}
    close = difflib.get_close_matches(want, list(by_squashed), n=1, cutoff=0.7)
    return by_squashed[close[0]] if close else None


def unknown_relation_problem(relation) -> Optional[str]:
    """Why ``relation`` is not a sentence-level UMR relation, or None when it
    is. Worded for someone who can retype it: the likeliest intended relation
    is named where there is one."""
    rel = _as_relation(relation)
    if is_known_relation(rel):
        return None
    inverse = rel.endswith('-of')
    guess = nearest(rel[:-3] if inverse else rel, KNOWN_RELATIONS)
    if guess and inverse:
        guess += '-of'
    hint = f' Did you mean {guess}?' if guess else ''
    return f'Unknown relation \'{rel}\': UMR has no such relation.{hint}'


def unknown_doc_relation_problem(group: Optional[str], relation) -> Optional[str]:
    """Why ``relation`` is not one of the document-level ``group``'s relations,
    or None when it is. With no group, why it is in none of them. Names the
    relation's own group when it has one, and otherwise the likeliest
    relation."""
    rel = _as_relation(relation)
    every = [r for g in GROUPS for r in DOC_RELATIONS[g]]
    if not group:
        if rel in every:
            return None
        guess = nearest(rel, every)
        hint = f' Did you mean {guess}?' if guess else ''
        return (f'Unknown document-level relation \'{rel}\'. '
                + ' '.join(f'The {g} relations are {", ".join(DOC_RELATIONS[g])}.'
                           for g in GROUPS) + hint)
    known = DOC_RELATIONS.get(group, ())
    if rel in known:
        return None
    others = [g for g in GROUPS if g != group and rel in DOC_RELATIONS[g]]
    if others:
        return (f'\'{rel}\' is a {others[0]} relation, not a {group} one. Leave the group out, '
                f'or give group "{others[0]}".')
    guess = nearest(rel, known) or nearest(rel, every)
    hint = f' Did you mean {guess}?' if guess else ''
    return (f'Unknown document-level {group} relation \'{rel}\'. The {group} relations are '
            + ', '.join(known) + '.' + hint)


__all__ = ['KNOWN_RELATIONS', 'DOC_RELATIONS', 'DOC_CONSTANTS', 'GROUPS',
           'is_known_relation', 'nearest', 'unknown_relation_problem',
           'unknown_doc_relation_problem']
