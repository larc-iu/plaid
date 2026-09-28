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

#: The sentence-level relations whose value is an atom, a number or a string
#: rather than a child node: the ``KNOWN_RELATIONS`` entries of ``inventory.js``
#: whose type is ``attribute``. Every other known relation is a role.
ATTRIBUTE_RELATIONS = frozenset({
    ':aspect', ':century', ':day', ':dayperiod', ':decade', ':degree', ':end-state', ':era',
    ':frequency', ':lat', ':li', ':list-item', ':long', ':mod', ':modal-strength', ':mode',
    ':month', ':op1', ':polarity', ':polite', ':quant', ':quarter', ':refer-definiteness',
    ':refer-number', ':refer-person', ':smood', ':time', ':value', ':wiki', ':x', ':y',
    ':year', ':year2', ':z'})

#: The attributes whose value is a whole number: ``INTEGER_ATTRIBUTES`` in
#: ``inventory.js``. ``:li`` is a list item's place in the list, ``-1`` for the
#: last, as AMR writes it.
INTEGER_ATTRIBUTES = frozenset({':li'})

#: The attributes whose values the validator holds to a closed set:
#: ``ATTRIBUTES[rel].validator`` in ``inventory.js``, the non-empty ones. An
#: attribute not here takes any value.
ATTRIBUTE_VALUES: Dict[str, Tuple[str, ...]] = {
    ':aspect': ('habitual', 'generic', 'imperfective', 'state', 'reversible-state',
                'irreversible-state', 'point-state', 'inherent-state', 'process',
                'atelic-process', 'activity', 'directed-activity', 'undirected-activity',
                'perfective', 'endeavor', 'semelfactive', 'undirected-endeavor',
                'directed-endeavor', 'performance', 'inceptive', 'incremental-accomplishment',
                'nonincremental-accomplishment', 'directed-achievement',
                'reversible-directed-achievement', 'irreversible-directed-achievement'),
    ':modal-strength': ('full-affirmative', 'partial-affirmative', 'neutral-affirmative',
                        'neutral-negative', 'partial-negative', 'full-negative'),
    ':refer-person': ('1st', '2nd', '3rd', '4th', 'non-1st', 'non-3rd'),
    ':refer-number': ('singular', 'non-singular', 'dual', 'trial', 'paucal', 'plural'),
    ':refer-definiteness': ('class',),
}

#: The ``:ARGn`` participant roles, which ``KNOWN_RELATIONS`` lists one by one.
ARG_ROLE = re.compile(r'^:ARG\d+$')

#: The roles that always point at a node: every known relation that is not an
#: attribute, the ``:ARGn`` range left to ``ARG_ROLE``. The app's validator
#: refuses a value under any of them (``validate.js``).
NODE_ROLES = frozenset(r for r in KNOWN_RELATIONS
                       if r not in ATTRIBUTE_RELATIONS and not ARG_ROLE.match(r))

#: The rolesets whose argument really is a value, as the app's validator has
#: them (``validate.js``, after umrtools ``validate.py:1440``).
VALUE_ARGUMENTS = frozenset({('have-polarity-91', ':ARG2'), ('rate-entity-91', ':ARG1'),
                             ('have-quant-91', ':ARG2'),
                             ('have-modal-strength-91', ':ARG2')})


def edge_only(rel: str, concept: str) -> bool:
    """Whether a role only ever points at a node, so a value under it is a
    mistake: an inverse role, an ``:ARGn`` outside the few rolesets that take a
    value there, or any other role the app does not type as an attribute."""
    if rel.endswith('-of'):
        return True
    if ARG_ROLE.match(rel):
        return (concept, rel) not in VALUE_ARGUMENTS
    return rel in NODE_ROLES


def whole_number_problem(rel: str, value) -> Optional[str]:
    """Why ``value`` cannot stand under ``rel``, an attribute that takes a whole
    number (``:li``), or None when it can or ``rel`` takes other values
    (``valueGrammarProblem`` in ``validate.js``)."""
    if rel not in INTEGER_ATTRIBUTES:
        return None
    text = str(value)
    if re.fullmatch(r'-?[0-9]+', text):
        return None
    bare = text.strip('"')
    return (f"The value '{bare}' of '{rel}' is not a whole number. '{rel}' "
            "takes the item's place in the list, -1 for the last.")


def attribute_value_problem(rel: str, value) -> Optional[str]:
    """Why ``value`` cannot be written as the value of the attribute ``rel`` on
    a node, or None when it can: the relation is not an attribute, the value is
    empty or holds a space, or it is outside the attribute's closed set
    (``validate.js`` reports each as ``unexpected-value``)."""
    rel = _as_relation(rel)
    if rel not in ATTRIBUTE_RELATIONS and not _OP.match(rel):
        return (f'{rel} is a relation to another node, not an attribute: its value would '
                'have to be a node.')
    text = value if isinstance(value, str) else ''
    if not text.strip() or re.search(r'\s', text):
        return f'{rel} needs a value of one word, not {value!r}.'
    whole = whole_number_problem(rel, text)
    if whole:
        return whole
    closed = ATTRIBUTE_VALUES.get(rel)
    if closed and text not in closed:
        guess = difflib.get_close_matches(text, closed, n=1, cutoff=0.7)
        hint = f' Did you mean {guess[0]}?' if guess else ''
        return f'{text!r} is not a value of {rel}. Its values are {", ".join(closed)}.{hint}'
    return None


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


__all__ = ['KNOWN_RELATIONS', 'ATTRIBUTE_RELATIONS', 'ATTRIBUTE_VALUES', 'NODE_ROLES',
           'INTEGER_ATTRIBUTES', 'VALUE_ARGUMENTS', 'ARG_ROLE', 'DOC_RELATIONS',
           'DOC_CONSTANTS', 'GROUPS', 'edge_only', 'whole_number_problem',
           'attribute_value_problem', 'is_known_relation', 'nearest',
           'unknown_relation_problem', 'unknown_doc_relation_problem']
