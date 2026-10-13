"""grew_search: a Grew pattern over the treebank, answered by the query engine.

A structural question (a head and its dependent, a deprel with a UPOS on
either end, what a word lacks) was answered by walking the corpus in run_code,
which took minutes on a large treebank and left nothing to show when the user
asked what the query had been. The Search tab already speaks Grew, so this
runs the same pattern the same way (:mod:`.grew`) and answers with the
sentences, the matched words, the totals and the pattern itself, which the
user can paste into the tab.
"""

import re
from collections import OrderedDict
from typing import Any, Dict, List, Optional

from ..core.args import clamp_limit
from ..core.corpus import spread
from ..core.limits import READ_LIMITS
from ..core.tools import ToolError, truncate
from .corpus import RENDER_DOC_BUDGET
from .grew import GrewParseError, GrewUnsupportedError, layers_of, parse_and_compile
from .grew_syntax import compact_label
from .project import Sentence, UdDoc, Word
from .tools import Workspace

#: Rows one search fetches. Past it the totals come from a count instead.
FETCH = 2000
#: Characters of a long sentence kept either side of its marked words.
CONTEXT = 50
#: Matches listed on one sentence's line before the rest are counted.
MATCHES_PER_LINE = 4


def _parse_error(e: GrewParseError) -> str:
    out = f'Not a Grew pattern: {e.message}'
    if e.line is not None:
        out += f' (line {e.line}, column {e.col})'
        if e.source_line is not None:
            out += f'\n  {e.source_line}\n  {" " * max(0, (e.col or 1) - 1)}^'
    return out


def _echo(pattern: str) -> str:
    lines = [ln.rstrip() for ln in pattern.strip().split('\n')]
    if len(lines) == 1:
        return f'Pattern (paste it into the Search tab as it is): {lines[0]}'
    return 'Pattern (paste it into the Search tab as it is):\n' + '\n'.join('  ' + ln for ln in lines)


def _marked(doc: UdDoc, s: Sentence, words: List[Word]) -> str:
    """The sentence with each matched word's token in brackets, cut to the
    stretch around them when it is long."""
    spans = sorted({(w.token.begin, w.token.end) for w in words if w.token})
    if not spans:
        return ' '.join(doc.body[s.begin:s.end].split())
    begin, end = s.begin, s.end
    if end - begin > 2 * CONTEXT + (spans[-1][1] - spans[0][0]):
        begin = max(s.begin, spans[0][0] - CONTEXT)
        end = min(s.end, spans[-1][1] + CONTEXT)
    out, at = '', begin
    for b, e in spans:
        if b < at:
            continue
        out += doc.body[at:b] + '[' + doc.body[b:e] + ']'
        at = e
    out += doc.body[at:end]
    text = ' '.join(out.split())
    return ('…' if begin > s.begin else '') + text + ('…' if end < s.end else '')


EDGE = re.compile(r'([A-Za-z_][\w]*)\s*-\[([^\]]*)\]->\s*([A-Za-z_][\w]*)')


def _direction_hint(pattern: str) -> str:
    """A line under "No matches." for a pattern with an edge: a model that
    wrote A -[amod]-> N for an adjective on its noun answered 0, where the
    other direction finds 34 (2026-10-13 survey)."""
    m = EDGE.search(pattern)
    if m:
        head, rel, dep = m.groups()
        return (f'\nIn {head} -[{rel}]-> {dep}, {head} is the head and {dep} the dependent: check the '
                'direction.')
    if '->' in pattern:
        return '\nIn X -[rel]-> Y, X is the head and Y the dependent: check the direction.'
    return ''


def _binding(row: Dict[str, Any], doc: UdDoc, enhanced: Optional[str]) -> str:
    """One match as ``X=w2 Y=w5 e=nsubj``."""
    parts = []
    for var, ent in row.items():
        if not isinstance(ent, dict):
            continue
        if var.startswith('?n_'):
            w = doc.find(ent.get('id'))
            parts.append(f'{var[3:]}=w{w.index}' if isinstance(w, Word) else f'{var[3:]}=?')
        elif var.startswith('?e_'):
            parts.append(f'{var[3:]}=' + compact_label(ent.get('value'),
                                                     bool(enhanced) and ent.get('layer') == enhanced))
    return ' '.join(parts)


def t_grew_search(ws: Workspace, pattern: str = None, document: str = None, limit: int = None) -> str:
    """Sentences matching a Grew pattern, with the matched words marked."""
    if not isinstance(pattern, str) or not pattern.strip():
        raise ToolError('Give a Grew pattern, e.g. pattern { V [upos=VERB]; V -[nsubj]-> S }.')
    limit = clamp_limit(limit, *READ_LIMITS['search'])
    try:
        compiled = parse_and_compile(pattern, layers_of(ws.project), limit=FETCH)
    except GrewParseError as e:
        raise ToolError(_parse_error(e))
    except GrewUnsupportedError as e:
        raise ToolError(f'Not supported (the Search tab refuses it too): {e.message}')
    echo = _echo(pattern)
    notes = ''.join(f'\n(note) {w}' for w in compiled.warnings)
    if compiled.impossible:
        ws.note_read(0, 'match')
        return f'{echo}\nNo sentence can match this pattern.{notes}'

    q = compiled.query
    c = ws.corpus
    with c.within(document) as doc_id:
        ws.on_progress('Running the Grew search…')
        try:
            res = c.run(q)
        except ToolError as e:
            if getattr(e.__context__, 'status', None) == 408:
                raise ToolError('The engine gave up on this pattern after 30 s. Name a document, or '
                                'constrain the nodes more (a upos, a lemma, an edge label).') from None
            raise
        rows = [dict(zip(q['find'], r)) for r in res.get('results') or []]
        truncated = bool(res.get('truncated'))
        if truncated:
            total = c.count(q['where'], q['find'])
            sentences = c.count(q['where'], ['?S'])
            documents = len(c.group(q['where'], ['?S.doc']))
        else:
            total = len(rows)
            sentences = len({r['?S'].get('id') for r in rows})
            documents = len({r['?S'].get('document') for r in rows})

    if not rows:
        ws.note_read(0, 'match')
        where = f' in "{ws.doc(doc_id).name}"' if doc_id else ''
        return f'{echo}\nNo matches{where}.{_direction_hint(pattern)}{notes}'

    # Rows come ordered by document and position: group them by sentence.
    by_doc: 'OrderedDict[str, OrderedDict[str, List[dict]]]' = OrderedDict()
    for r in rows:
        s = r['?S']
        by_doc.setdefault(s.get('document'), OrderedDict()).setdefault(s.get('id'), []).append(r)

    if doc_id:
        picks = [(doc_id, limit)]
    else:
        picks = spread([(d, len(ss)) for d, ss in by_doc.items()], limit, RENDER_DOC_BUDGET).picks
    ws.read_ahead([d for d, _ in picks])
    enhanced = ws.project.enhanced_relation_layer_id
    out: List[str] = []
    shown = 0
    for did, quota in picks:
        if shown >= limit:
            break
        doc = ws.doc(did)
        sents = by_doc.get(did) or {}
        matches = sum(len(m) for m in sents.values())
        out.append(f'"{doc.name}" ({matches} match{"es" if matches != 1 else ""} in '
                   f'{len(sents)} sentence{"s" if len(sents) != 1 else ""}'
                   + (', of those fetched' if truncated else '') + ')')
        take = min(quota, limit - shown)
        for sid, ms in list(sents.items())[:take]:
            s = doc.find(sid)
            if not isinstance(s, Sentence):
                continue
            words = [doc.find(e.get('id')) for m in ms for v, e in m.items()
                     if v.startswith('?n_') and isinstance(e, dict)]
            words = [w for w in words if isinstance(w, Word)]
            refs = sorted({w.index for w in words})
            ref = f's{s.index}' + ('.' + ','.join(f'w{i}' for i in refs) if refs else '')
            binds = ', '.join(_binding(m, doc, enhanced) for m in ms[:MATCHES_PER_LINE])
            if len(ms) > MATCHES_PER_LINE:
                binds += f', +{len(ms) - MATCHES_PER_LINE} more'
            out.append(f'  {ref}  {binds}   {_marked(doc, s, words)}')
            shown += 1
        if len(sents) > take:
            out.append(f'  … {len(sents) - take} more sentences here'
                       + ('' if doc_id else ' (name the document to see them)'))

    head = (f'{total} match{"es" if total != 1 else ""} in {sentences} '
            f'sentence{"s" if sentences != 1 else ""}, {documents} '
            f'document{"s" if documents != 1 else ""}. Showing {shown} sentence'
            f'{"s" if shown != 1 else ""}:')
    if truncated:
        notes += (f'\n(note) The totals are exact, but only the first {FETCH} matches were fetched, '
                  'so the sentences shown come from the documents those are in.')
    ws.note_read(shown, 'sentence', of=sentences)
    return truncate(f'{echo}\n{head}\n' + '\n'.join(out) + notes)
