"""Tagsets: the controlled value lists an IGT project holds its fields to.

Reads the configuration the editor reads (plaid-igt ``domain/tagsets.js``
and ``domain/vocabFields.js``), so a service or an assistant can see which
values a field is held to and show them to whatever proposes annotations.

Nothing here enforces anything. The app marks a value its tagset refuses
and a person decides what to do with it, and core refuses an off-list value
only in a field whose tagset is closed (:func:`field_constraints`). A machine that
writes an off-list value is telling the linguist something (the list is
incomplete, or the model is wrong), so never snap output to the nearest
listed value: show the list BEFORE asking for output, and write what
comes back.

Shapes, on a project's or a vocabulary's ``config``::

    config.igt.tagsets = {name: {delimiters, mode, values: [{value, description?, ...}]}}
    spanLayer.config.igt.tagset = name                 # an annotation field
    config.igt.documentMetadata = [{name, tagset?}]    # a document metadata field
    vocab.config.igt.fields = {name: {tagset?, ...}}   # a lexicon entry field

A tagset's ``mode`` is one of three, from advice to rule:

    suggest  the list is offered, and any value is accepted
    closed   only listed values are accepted
    mixed    listed values, plus lexical glosses: a part with a lowercase
             letter, or with letters but no capital (a stem gloss in a
             script without case), read with the rest of its value as
             :mod:`glossing` has it
"""

from typing import Dict, Iterator, List, Optional

from ...constraints import _JS_SPACE
from .config import read_igt, read_scope, read_vocab_fields
from .glossing import can_name_word, is_bound_type, lexical_flags_of

SUGGEST, CLOSED, MIXED = 'suggest', 'closed', 'mixed'
MODES = (SUGGEST, CLOSED, MIXED)


def _str(v) -> str:
    return v if isinstance(v, str) else ''


def trim(s: str) -> str:
    """``s`` less the whitespace at its two ends, as the app trims it
    (JavaScript's ``trim``). Python's ``str.strip`` also strips NEL and the
    four information separators, which the app keeps, and keeps the byte
    order mark, which the app strips."""
    return s.strip(_JS_SPACE)


def strip_space(s: str) -> str:
    """``s`` with all its whitespace taken out, as the app takes it out of a
    tagset's delimiters (``stripSpace``), whitespace as :func:`trim` reads it."""
    return s.translate(_NO_SPACE)


_NO_SPACE = dict.fromkeys(map(ord, _JS_SPACE))


def normalize_tagset(raw, name: Optional[str] = None) -> dict:
    """One tagset as ``{name, delimiters, mode, values}``, plus ``ordered:
    True`` when it is stored so. Whitespace (:func:`trim`) is never
    a delimiter, an unknown mode reads as ``suggest``, and a value record must
    carry a non-empty string ``value`` (the first record wins a duplicate).
    Every other key a record carries is kept, ``description`` being the one
    the app shows."""
    raw = raw if isinstance(raw, dict) else {}
    values: List[dict] = []
    seen = set()
    for rec in raw.get('values') or []:
        if not isinstance(rec, dict):
            continue
        value = trim(_str(rec.get('value')))
        if not value or value in seen:
            continue
        seen.add(value)
        values.append({**rec, 'value': value})
    mode = raw.get('mode')
    return {
        'name': name,
        'delimiters': strip_space(_str(raw.get('delimiters'))),
        'mode': mode if mode in MODES else SUGGEST,
        'values': values,
        # Values listed in the stored order rather than sorted (the Status
        # tagset's draft, reviewed, published), kept through every save.
        **({'ordered': True} if raw.get('ordered') is True else {}),
    }


def read_tagsets(config) -> Dict[str, dict]:
    """A project's (or a vocabulary's) tagsets by name, normalized."""
    raw = read_igt(config, 'tagsets')
    out: Dict[str, dict] = {}
    if isinstance(raw, dict):
        for name, t in raw.items():
            key = trim(_str(name))
            if key:
                out[key] = normalize_tagset(t, key)
    return out


def read_tagset_name(layer_config) -> Optional[str]:
    """The tagset name a field's span layer references, or None."""
    return trim(_str(read_igt(layer_config, 'tagset'))) or None


def resolve_tagset(layer_config, config) -> Optional[dict]:
    """The tagset governing a field, or None: the field references none, or
    a name the project no longer has. A dangling reference governs nothing,
    so it never behaves like a closed, empty list."""
    name = read_tagset_name(layer_config)
    return read_tagsets(config).get(name) if name else None


def field_constraints(layer_config, config) -> List[dict]:
    """The layer rules IGT declares on a field's span layer under the project
    ``config`` (plaid-igt ``fieldConstraints`` in ``domain/igtConstraints.js``):
    one span per token, and when the field's tagset is closed, a value made
    only of listed tags. Core holds them and refuses a write that breaks one.
    A ``mixed`` tagset's lexical parts are a Leipzig reading core does not
    hold, and an open one enforces nothing, so neither declares a value set."""
    rules: List[dict] = [{'type': 'single-span'}]
    t = resolve_tagset(layer_config, config)
    if t and t['mode'] == CLOSED:
        rules.append({'type': 'value-set', 'values': [v['value'] for v in t['values']],
                      'delimiters': t['delimiters'], 'parts': 'all'})
    return rules


def _span_layers(project) -> Iterator[dict]:
    for tl in project.get('text_layers') or []:
        for tk in tl.get('token_layers') or []:
            for sl in tk.get('span_layers') or []:
                yield sl


def tagset_for(project, span_layer_id) -> Optional[dict]:
    """The tagset governing an annotation field, by the field's span layer
    id, in a project as ``client.projects.get`` returns it."""
    for sl in _span_layers(project):
        if sl.get('id') == span_layer_id:
            return resolve_tagset(sl.get('config'), project.get('config'))
    return None


def vocab_tagset_for(vocab_layer, field_name) -> Optional[dict]:
    """The tagset governing a lexicon entry field, in a vocab layer as
    ``client.vocab_layers.get`` (or a project's ``vocabs`` entry) returns
    it. A vocabulary keeps its own tagsets because it is shared across
    projects, so a project tagset of the same name is never the answer."""
    fields = read_vocab_fields(vocab_layer.get('config'))
    f = fields.get(field_name) if isinstance(fields, dict) else None
    name = trim(_str(f.get('tagset'))) if isinstance(f, dict) else ''
    return read_tagsets(vocab_layer.get('config')).get(name) if name else None


def governed_fields(project) -> List[dict]:
    """Every field of a project a tagset governs, annotation fields and
    document metadata fields alike, as ``{kind, name, scope, layer_id,
    tagset}``: ``kind`` is ``span`` (``scope`` Word, Morpheme or Sentence,
    ``layer_id`` set) or ``metadata`` (``scope`` document, no layer)."""
    tagsets = read_tagsets(project.get('config'))
    out: List[dict] = []
    for sl in _span_layers(project):
        name = read_tagset_name(sl.get('config'))
        t = tagsets.get(name) if name else None
        if t:
            out.append({'kind': 'span', 'name': sl.get('name'), 'scope': read_scope(sl.get('config')),
                        'layer_id': sl.get('id'), 'tagset': t})
    for m in read_igt(project.get('config'), 'documentMetadata') or []:
        if not isinstance(m, dict) or not m.get('name'):
            continue
        name = trim(_str(m.get('tagset')))
        t = tagsets.get(name) if name else None
        if t:
            out.append({'kind': 'metadata', 'name': m['name'], 'scope': 'document', 'layer_id': None, 'tagset': t})
    return out


# --- telling a model (or a person) what a tagset asks --------------------------

def _quoted(chars: str) -> str:
    """The delimiters ``.:>`` as ``'.', ':' or '>'``."""
    qs = [f"'{c}'" for c in chars]
    return qs[0] if len(qs) == 1 else ', '.join(qs[:-1]) + ' or ' + qs[-1]


def mode_rule(tagset) -> str:
    """What the tagset's mode allows, as one or two sentences for a prompt or
    a message."""
    mode = tagset.get('mode')
    if mode == CLOSED:
        rule = 'Only the listed values are accepted.'
    elif mode == MIXED:
        rule = ('A grammatical tag, written in capitals or digits, must be a listed value, and so '
                'must a known abbreviation written in lowercase beside a tag in the same morpheme '
                '(the pfv of sbj:3.pfv). '
                'A lexical gloss, an ordinary word in lowercase or in a script without capitals, may be anything.')
    else:
        rule = 'The listed values are the ones in use, and any other value is also accepted.'
    delims = tagset.get('delimiters') or ''
    if delims:
        rule += f' A composite value joins its parts with {_quoted(delims)}.'
    return rule


def value_lines(tagset, max_values: Optional[int] = None) -> List[str]:
    """The values, one per line, as ``VALUE`` or ``VALUE: description``, at
    most ``max_values`` of them followed by a line counting the rest."""
    vals = tagset.get('values') or []
    shown = vals if max_values is None else vals[:max_values]
    out = []
    for rec in shown:
        d = _str(rec.get('description')).strip()
        out.append(f'{rec["value"]}: {d}' if d else rec['value'])
    if len(shown) < len(vals):
        out.append(f'... and {len(vals) - len(shown)} more')
    return out


# --- checking a value (plaid-igt validateValue) ------------------------------

def tagset_enforces(tagset) -> bool:
    """Whether the tagset refuses a value, or only suggests (``tagsetEnforces``):
    closed and mixed refuse, suggest never does."""
    return bool(tagset) and tagset.get('mode') != SUGGEST


def scan_value(value, delimiters) -> List[tuple]:
    """``value`` cut on any of ``delimiters`` (``scanValue``): ``(text, begin,
    end)`` per segment, offsets in code points, an empty segment kept."""
    s = value if isinstance(value, str) else ''
    delims = set(_str(delimiters))
    if not delims:
        return [(s, 0, len(s))]
    out, begin = [], 0
    for i, ch in enumerate(s):
        if ch in delims:
            out.append((s[begin:i], begin, i))
            begin = i + 1
    out.append((s[begin:], begin, len(s)))
    return out


def gloss_reading_of(morph_type, form=None) -> Optional[dict]:
    """How a gloss known by its morpheme's type and form alone is read
    (``glossReadingOf``): ``{'bound': True, 'beside': []}`` for an affix's, a clitic's or a
    zero morph's, else None, a stem's or a word's gloss read alone. ``form``
    None means the morpheme states none. A lexicon entry's fields are read so
    (``entryTagsetFor``), by the type the entry goes by and its form."""
    if is_bound_type(morph_type) or (isinstance(form, str) and not can_name_word(morph_type, form)):
        return {'bound': True, 'beside': []}
    return None


def morpheme_gloss_reading(morphemes, i: int) -> dict:
    """How the grid reads the gloss of morpheme ``i`` of a word
    (``morphemeGlossReading``): ``morphemes`` in order, each ``{morph_type,
    form, gloss}`` with the type it goes by and its value in the same field.
    A gloss that cannot name its word is read bound, and a stem's is
    read with the glosses of the word's other morphemes that could
    (``beside``)."""
    def names(m):
        return can_name_word(m.get('morph_type'), m.get('form'))
    me = morphemes[i] if 0 <= i < len(morphemes) else None
    if me is None or not names(me):
        return {'bound': True, 'beside': []}
    return {'bound': False,
            'beside': [g for j, m in enumerate(morphemes) if j != i and names(m)
                       for g in [_str(m.get('gloss'))] if trim(g)]}


def refused_parts(value, tagset, reading: Optional[dict] = None) -> List[str]:
    """The parts of ``value`` a tagset refuses, as the app's cells, Details
    page and entry editor refuse them (``validateValue``): an empty part in
    any mode, and under closed or mixed a part the list does not hold, which
    mixed lets through when it reads as lexical (:func:`lexical_flags_of`,
    by ``reading``: :func:`gloss_reading_of` or :func:`morpheme_gloss_reading`).
    A blank value is never refused. Whether to refuse a write over them is
    :func:`tagset_enforces`."""
    if not tagset:
        return []
    s = value if isinstance(value, str) else ''
    if trim(s) == '':
        return []
    parts = scan_value(s, tagset.get('delimiters'))
    reading = reading or {}
    lexical = lexical_flags_of(s, parts, bound=bool(reading.get('bound')), beside=reading.get('beside') or ())
    listed = {v['value'] for v in tagset.get('values') or []}
    mode = tagset.get('mode')
    out = []
    for (text, _b, _e), lex in zip(parts, lexical):
        part = trim(text)
        if not part:
            out.append(text)
        elif mode != SUGGEST and part not in listed and not (mode == MIXED and lex):
            out.append(part)
    return out


def value_allowed(value, tagset, reading: Optional[dict] = None) -> bool:
    """Whether a value may be written to a field ``tagset`` governs, as the
    app's write paths decide it: a tagset that only suggests takes anything,
    and an enforcing one takes a value with no refused part."""
    return not tagset_enforces(tagset) or not refused_parts(value, tagset, reading)
