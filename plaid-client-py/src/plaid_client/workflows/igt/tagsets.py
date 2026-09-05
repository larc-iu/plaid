"""Tagsets: the controlled value lists an IGT project holds its fields to.

Reads the configuration the editor reads (plaid-igt ``domain/tagsets.js``
and ``domain/vocabFields.js``), so a service or an assistant can see which
values a field is held to and show them to whatever proposes annotations.

Nothing here enforces anything, on purpose. The app marks a value its
tagset refuses and a person decides what to do with it. A machine that
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
             script without case)
"""

from typing import Dict, Iterator, List, Optional

SUGGEST, CLOSED, MIXED = 'suggest', 'closed', 'mixed'
MODES = (SUGGEST, CLOSED, MIXED)


def _str(v) -> str:
    return v if isinstance(v, str) else ''


def _igt(cfg, key):
    return ((cfg or {}).get('igt') or {}).get(key)


def normalize_tagset(raw, name: Optional[str] = None) -> dict:
    """One tagset as ``{name, delimiters, mode, values}``. Whitespace is never
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
        value = _str(rec.get('value')).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        values.append({**rec, 'value': value})
    mode = raw.get('mode')
    return {
        'name': name,
        'delimiters': ''.join(_str(raw.get('delimiters')).split()),
        'mode': mode if mode in MODES else SUGGEST,
        'values': values,
    }


def read_tagsets(config) -> Dict[str, dict]:
    """A project's (or a vocabulary's) tagsets by name, normalized."""
    raw = _igt(config, 'tagsets')
    out: Dict[str, dict] = {}
    if isinstance(raw, dict):
        for name, t in raw.items():
            key = _str(name).strip()
            if key:
                out[key] = normalize_tagset(t, key)
    return out


def read_tagset_name(layer_config) -> Optional[str]:
    """The tagset name a field's span layer references, or None."""
    return _str(_igt(layer_config, 'tagset')).strip() or None


def resolve_tagset(layer_config, config) -> Optional[dict]:
    """The tagset governing a field, or None: the field references none, or
    a name the project no longer has. A dangling reference governs nothing,
    so it never behaves like a closed, empty list."""
    name = read_tagset_name(layer_config)
    return read_tagsets(config).get(name) if name else None


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
    fields = _igt(vocab_layer.get('config'), 'fields')
    f = fields.get(field_name) if isinstance(fields, dict) else None
    name = _str(f.get('tagset')).strip() if isinstance(f, dict) else ''
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
            out.append({'kind': 'span', 'name': sl.get('name'), 'scope': _igt(sl.get('config'), 'scope'),
                        'layer_id': sl.get('id'), 'tagset': t})
    for m in _igt(project.get('config'), 'documentMetadata') or []:
        if not isinstance(m, dict) or not m.get('name'):
            continue
        name = _str(m.get('tagset')).strip()
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
        rule = ('A grammatical tag, written in capitals or digits, must be a listed value. '
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
