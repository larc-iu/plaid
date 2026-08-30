"""The IGT view of a Plaid project, for the assistant's tools.

Loads a project's IGT substrate (baseline text; sentence, word and morpheme
token layers found by their shared role; annotation fields by their igt scope;
orthographies; lexicons) and its documents into small dataclasses, and
renders them as the compact text the model reads.

Addresses are positional, so the model never handles ids: ``s3`` is the third
sentence of a document, ``s3.w2`` its second word, ``s3.w2.m1`` that word's
first morpheme. Tokens the word layer's ``ignoredTokens`` config excludes
(punctuation, typically) are not numbered, matching the editor, which gives
them no annotation cells.
"""

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import regex as uregex
from plaid_client import ROLES, find_by_role

SCOPES = ('Word', 'Morpheme', 'Sentence')


def _igt(cfg, key):
    return ((cfg or {}).get('igt') or {}).get(key)


# --- ignored tokens and word breaks (ported from plaid-igt: domain/igtConfig.js
# and utils/tokenizationUtils.js). Word numbering depends on these agreeing
# with the editor exactly, so the character classes are the editor's own. ---

# The editor's isUnicodePunctuation character class, verbatim.
_EDITOR_PUNCT = re.compile('[' + '''\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u00A1-\u00A9\u00AB-\u00B1\u00B4\u00B6-\u00B8\u00BB\u00BF\u037E\u0387\u055A-\u055F\u0589-\u058A\u05BE\u05C0\u05C3\u05C6\u05F3-\u05F4\u0609-\u060A\u060C-\u060D\u061B\u061E-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964-\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A-\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9-\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B-\u169C\u16EB-\u16ED\u1735-\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944-\u1945\u1A1E-\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B5A-\u1B60\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E-\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D-\u207E\u208D-\u208E\u2308-\u230B\u2329-\u232A\u2768-\u2775\u27C5-\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC-\u29FD\u2CF9-\u2CFC\u2CFE-\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE-\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE-\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E-\uA92F\uA95F\uA9C1-\uA9CD\uA9DE-\uA9DF\uAA5C-\uAA5F\uAADE-\uAADF\uAAF0-\uAAF1\uABEB\uFD3E-\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A-\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A-\uFF1B\uFF1F-\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65\U00010100-\U00010102\U0001039F\U000103D0\U0001056F\U00010857\U0001091F\U0001093F\U00010A50-\U00010A58\U00010A7F\U00010AF0-\U00010AF6\U00010B39-\U00010B3F\U00010B99-\U00010B9C\U00010F55-\U00010F59\U00011047-\U0001104D\U000110BB-\U000110BC\U000110BE-\U000110C1\U00011140-\U00011143\U00011174-\U00011175\U000111C5-\U000111C8\U000111C9\U000111DD\U000111DB\U000111DA\U00011238-\U0001123D\U000112A9\U0001144B-\U0001144F\U0001145A-\U0001145B\U0001145D\U000114C6\U000115C1-\U000115D7\U00011641-\U00011643\U00011660-\U0001166C\U0001173C-\U0001173E\U0001183B\U00011944-\U00011946\U000119E2\U00011A3F-\U00011A46\U00011A9A-\U00011A9C\U00011A9E-\U00011AA2\U00011C41-\U00011C45\U00011C70-\U00011C71\U00011EF7-\U00011EF8\U00012470-\U00012474\U00016A6E-\U00016A6F\U00016AF5\U00016B37-\U00016B3B\U00016B44\U00016E97-\U00016E9A\U0001BC9F\U0001DA87-\U0001DA8B\U0001E95E-\U0001E95F''' + ']')
_PICTOGRAPH = uregex.compile(r'\p{Extended_Pictographic}')


def is_unicode_punctuation(c: str) -> bool:
    """The editor's rule for a punctuation character (tokenizationUtils.js)."""
    return len(c) == 1 and bool(_EDITOR_PUNCT.match(c))


def _is_pictograph(c):
    return bool(_PICTOGRAPH.match(c))


def _is_punct_char(c):
    return unicodedata.category(c)[0] in 'PS' and not _is_pictograph(c)


def is_token_ignored(content, cfg):
    """igtConfig.js isTokenIgnored: an all-punctuation token (P or S category,
    pictographs excepted) is ignored unless whitelisted."""
    if not cfg:
        return False
    if cfg.get('type') == 'unicodePunctuation':
        if content and all(_is_punct_char(c) for c in content):
            return content not in (cfg.get('whitelist') or [])
        return False
    if cfg.get('type') == 'blacklist':
        return content in (cfg.get('blacklist') or [])
    return False


def is_clitic(morph_type):
    return isinstance(morph_type, str) and 'clitic' in morph_type.lower()


def joiner(prev_type, next_type):
    """The mark between two adjacent morphemes: '=' when either is a clitic."""
    return '=' if is_clitic(prev_type) or is_clitic(next_type) else '-'


# --- project ----------------------------------------------------------------

@dataclass
class Field:
    name: str        # display name, unique in the project ("Gloss", or "Gloss (Word)" on a collision)
    layer_id: str
    scope: str       # Word | Morpheme | Sentence
    base_name: str = ''  # the layer's own name


def _unique_field_names(entries):
    """[(layer name, layer id, scope)] -> Fields with display names made unique
    (case-insensitively) by a scope suffix where the same layer name occurs in
    several scopes, and a further counter if a layer is literally named like
    a qualified one ("Gloss (Word)")."""
    counts = {}
    for name, _, _ in entries:
        counts[name.casefold()] = counts.get(name.casefold(), 0) + 1
    out = {}
    taken = set()
    for name, lid, scope in entries:
        display = f'{name} ({scope})' if counts[name.casefold()] > 1 else name
        n = 2
        while display.casefold() in taken:
            display = f'{name} ({scope} {n})'
            n += 1
        taken.add(display.casefold())
        out[display] = Field(display, lid, scope, name)
    return out


@dataclass
class IgtProject:
    id: str
    name: str
    text_layer_id: str
    sentence_layer_id: str
    word_layer_id: str
    morpheme_layer_id: Optional[str]
    fields: Dict[str, Field]
    orthographies: List[str]
    ignored_cfg: Optional[dict]
    vocabs: List[dict]  # [{id, name}]
    document_metadata: List[str]

    def field(self, name: str) -> Field:
        """Case-insensitive field lookup by display name, falling back to the
        bare layer name when that is unambiguous; a helpful error otherwise.
        (A project may have a word-scope and a morpheme-scope layer both
        called "Gloss": they are exposed as "Gloss (Word)" and
        "Gloss (Morpheme)", and bare "Gloss" asks you to pick.)"""
        key = (name or '').strip().lower()
        for f in self.fields.values():
            if f.name.lower() == key:
                return f
        base = [f for f in self.fields.values() if f.base_name.lower() == key]
        if len(base) == 1:
            return base[0]
        if len(base) > 1:
            raise ValueError(f'"{name}" names several fields; say which: ' + ', '.join(f.name for f in base))
        raise ValueError(f'No field named "{name}". Fields: '
                         + ', '.join(f'{f.name} ({f.scope})' for f in self.fields.values()))

    def fields_by_scope(self, scope: str) -> List[Field]:
        return [f for f in self.fields.values() if f.scope == scope]

    def field_by_layer(self, layer_id: str) -> Optional[Field]:
        for f in self.fields.values():
            if f.layer_id == layer_id:
                return f
        return None

    def orthography(self, name: str) -> str:
        for o in self.orthographies:
            if o.lower() == (name or '').lower():
                return o
        raise ValueError(f'No orthography named "{name}". Orthographies: '
                         + (', '.join(self.orthographies) or '(none)'))

    def vocab(self, name: Optional[str] = None) -> dict:
        """The lexicon by (case-insensitive) name, or the only one when unnamed."""
        if not self.vocabs:
            raise ValueError('This project has no lexicon (vocabulary).')
        if name:
            for v in self.vocabs:
                if v['name'].lower() == name.lower():
                    return v
            raise ValueError(f'No lexicon named "{name}". Lexicons: '
                             + ', '.join(v['name'] for v in self.vocabs))
        if len(self.vocabs) == 1:
            return self.vocabs[0]
        raise ValueError('Several lexicons; name one: ' + ', '.join(v['name'] for v in self.vocabs))


def load_project(client, project_id: str) -> IgtProject:
    p = client.projects.get(project_id)
    text_layer = find_by_role(p.get('text_layers'), ROLES.BASELINE)
    if not text_layer:
        raise ValueError('This project has no baseline text layer (not set up for IGT?)')
    token_layers = text_layer.get('token_layers') or []
    sent = find_by_role(token_layers, ROLES.SENTENCE)
    word = find_by_role(token_layers, ROLES.WORD)
    morph = find_by_role(token_layers, ROLES.MORPHEME)
    if not sent or not word:
        raise ValueError('This project lacks a sentence or word token layer (not set up for IGT?)')
    entries = []
    for tk in (sent, word, morph):
        if not tk:
            continue
        for sl in tk.get('span_layers') or []:
            scope = _igt(sl.get('config'), 'scope')
            if scope in SCOPES:
                entries.append((sl['name'], sl['id'], scope))
    fields = _unique_field_names(entries)
    return IgtProject(
        id=p['id'], name=p['name'],
        text_layer_id=text_layer['id'], sentence_layer_id=sent['id'], word_layer_id=word['id'],
        morpheme_layer_id=morph['id'] if morph else None,
        fields=fields,
        orthographies=[o['name'] for o in (_igt(word.get('config'), 'orthographies') or [])],
        ignored_cfg=_igt(word.get('config'), 'ignoredTokens'),
        vocabs=[{'id': v['id'], 'name': v['name'],
                 'fields': list((_igt(v.get('config'), 'fields') or {}).keys())} for v in (p.get('vocabs') or [])],
        document_metadata=[m['name'] for m in (_igt(p.get('config'), 'documentMetadata') or [])],
    )


# --- document ---------------------------------------------------------------

@dataclass
class Span:
    id: str
    value: str
    metadata: Optional[dict] = None


@dataclass
class Link:
    id: str
    item_id: str
    form: str
    vocab_id: str
    metadata: Optional[dict] = None


@dataclass
class Morpheme:
    id: str
    index: int
    form: str
    morph_type: Optional[str]
    metadata: dict
    fields: Dict[str, Span] = field(default_factory=dict)
    link: Optional[Link] = None


@dataclass
class Word:
    id: str
    index: int
    surface: str
    begin: int
    end: int
    text_id: str
    metadata: dict
    orthographies: Dict[str, str] = field(default_factory=dict)
    fields: Dict[str, Span] = field(default_factory=dict)
    morphemes: List[Morpheme] = field(default_factory=list)
    link: Optional[Link] = None

    @property
    def ref(self):
        return f'w{self.index}'


@dataclass
class Sentence:
    id: str
    index: int
    text: str
    begin: int
    end: int
    fields: Dict[str, Span] = field(default_factory=dict)
    words: List[Word] = field(default_factory=list)


@dataclass
class IgtDoc:
    id: str
    name: str
    text_id: Optional[str]
    body: str
    sentences: List[Sentence]
    metadata: dict

    def word_count(self):
        return sum(len(s.words) for s in self.sentences)


def _find_layer(text_layers, token_layer_id):
    for tl in text_layers or []:
        for tk in tl.get('token_layers') or []:
            if tk['id'] == token_layer_id:
                return tl, tk
    return None, None


def _spans_by_token(token_layer, project: IgtProject):
    """token id -> {field name: Span} over the layer's scoped fields."""
    out: Dict[str, Dict[str, Span]] = {}
    for sl in token_layer.get('span_layers') or []:
        f = project.field_by_layer(sl['id'])
        if not f:
            continue
        for sp in sl.get('spans') or []:
            for tid in sp.get('tokens') or []:
                out.setdefault(tid, {})[f.name] = Span(sp['id'], sp.get('value') if sp.get('value') is not None else '',
                                                       sp.get('metadata'))
    return out


def _links_by_token(token_layer):
    out: Dict[str, Link] = {}
    for v in token_layer.get('vocabs') or []:
        for link in v.get('vocab_links') or []:
            item = link.get('vocab_item') or {}
            for tid in link.get('tokens') or []:
                out[tid] = Link(link['id'], item.get('id'), item.get('form') or '', v['id'], link.get('metadata'))
    return out


def load_document(client, project: IgtProject, document_id: str) -> IgtDoc:
    raw = client.documents.get(document_id, include_body=True)
    return parse_document(raw, project)


def parse_document(raw: dict, project: IgtProject) -> IgtDoc:
    tl, word_layer = _find_layer(raw.get('text_layers'), project.word_layer_id)
    _, sent_layer = _find_layer(raw.get('text_layers'), project.sentence_layer_id)
    morph_layer = None
    if project.morpheme_layer_id:
        _, morph_layer = _find_layer(raw.get('text_layers'), project.morpheme_layer_id)
    text = (tl or {}).get('text') or {}
    body = text.get('body') or ''
    chars = list(body)
    if not word_layer or not sent_layer:
        return IgtDoc(raw['id'], raw.get('name') or '', text.get('id'), body, [], raw.get('metadata') or {})

    word_spans = _spans_by_token(word_layer, project)
    word_links = _links_by_token(word_layer)
    sent_spans = _spans_by_token(sent_layer, project)
    morph_spans = _spans_by_token(morph_layer, project) if morph_layer else {}
    morph_links = _links_by_token(morph_layer) if morph_layer else {}
    morphs_by_extent: Dict[Tuple[int, int], List[dict]] = {}
    for m in (morph_layer or {}).get('tokens') or []:
        morphs_by_extent.setdefault((m['begin'], m['end']), []).append(m)
    for ms in morphs_by_extent.values():
        ms.sort(key=lambda m: m.get('precedence') or 1)

    words = sorted(word_layer.get('tokens') or [], key=lambda t: (t['begin'], t['end']))
    sentences: List[Sentence] = []
    wi = 0
    for si, s in enumerate(sorted(sent_layer.get('tokens') or [], key=lambda t: t['begin']), start=1):
        while wi < len(words) and words[wi]['begin'] < s['begin']:
            wi += 1
        ws: List[Word] = []
        k = wi
        while k < len(words) and words[k]['begin'] < s['end']:
            w = words[k]
            k += 1
            if w['end'] > s['end']:
                continue
            surface = ''.join(chars[w['begin']:w['end']])
            if is_token_ignored(surface, project.ignored_cfg):
                continue
            meta = w.get('metadata') or {}
            morphemes = []
            chain = morphs_by_extent.get((w['begin'], w['end']), [])
            for mi, m in enumerate(chain, start=1):
                mm = m.get('metadata') or {}
                form = mm.get('form')
                # A lone morpheme with no form is the editor's default (the
                # whole word); in a longer chain a missing form is a gap.
                morphemes.append(Morpheme(
                    id=m['id'], index=mi,
                    form=form if form not in (None, '') else (surface if len(chain) == 1 else ''),
                    morph_type=mm.get('morphType'), metadata=mm,
                    fields=morph_spans.get(m['id'], {}), link=morph_links.get(m['id'])))
            ws.append(Word(
                id=w['id'], index=len(ws) + 1, surface=surface, begin=w['begin'], end=w['end'],
                text_id=w['text'], metadata=meta,
                orthographies={o: meta.get(f'orthog:{o}') for o in project.orthographies
                               if meta.get(f'orthog:{o}')},
                fields=word_spans.get(w['id'], {}), morphemes=morphemes, link=word_links.get(w['id'])))
        sentences.append(Sentence(
            id=s['id'], index=si, text=''.join(chars[s['begin']:s['end']]).strip(),
            begin=s['begin'], end=s['end'], fields=sent_spans.get(s['id'], {}), words=ws))
    return IgtDoc(raw['id'], raw.get('name') or '', text.get('id'), body, sentences, raw.get('metadata') or {})


# --- addressing -------------------------------------------------------------

REF_RE = re.compile(r'^\s*s(\d+)(?:\.w(\d+)(?:\.m(\d+))?)?\s*$')


def parse_ref(ref: str):
    """'s3' -> (3, None, None); 's3.w2' -> (3, 2, None); 's3.w2.m1' -> (3, 2, 1)."""
    m = REF_RE.match(ref or '')
    if not m:
        raise ValueError(f'Bad reference "{ref}": use s<n>, s<n>.w<n>, or s<n>.w<n>.m<n> (e.g. s3.w2.m1)')
    return tuple(int(g) if g is not None else None for g in m.groups())


def resolve(doc: IgtDoc, ref: str):
    """-> Sentence | Word | Morpheme for a positional reference into `doc`."""
    si, wi, mi = parse_ref(ref)
    if not 1 <= si <= len(doc.sentences):
        raise ValueError(f'{ref}: document "{doc.name}" has {len(doc.sentences)} sentences')
    s = doc.sentences[si - 1]
    if wi is None:
        return s
    if not 1 <= wi <= len(s.words):
        raise ValueError(f'{ref}: sentence s{si} has {len(s.words)} words')
    w = s.words[wi - 1]
    if mi is None:
        return w
    if not 1 <= mi <= len(w.morphemes):
        raise ValueError(f'{ref}: word s{si}.w{wi} "{w.surface}" has {len(w.morphemes)} morphemes')
    return w.morphemes[mi - 1]


def word_ref(s: Sentence, w: Word) -> str:
    return f's{s.index}.w{w.index}'


# --- rendering ---------------------------------------------------------------

MISSING = '_'


def segmentation(w: Word) -> str:
    out = ''
    for i, m in enumerate(w.morphemes):
        if i:
            out += joiner(w.morphemes[i - 1].morph_type, m.morph_type)
        out += m.form or '?'
    return out


def morpheme_field_line(w: Word, name: str) -> Optional[str]:
    if not any(name in m.fields for m in w.morphemes):
        return None
    out = ''
    for i, m in enumerate(w.morphemes):
        if i:
            out += joiner(w.morphemes[i - 1].morph_type, m.morph_type)
        sp = m.fields.get(name)
        out += (sp.value if sp and sp.value != '' else MISSING)
    return out


def render_word(w: Word, project: IgtProject) -> str:
    parts = [f'w{w.index} {w.surface}']
    seg = segmentation(w)
    if len(w.morphemes) > 1 or (w.morphemes and seg != w.surface):
        types = [m.morph_type for m in w.morphemes if m.morph_type]
        parts.append(f'seg={seg}' + (f' types={",".join(m.morph_type or "?" for m in w.morphemes)}' if types else ''))
    for f in project.fields_by_scope('Morpheme'):
        line = morpheme_field_line(w, f.name)
        if line is not None:
            parts.append(f'{f.name}={line}')
    for f in project.fields_by_scope('Word'):
        sp = w.fields.get(f.name)
        if sp and sp.value != '':
            parts.append(f'{f.name}={sp.value}')
    for o, v in w.orthographies.items():
        parts.append(f'{o}={v}')
    if w.link:
        parts.append(f'link={w.link.form}')
    mlinks = [f'm{m.index}:{m.link.form}' for m in w.morphemes if m.link]
    if mlinks:
        parts.append('mlinks=' + ' '.join(mlinks))
    return ' | '.join(parts)


def render_sentence(s: Sentence, project: IgtProject) -> str:
    lines = [f'[s{s.index}] {s.text}']
    for f in project.fields_by_scope('Sentence'):
        sp = s.fields.get(f.name)
        if sp and sp.value != '':
            lines.append(f'  {f.name}: {sp.value}')
    for w in s.words:
        lines.append('  ' + render_word(w, project))
    return '\n'.join(lines)


FORMAT_LEGEND = ('Format: [sN] baseline sentence; then sentence fields; then one line per word: '
                 'wN surface | seg=morphemes joined by - (or = at a clitic) | <morpheme field>=values '
                 'in the same order (_ = missing) | <word field>=value | <orthography>=value | '
                 'link=lexicon entry | mlinks=per-morpheme entries. Address items as sN, sN.wN, sN.wN.mN.')


def render_document(doc: IgtDoc, project: IgtProject, start: int = 1, end: Optional[int] = None,
                    max_sentences: int = 40) -> str:
    n = len(doc.sentences)
    start = max(1, start)
    end = min(n, end if end is not None else start + max_sentences - 1)
    head = f'Document "{doc.name}": {n} sentences, {doc.word_count()} words'
    shown = {k: v for k, v in doc.metadata.items() if k in project.document_metadata and v not in (None, '')}
    if shown:
        head += ' | ' + ', '.join(f'{k}={v}' for k, v in shown.items())
    if n == 0:
        return head + '\n(no sentences yet)'
    if start > n:
        return head + f'\nThe document has only {n} sentences; from_sentence={start} is past the end.'
    if end - start + 1 > max_sentences:
        end = start + max_sentences - 1
    lines = [head, FORMAT_LEGEND, f'Showing s{start}-s{end}.']
    for s in doc.sentences[start - 1:end]:
        lines.append(render_sentence(s, project))
    if end < n:
        lines.append(f'... {n - end} more sentences (read_document with from_sentence={end + 1} for the next batch).')
    return '\n'.join(lines)


def render_overview(project: IgtProject, documents: List[dict]) -> str:
    lines = [f'Project "{project.name}"']
    for scope in SCOPES:
        fs = project.fields_by_scope(scope)
        if fs:
            lines.append(f'{scope} fields: ' + ', '.join(f.name for f in fs))
    if not project.morpheme_layer_id:
        lines.append('No morpheme layer: words cannot be segmented in this project.')
    lines.append('Orthographies: ' + (', '.join(project.orthographies) or '(none)'))
    lines.append('Lexicons: ' + (', '.join(v['name'] + (f' (entry fields: {", ".join(v["fields"])})' if v.get('fields') else '')
                                            for v in project.vocabs) or '(none)'))
    if project.document_metadata:
        lines.append('Document metadata fields: ' + ', '.join(project.document_metadata))
    lines.append(f'Documents ({len(documents)}):')
    for d in sorted(documents, key=lambda d: (d.get('name') or '').lower()):
        mod = (d.get('time_modified') or '')[:10]
        lines.append(f'  {d.get("name") or "(unnamed)"}  id={d["id"]}' + (f'  modified={mod}' if mod else ''))
    return '\n'.join(lines)
