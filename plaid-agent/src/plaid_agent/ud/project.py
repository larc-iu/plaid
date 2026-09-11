"""The UD project and document, as the assistant's tools see them.

A plaid-ud project is three token layers over one baseline text, bound by the
shared roles every app agrees on:

    baseline        the text
    sentence        sentences, partitioning the text
    word            the SURFACE token, CoNLL-U's "token"
    syntactic-word  the annotated word, CoNLL-U's "word"

Annotation span layers (form, lemma, upos, xpos, features) hang off the
syntactic-word layer and are bound by UD's own ``config.ud.<key>`` flags. The
dependency relation layer hangs off the LEMMA span layer, so a dependency is a
relation between two lemma spans, with a self-relation for the root.

**The full-width rule.** A syntactic word always covers the whole of its
surface token, never a sub-range: "del" is two syntactic words both spanning
the same characters, told apart by ``precedence`` and by their Form span. So a
1:1 token has exactly one syntactic word with the same extent, and a
multi-word token has several. Never take a substring as a form.

**Addressing is CoNLL-U's own.** ``s3`` is the third sentence, ``s3.w2`` the
syntactic word whose CoNLL-U id is 2 in it, and ``s3.w1-2`` the multi-word
token spanning words 1 and 2. Those are the numbers a reader sees in the
rendered sentence and the numbers the HEAD column points at, so the model
never handles an id.
"""

import re
from dataclasses import dataclass, field as dc_field
from typing import Any, Dict, List, Optional, Tuple

from plaid_client import ROLES, find_by_role

from ..core.provenance import review_mark

UD = 'ud'
MISSING = '_'

#: Span layers under the syntactic-word layer, by their ``config.ud`` flag.
SPAN_KEYS = ('form', 'lemma', 'upos', 'xpos', 'features')
#: The relation layer's flag, on the lemma span layer.
RELATION_KEY = 'dependency'

UPOS_TAGS = ('ADJ', 'ADP', 'ADV', 'AUX', 'CCONJ', 'DET', 'INTJ', 'NOUN', 'NUM', 'PART',
             'PRON', 'PROPN', 'PUNCT', 'SCONJ', 'SYM', 'VERB', 'X')

UNIVERSAL_DEPRELS = (
    'acl', 'advcl', 'advmod', 'amod', 'appos', 'aux', 'case', 'cc', 'ccomp', 'clf', 'compound',
    'conj', 'cop', 'csubj', 'dep', 'det', 'discourse', 'dislocated', 'expl', 'fixed', 'flat',
    'goeswith', 'iobj', 'list', 'mark', 'nmod', 'nsubj', 'nummod', 'obj', 'obl', 'orphan',
    'parataxis', 'punct', 'reparandum', 'root', 'vocative', 'xcomp')

OPEN, CLOSED = 'open', 'closed'


def _ud(cfg, key):
    return ((cfg or {}).get(UD) or {}).get(key)


def _vocab(cfg, fallback=()):
    """A layer's controlled vocabulary, or the fallback when it has none."""
    v = _ud(cfg, 'vocab')
    return list(v) if isinstance(v, list) and v else list(fallback)


def _mode(cfg) -> str:
    """Whether the vocabulary is a rule or a suggestion. Anything unrecognized,
    absent included, reads as open, exactly as the app reads it."""
    return CLOSED if _ud(cfg, 'vocabMode') == CLOSED else OPEN


def _descriptions(cfg) -> Dict[str, str]:
    raw = _ud(cfg, 'vocabDescriptions')
    return dict(raw) if isinstance(raw, dict) else {}


def _inventory(cfg) -> Dict[str, List[str]]:
    """The feature inventory as ``{Feature: [values]}``. Empty when the project
    has not set one, which the app reads as "every feature is allowed"."""
    raw = _ud(cfg, 'inventory')
    out: Dict[str, List[str]] = {}
    for entry in raw if isinstance(raw, list) else []:
        if isinstance(entry, dict) and entry.get('key'):
            out[entry['key']] = list(entry.get('values') or [])
    return out


# --- project ----------------------------------------------------------------

@dataclass
class UdProject:
    id: str
    name: str
    language: str
    text_layer_id: str
    sentence_layer_id: str
    token_layer_id: str          # role `word`: the surface token
    word_layer_id: str           # role `syntactic-word`: where annotations live
    span_layers: Dict[str, str]  # 'upos' -> layer id
    relation_layer_id: Optional[str]
    vocab: Dict[str, Any] = dc_field(default_factory=dict)
    modes: Dict[str, str] = dc_field(default_factory=dict)
    descriptions: Dict[str, Dict[str, str]] = dc_field(default_factory=dict)

    def layer(self, field: str) -> str:
        """The span layer id for an annotation field, by its UD name."""
        lid = self.span_layers.get(field)
        if not lid:
            raise ValueError(f'This project has no {field} layer')
        return lid

    def rule(self, field: str) -> str:
        """One line saying whether a field's vocabulary is a rule or a hint."""
        values = self.vocab.get(field) or []
        if not values:
            return f'{field}: no controlled vocabulary, any value is allowed'
        closed = self.modes.get(field) == CLOSED
        how = 'ONLY these values are allowed' if closed else 'these are the expected values, others are allowed'
        return f'{field}: {how}: ' + ', '.join(values)


def load_project(client, project_id: str) -> UdProject:
    p = client.projects.get(project_id)
    text_layer = find_by_role(p.get('text_layers'), ROLES.BASELINE)
    if not text_layer:
        raise ValueError('This project has no baseline text layer (not set up for UD?)')
    token_layers = text_layer.get('token_layers') or []
    sent = find_by_role(token_layers, ROLES.SENTENCE)
    token = find_by_role(token_layers, ROLES.WORD)
    word = find_by_role(token_layers, ROLES.SYNTACTIC_WORD)
    if not sent or not token or not word:
        raise ValueError('This project lacks a sentence, token or word layer (not set up for UD?)')

    span_layers: Dict[str, str] = {}
    configs: Dict[str, dict] = {}
    for sl in word.get('span_layers') or []:
        for key in SPAN_KEYS:
            if _ud(sl.get('config'), key) is True:
                span_layers[key] = sl['id']
                configs[key] = sl.get('config') or {}
    missing = [k for k in SPAN_KEYS if k not in span_layers]
    if missing:
        raise ValueError('This project is missing its ' + ', '.join(missing)
                         + ' layer' + ('s' if len(missing) > 1 else '')
                         + '. A maintainer can finish setting it up on the project page.')

    relation_layer_id, relation_config = None, {}
    for sl in word.get('span_layers') or []:
        if sl['id'] != span_layers['lemma']:
            continue
        for rl in sl.get('relation_layers') or []:
            if _ud(rl.get('config'), RELATION_KEY) is True:
                relation_layer_id, relation_config = rl['id'], rl.get('config') or {}
    if not relation_layer_id:
        raise ValueError('This project has no dependency relation layer '
                         '(a maintainer can finish setting it up on the project page).')

    language = _ud(p.get('config'), 'language')
    return UdProject(
        id=p['id'], name=p['name'],
        language=language.strip() if isinstance(language, str) else '',
        text_layer_id=text_layer['id'], sentence_layer_id=sent['id'],
        token_layer_id=token['id'], word_layer_id=word['id'],
        span_layers=span_layers, relation_layer_id=relation_layer_id,
        vocab={
            'upos': _vocab(configs.get('upos'), UPOS_TAGS),
            'xpos': _vocab(configs.get('xpos')),
            'deprel': _vocab(relation_config, UNIVERSAL_DEPRELS),
            'feats': _inventory(configs.get('features')),
        },
        modes={
            'upos': _mode(configs.get('upos')), 'xpos': _mode(configs.get('xpos')),
            'deprel': _mode(relation_config), 'feats': _mode(configs.get('features')),
        },
        descriptions={
            'upos': _descriptions(configs.get('upos')), 'xpos': _descriptions(configs.get('xpos')),
            'deprel': _descriptions(relation_config),
        },
    )


# --- document ---------------------------------------------------------------

@dataclass
class Span:
    id: str
    value: str
    metadata: Optional[dict]
    layer_id: str


@dataclass
class Word:
    """One CoNLL-U word line: a syntactic word, where every annotation lives."""
    id: str                       # the token id on the syntactic-word layer
    index: int                    # its CoNLL-U id within the sentence, 1-based
    form: str
    fields: Dict[str, Span]       # 'lemma' -> Span, for the five span layers
    token: 'Token' = None         # the surface token it belongs to
    head: Optional[int] = None    # the CoNLL-U id of its head, 0 for the root
    deprel: Optional[str] = None
    relation_id: Optional[str] = None
    relation_metadata: Optional[dict] = None

    def value(self, name: str) -> str:
        sp = self.fields.get(name)
        return sp.value if sp and sp.value else ''

    def marked(self, name: str) -> str:
        """A field's value with its review mark, or ``_`` when it is empty."""
        sp = self.fields.get(name)
        if not sp or not sp.value:
            return MISSING
        return sp.value + review_mark(sp.metadata)

    @property
    def is_part_of_mwt(self) -> bool:
        return bool(self.token and len(self.token.words) > 1)


@dataclass
class Token:
    """A surface token. One syntactic word usually, several for a multi-word
    token, all of them covering exactly the same characters."""
    id: str
    begin: int
    end: int
    surface: str
    words: List[Word] = dc_field(default_factory=list)
    metadata: dict = dc_field(default_factory=dict)

    @property
    def ref_range(self) -> str:
        """``w2`` for a plain token, ``w1-2`` for a multi-word one."""
        if len(self.words) == 1:
            return f'w{self.words[0].index}'
        return f'w{self.words[0].index}-{self.words[-1].index}'


@dataclass
class Sentence:
    id: str
    index: int
    begin: int
    end: int
    text: str
    tokens: List[Token] = dc_field(default_factory=list)
    metadata: dict = dc_field(default_factory=dict)

    @property
    def words(self) -> List[Word]:
        return [w for t in self.tokens for w in t.words]

    def word(self, index: int) -> Optional[Word]:
        for w in self.words:
            if w.index == index:
                return w
        return None


@dataclass
class UdDoc:
    id: str
    name: str
    text_id: Optional[str]
    body: str
    sentences: List[Sentence]
    metadata: dict
    version: Optional[int]

    @property
    def word_count(self) -> int:
        return sum(len(s.words) for s in self.sentences)

    def find(self, entity_id: str):
        """The sentence, token or word with this id, or None. For turning a
        query hit or a comment's anchor back into something addressable."""
        for s in self.sentences:
            if s.id == entity_id:
                return s
            for t in s.tokens:
                if t.id == entity_id:
                    return t
                for w in t.words:
                    if w.id == entity_id:
                        return w
        return None


def _find_layer(text_layers, token_layer_id):
    for tl in text_layers or []:
        for tk in tl.get('token_layers') or []:
            if tk['id'] == token_layer_id:
                return tl, tk
    return None, None


def _spans_by_token(token_layer, span_layers: Dict[str, str]) -> Dict[str, Dict[str, Span]]:
    """token id -> {field name: Span}, over the project's five span layers."""
    by_id = {lid: name for name, lid in span_layers.items()}
    out: Dict[str, Dict[str, Span]] = {}
    for sl in token_layer.get('span_layers') or []:
        name = by_id.get(sl['id'])
        if not name:
            continue
        for sp in sl.get('spans') or []:
            for tid in sp.get('tokens') or []:
                out.setdefault(tid, {})[name] = Span(
                    sp['id'], sp.get('value') if sp.get('value') is not None else '',
                    sp.get('metadata'), sl['id'])
    return out


def _relations(token_layer, relation_layer_id: Optional[str]) -> List[dict]:
    for sl in token_layer.get('span_layers') or []:
        for rl in sl.get('relation_layers') or []:
            if rl['id'] == relation_layer_id:
                return list(rl.get('relations') or [])
    return []


def load_document(client, project: UdProject, document_id: str) -> UdDoc:
    raw = client.documents.get(document_id, include_body=True)
    return parse_document(raw, project)


def parse_document(raw: dict, project: UdProject) -> UdDoc:
    tl, word_layer = _find_layer(raw.get('text_layers'), project.word_layer_id)
    _, token_layer = _find_layer(raw.get('text_layers'), project.token_layer_id)
    _, sent_layer = _find_layer(raw.get('text_layers'), project.sentence_layer_id)
    text = (tl or {}).get('text') or {}
    body = text.get('body') or ''
    chars = list(body)
    if not word_layer or not token_layer or not sent_layer:
        return UdDoc(raw['id'], raw.get('name') or '', text.get('id'), body, [],
                     raw.get('metadata') or {}, raw.get('version'))

    spans = _spans_by_token(word_layer, project.span_layers)
    # The syntactic words of one surface token share its extent exactly (the
    # full-width rule), so the extent is the key, and `precedence` is the only
    # thing that orders them.
    words_at: Dict[Tuple[int, int], List[dict]] = {}
    for w in word_layer.get('tokens') or []:
        words_at.setdefault((w['begin'], w['end']), []).append(w)
    for group in words_at.values():
        group.sort(key=lambda w: (w.get('precedence') if w.get('precedence') is not None else 1, w['id']))

    tokens = sorted(token_layer.get('tokens') or [], key=lambda t: (t['begin'], t['end']))
    by_lemma_span: Dict[str, Word] = {}
    sentences: List[Sentence] = []
    ti = 0
    for si, s in enumerate(sorted(sent_layer.get('tokens') or [], key=lambda t: t['begin']), start=1):
        while ti < len(tokens) and tokens[ti]['begin'] < s['begin']:
            ti += 1
        sent_tokens: List[Token] = []
        index = 1
        k = ti
        while k < len(tokens) and tokens[k]['begin'] < s['end']:
            t = tokens[k]
            k += 1
            if t['end'] > s['end']:
                continue
            surface = ''.join(chars[t['begin']:t['end']])
            tok = Token(id=t['id'], begin=t['begin'], end=t['end'], surface=surface,
                        metadata=t.get('metadata') or {})
            for w in words_at.get((t['begin'], t['end']), []):
                fields = spans.get(w['id'], {})
                form = fields['form'].value if fields.get('form') and fields['form'].value else surface
                word = Word(id=w['id'], index=index, form=form, fields=fields, token=tok)
                index += 1
                tok.words.append(word)
                if fields.get('lemma'):
                    by_lemma_span[fields['lemma'].id] = word
            sent_tokens.append(tok)
        sentences.append(Sentence(
            id=s['id'], index=si, begin=s['begin'], end=s['end'],
            text=''.join(chars[s['begin']:s['end']]).strip(),
            tokens=sent_tokens, metadata=s.get('metadata') or {}))

    # Dependencies are relations between LEMMA spans. A self-relation is the
    # root, which CoNLL-U writes as head 0.
    for rel in _relations(word_layer, project.relation_layer_id):
        target = by_lemma_span.get(rel.get('target'))
        source = by_lemma_span.get(rel.get('source'))
        if target is None:
            continue
        target.head = 0 if source is target else (source.index if source else None)
        target.deprel = rel.get('value') or None
        target.relation_id = rel.get('id')
        target.relation_metadata = rel.get('metadata')
    return UdDoc(raw['id'], raw.get('name') or '', text.get('id'), body, sentences,
                 raw.get('metadata') or {}, raw.get('version'))


# --- addressing -------------------------------------------------------------

REF_RE = re.compile(r'^\s*s(\d+)(?:\.w(\d+)(?:-(\d+))?)?\s*$')


def parse_ref(ref: str) -> Tuple[int, Optional[int], Optional[int]]:
    """``s3`` -> (3, None, None); ``s3.w2`` -> (3, 2, None); ``s3.w1-2`` -> (3, 1, 2)."""
    m = REF_RE.match(ref or '')
    if not m:
        raise ValueError(f'Bad reference "{ref}": use s<n> for a sentence, s<n>.w<n> for a word, '
                         f'or s<n>.w<n>-<n> for a multi-word token (e.g. s3.w2, s3.w1-2)')
    si, a, b = m.groups()
    return int(si), int(a) if a else None, int(b) if b else None


def resolve(doc: UdDoc, ref: str):
    """-> Sentence | Word | Token for a positional reference into ``doc``."""
    si, a, b = parse_ref(ref)
    if not 1 <= si <= len(doc.sentences):
        raise ValueError(f'{ref}: document "{doc.name}" has {len(doc.sentences)} sentences')
    s = doc.sentences[si - 1]
    if a is None:
        return s
    if b is None:
        w = s.word(a)
        if w is None:
            raise ValueError(f'{ref}: sentence s{si} has {len(s.words)} words')
        return w
    for t in s.tokens:
        if t.words and t.words[0].index == a and t.words[-1].index == b:
            return t
    raise ValueError(f'{ref}: sentence s{si} has no multi-word token spanning words {a} to {b}')


def word_ref(s: Sentence, w: Word) -> str:
    return f's{s.index}.w{w.index}'


def token_ref(s: Sentence, t: Token) -> str:
    return f's{s.index}.{t.ref_range}'


# --- rendering ---------------------------------------------------------------

COLUMNS = ('ID', 'FORM', 'LEMMA', 'UPOS', 'XPOS', 'FEATS', 'HEAD', 'DEPREL')


def _rows(s: Sentence) -> List[List[str]]:
    """One CoNLL-U-shaped row per surface token and per word, in reading order.
    A multi-word token gets its range line first, with empty annotation columns,
    exactly as CoNLL-U writes it."""
    rows: List[List[str]] = []
    for t in s.tokens:
        if len(t.words) > 1:
            rows.append([f'{t.words[0].index}-{t.words[-1].index}', t.surface]
                        + [MISSING] * (len(COLUMNS) - 2))
        for w in t.words:
            head = MISSING if w.head is None else str(w.head)
            deprel = w.deprel or MISSING
            if w.deprel and w.relation_metadata is not None:
                deprel += review_mark(w.relation_metadata)
            rows.append([str(w.index), w.form, w.marked('lemma'), w.marked('upos'),
                         w.marked('xpos'), w.marked('features'), head, deprel])
    return rows


def render_sentence(s: Sentence, *, header: bool = True) -> str:
    """One sentence as CoNLL-U-shaped rows, aligned so the columns can be read
    down. ``~`` after a value means a machine made it and nobody has confirmed
    it, ``^`` means a contributor's unreviewed work."""
    rows = _rows(s)
    out = []
    if header:
        # The renderer owns these two: `sent_id` is the address the model must
        # use to refer to the sentence, whatever the corpus called it.
        out.append(f'# sent_id = s{s.index}')
        out.append(f'# text = {s.text}')
        for k in sorted(s.metadata):
            if k not in ('sent_id', 'text') and isinstance(s.metadata[k], str) and s.metadata[k]:
                out.append(f'# {k} = {s.metadata[k]}')
    widths = [max(len(COLUMNS[i]), *(len(r[i]) for r in rows)) if rows else len(COLUMNS[i])
              for i in range(len(COLUMNS))]
    out.append('  '.join(c.ljust(widths[i]) for i, c in enumerate(COLUMNS)).rstrip())
    for r in rows:
        out.append('  '.join(v.ljust(widths[i]) for i, v in enumerate(r)).rstrip())
    return '\n'.join(out)


def render_document(doc: UdDoc, *, from_sentence: int = None, to_sentence: int = None,
                    indexes: Optional[List[int]] = None) -> str:
    """A document as the model reads it.

    Either a RANGE, which keeps a long document inside one tool result without
    the model losing where it is, or an explicit list of sentence ``indexes``,
    which is what a reader wants once it knows where to look: a long document
    otherwise costs one call per page, and paging is the whole step budget.
    """
    sentences = doc.sentences
    out = [f'Document "{doc.name}" ({len(sentences)} sentences, {doc.word_count} words)']
    for k in sorted(doc.metadata):
        if isinstance(doc.metadata[k], str) and doc.metadata[k]:
            out.append(f'# {k} = {doc.metadata[k]}')
    if not sentences:
        out.append('The document has no sentences yet: it has not been tokenized.')
        return '\n'.join(out)

    if indexes is not None:
        picked = [i for i in indexes if 1 <= i <= len(sentences)]
        out.append('Showing sentences ' + ', '.join(str(i) for i in picked) + '.'
                   if picked else 'None of those sentences exist.')
        chosen = [sentences[i - 1] for i in picked]
    else:
        lo = max(1, from_sentence or 1)
        hi = min(len(sentences), to_sentence or len(sentences))
        if lo > 1 or hi < len(sentences):
            out.append(f'Showing sentences {lo} to {hi}.')
        chosen = sentences[lo - 1:hi]

    for s in chosen:
        out.append('')
        out.append(render_sentence(s))
    return '\n'.join(out)
