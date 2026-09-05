"""
LLM analysis service: retrieval-grounded interlinear glossing

Proposes a morpheme segmentation and morpheme glosses for the words of a
document with any chat model litellm can reach (OpenAI, Anthropic, Gemini,
Ollama, vLLM, any OpenAI-compatible server), grounded in the project's own
data. Serves the `analyze` task, exactly like the PolyGloss service, and
differs from it only in how a sentence becomes one interleaved
`GLOSS(seg)-GLOSS(seg)` line.

Per sentence the prompt carries, retrieved from Plaid:
  * lexicon entries whose form occurs inside one of the sentence's words,
    ranked by how often they have been linked in the project, with their
    gloss / part of speech / morph type;
  * the project's most similar sentences that a person has analyzed or
    verified, rendered in the same interleaved format, as examples of the
    project's glossing conventions;
  * the sentence's free translation, when it has one.
And once per run, in the system prompt: the tagset the gloss field is held
to, when it has one, with its tags, their meanings, and what its mode
allows, so the model glosses with the project's own abbreviations. Nothing
is enforced: a tag the model writes that is not listed lands as written and
shows in the Validation tab, which is the point (an off-list value from a
machine tells the linguist the list is incomplete or the model is wrong,
and snapping it to the nearest listed tag would hide that).
So a correction a person confirms is an example next run, and a lexicon
entry a person adds or links is evidence next run: the model improves with
the project without retraining (the GlossAssist / CWoMP loop, without
their model). Nothing here creates lexicon entries; linking proposed
morphemes to entries is the Auto-analyze dialog's link step, as for
PolyGloss.

Everything model-independent (document derivation, the write contract,
output parsing + alignment, batched writes with the recorded prediction) is
`plaid_client.workflows.igt`. The provider is chosen at launch:

    python services/igt_analyze_llm.py --url http://localhost:8085 --model openai/gpt-4o-mini
    python services/igt_analyze_llm.py --url ... --model ollama/llama3.1
    python services/igt_analyze_llm.py --url ... --model openai/my-model --api-base http://gpu-box:8000/v1

Keys come from the provider's environment variable or --api-key.
Requirements (on top of plaid-client): litellm.
"""

import argparse
import difflib
from typing import Any, Dict, List, Optional

from plaid_client import BaseService, TASKS, Param, service_source
from plaid_client.workflows.igt import (
    derive, select_targets, word_state, parse_interleaved, align_words, analysis_for, write_analyses,
    tagset_for, mode_rule, value_lines,
)

DEFAULT_SERVICE_ID = 'llm-analyzer'
MAX_EXAMPLE_DOCS = 25  # documents scanned for example sentences per run
DEFAULT_EXAMPLES = 8
DEFAULT_LEXICON_BUDGET = 60  # entries per prompt
TAGSET_BUDGET = 300  # tags shown to the model when the gloss field is held to a tagset

SUMMARY = """\
**LLM glossing** proposes a morpheme **segmentation** and **glosses** for
every word of the document with a language model, grounded in this project:
each sentence is sent with the lexicon entries found inside its words and
the project's most similar sentences that a person has analyzed, so the model
follows the project's own conventions and improves as the project grows.
If the gloss field is held to a tagset, the model is shown its tags and told
which are required, so it glosses with your abbreviations.

- **Language** / **Metalanguage**: the object language's name and the
  language of glosses and translations.
- **Orthography**: leave blank to send the baseline text; name a word
  orthography to send that instead.
- **Gloss field**: the morpheme-scope field that receives the glosses.
- **Examples**: how many analyzed sentences to show the model per sentence.
- **Overwrite human-edited annotations**: by default the service only writes
  words that have no analysis yet or whose analysis is entirely machine-made
  and unverified. Enable this to replace human-made or human-verified
  analyses too (their morphemes, morpheme glosses, and links are discarded).

Everything it writes is stamped machine-made and shows as unverified until a
person confirms it (edit, ✓, or Ctrl+Enter on the word).
"""

SYSTEM_PROMPT = """\
You are an expert in interlinear glossing (Leipzig Glossing Rules) working on a
documentation project. Given a sentence, produce its morpheme segmentation and
glosses in the INTERLEAVED format: for every input word, in order, one
whitespace-separated item of the form GLOSS(segment)-GLOSS(segment)..., where
each morpheme is its gloss followed by its surface segment in parentheses,
morphemes joined by '-' (affixes) or '=' (clitics). The segments of a word
must concatenate to the word as given. Output exactly one line: the glossed
words separated by single spaces, nothing else (no labels, no commentary).
Follow the project's conventions as shown by its lexicon and examples: reuse
their glosses for the same morphemes, their segmentation style, and their
gloss abbreviations. Grammatical glosses are UPPERCASE, lexical glosses are
lowercase. If a word cannot be segmented with confidence, keep it whole as
GLOSS(word)."""


def tagset_paragraph(tagset, max_values=TAGSET_BUDGET) -> str:
    """The gloss field's tagset as a rule for the model, appended to the
    system prompt for the run: what its mode allows, then the tags with
    their meanings. Empty when the field is free. It says an unlisted tag
    goes to the linguist for review rather than forbidding one, so a
    category the list lacks still comes out as itself and not as the
    nearest listed tag."""
    if not tagset:
        return ''
    head = f'The gloss field is held to the tagset "{tagset["name"]}". {mode_rule(tagset)}'
    lines = value_lines(tagset, max_values)
    if not lines:
        return head
    return (head + ' Use these tags, with these spellings, for what they cover. A tag that is not listed is '
            'shown to the linguist for review, so write one only where no listed tag means the same thing.\n'
            'Tags (tag: meaning):\n' + '\n'.join('  ' + line for line in lines))


# --- model -----------------------------------------------------------------

class ChatModel:
    def __init__(self, model, api_base=None, api_key=None, temperature=0.0, max_tokens=None):
        self.model = model
        self.api_base = api_base
        self.api_key = api_key
        self.temperature = temperature
        self.max_tokens = max_tokens

    def describe(self):
        d = {'model': self.model}
        if self.api_base:
            d['api_base'] = self.api_base
        return d

    def complete(self, system: str, user: str) -> str:
        kwargs: Dict[str, Any] = {
            'model': self.model,
            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
            'temperature': self.temperature,
        }
        if self.api_base:
            kwargs['api_base'] = self.api_base
        if self.api_key:
            kwargs['api_key'] = self.api_key
        if self.max_tokens:
            kwargs['max_tokens'] = self.max_tokens
        import litellm  # only the running service needs it; the pure helpers are testable without
        resp = litellm.completion(**kwargs)
        return (resp.choices[0].message.content or '').strip()


def first_gloss_line(text: str) -> str:
    """The interleaved line out of a reply that may carry a label or prose."""
    for line in text.splitlines():
        s = line.strip().strip('`')
        if ':' in s and '(' in s and s.index(':') < s.index('('):
            s = s.split(':', 1)[1].strip()
        if '(' in s:
            return s
    return ''


# --- retrieval: the lexicon -----------------------------------------------------

def _field(meta, *names):
    """A vocab item field by name, case and separator insensitive."""
    want = {n.lower().replace('_', '').replace(' ', '') for n in names}
    for k, v in (meta or {}).items():
        if str(k).lower().replace('_', '').replace(' ', '') in want and v not in (None, ''):
            return str(v)
    return None


def load_lexicon(client, project) -> List[dict]:
    """Every entry of every vocab linked to the project, with the fields the
    prompt shows and its project-wide link count (precedent)."""
    entries = []
    for v in project.get('vocabs') or []:
        vl = client.vocab_layers.get(v['id'], include_items=True)
        for it in vl.get('items') or []:
            meta = it.get('metadata') or {}
            entries.append({
                'id': it['id'], 'form': it.get('form') or '', 'vocab': vl.get('name') or v.get('name') or '',
                'gloss': _field(meta, 'gloss'), 'pos': _field(meta, 'pos', 'part of speech'),
                'type': _field(meta, 'morphType', 'morph type'), 'count': 0,
            })
        try:
            res = client.query({
                'where': [['vocab', '?v', {'layer': v['id']}], ['vocab-link', '?t', '?v']],
                'return': {'group': ['?v'], 'aggregates': [['count']]},
            })
            counts = {row[0]: row[1] for row in (res.get('results') or [])}
            for e in entries:
                e['count'] = counts.get(e['id'], e['count'])
        except Exception as exc:  # precedent is a ranking aid, never a blocker
            print(f'Lexicon precedent unavailable for {v["id"]}: {exc}')
    return entries


def matching_entries(entries, words, budget=DEFAULT_LEXICON_BUDGET) -> List[dict]:
    """Entries whose form occurs inside one of the words (casefolded), most
    linked first, then longest form first."""
    folded = [w.casefold() for w in words]
    hits = []
    for e in entries:
        f = (e['form'] or '').casefold().strip('-=')
        if not f:
            continue
        if any(f in w for w in folded):
            hits.append(e)
    hits.sort(key=lambda e: (-e['count'], -len(e['form']), e['form']))
    return hits[:budget]


def format_entry(e) -> str:
    bits = [e['form'] + ':', e['gloss'] or '?']
    extra = [x for x in (e['type'], e['pos']) if x]
    if extra:
        bits.append('[' + ', '.join(extra) + ']')
    return ' '.join(bits)


# --- retrieval: examples --------------------------------------------------------

def _joiner(morph_type):
    t = (morph_type or '').lower()
    return '=' if 'clitic' in t else '-'


def render_sentence(sentence, gloss_layer_id) -> Optional[str]:
    """A derived sentence as one interleaved line, or None when any word lacks
    a gloss (an example must be complete to teach anything)."""
    items = []
    for w in sentence['words']:
        pieces = []
        for m in w['morphs']:
            gloss = next((sp.get('value') for sl, sp in w['morph_spans'].get(m['id'], [])
                          if sl == gloss_layer_id and sp.get('value')), None)
            if not gloss:
                return None
            meta = m.get('metadata') or {}
            seg = meta.get('form') or w['surface']
            pieces.append((gloss, seg, meta.get('morphType')))
        if not pieces:
            return None
        s = ''
        for k, (gloss, seg, mt) in enumerate(pieces):
            if k:
                prev_mt = pieces[k - 1][2]
                s += '=' if _joiner(mt) == '=' or _joiner(prev_mt) == '=' else '-'
            s += f'{gloss}({seg})'
        items.append(s)
    return ' '.join(items)


def load_examples(client, project_id, layers, gloss_field, translation_field, orthography,
                  exclude_doc_id, max_docs=MAX_EXAMPLE_DOCS, on_progress=None) -> List[dict]:
    """Fully person-analyzed (or verified) sentences from other documents of
    the project: [{text, translation, line, words}]."""
    pool = []
    docs = [d for d in (client.projects.list_documents(project_id) or []) if d['id'] != exclude_doc_id]
    for n, d in enumerate(docs[:max_docs]):
        if on_progress:
            on_progress(n, min(len(docs), max_docs))
        try:
            doc = client.documents.get(d['id'], include_body=True)
            sentences, gloss_layer_id = derive(doc, *layers, gloss_field=gloss_field,
                                               translation_field=translation_field, orthography=orthography)
        except Exception as exc:
            print(f'Skipping document {d["id"]} as an example source: {exc}')
            continue
        for s in sentences:
            if not s['words'] or any(word_state(w) != 'protected' for w in s['words']):
                continue
            line = render_sentence(s, gloss_layer_id)
            if not line:
                continue
            pool.append({'text': ' '.join(w['text'] for w in s['words']),
                         'words': [w['text'].casefold() for w in s['words']],
                         'translation': (s['translation'] or '').strip(), 'line': line})
    return pool


def rank_examples(pool, words, k=DEFAULT_EXAMPLES) -> List[dict]:
    """Most similar examples first: shared word forms (Jaccard) plus character
    similarity of the whole sentence, so inflected variants still count."""
    target = [w.casefold() for w in words]
    tset = set(target)
    tjoined = ' '.join(target)

    def score(ex):
        eset = set(ex['words'])
        jac = len(tset & eset) / len(tset | eset) if (tset | eset) else 0.0
        chars = difflib.SequenceMatcher(None, tjoined, ' '.join(ex['words'])).ratio()
        return 0.7 * jac + 0.3 * chars

    ranked = sorted(pool, key=score, reverse=True)
    return ranked[:k]


# --- prompt --------------------------------------------------------------------------

def build_user_prompt(language, metalanguage, words, translation, entries, examples) -> str:
    parts = [f'Language: {language}. Glosses and translations in {metalanguage}.']
    if entries:
        parts.append('Lexicon entries found in this sentence (form: gloss [type, part of speech]):\n' +
                     '\n'.join('  ' + format_entry(e) for e in entries))
    if examples:
        blocks = []
        for ex in examples:
            b = f'Text: {ex["text"]}'
            if ex['translation']:
                b += f'\nTranslation: {ex["translation"]}'
            b += f'\nGlosses: {ex["line"]}'
            blocks.append(b)
        parts.append('Examples analyzed in this project:\n\n' + '\n\n'.join(blocks))
    tail = f'Now gloss this sentence.\nText: {" ".join(words)}'
    if translation:
        tail += f'\nTranslation: {translation}'
    tail += '\nGlosses:'
    parts.append(tail)
    return '\n\n'.join(parts)


# --- the service ---------------------------------------------------------------

class LLMAnalyzeService(BaseService):
    def __init__(self):
        super().__init__(
            service_id=DEFAULT_SERVICE_ID,
            service_name='LLM glossing',
            description='Proposes morpheme segmentation and glosses with a language model grounded in the '
                        "project's lexicon and analyzed sentences",
            tasks=[TASKS.ANALYZE],
            summary=SUMMARY,
            parameters=[
                Param.string('language', 'Language', required=True, placeholder='e.g. Lezgian',
                             description="The object language's name."),
                Param.string('metalanguage', 'Metalanguage', default='English',
                             description='The language of the glosses and free translations.'),
                Param.string('orthography', 'Orthography', default='', placeholder='baseline',
                             description='Name of a word orthography to send instead of the baseline text.'),
                Param.string('gloss_field', 'Gloss field', default='Gloss',
                             description='The morpheme-scope field that receives the glosses.'),
                Param.string('translation_field', 'Translation field', default='Translation',
                             description='The sentence-scope field holding the free translation.'),
                Param.number('examples', 'Examples per sentence', default=DEFAULT_EXAMPLES,
                             description='How many of the most similar analyzed sentences to show the model.'),
                Param.boolean('overwrite', 'Overwrite human-edited annotations', default=False,
                              description='Also replace analyses a human made or verified.'),
            ],
        )
        self.model: Optional[ChatModel] = None

    # -- CLI --
    def add_arguments(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument('--model', required=True,
                            help='litellm model id, e.g. openai/gpt-4o-mini, anthropic/..., ollama/llama3.1')
        parser.add_argument('--api-base', default=None, help='Provider base URL (OpenAI-compatible servers, proxies)')
        parser.add_argument('--api-key', default=None, help="Provider API key (else the provider's env var)")
        parser.add_argument('--temperature', type=float, default=0.0)
        parser.add_argument('--max-tokens', type=int, default=None)
        parser.add_argument('--service-id', default=None,
                            help=f'Registered service id (default {DEFAULT_SERVICE_ID}); set one per model to run several')
        parser.add_argument('--service-name', default=None, help='Display name (default "LLM glossing (<model>)")')

    def setup(self, args) -> None:
        self.model = ChatModel(args.model, api_base=args.api_base, api_key=args.api_key,
                               temperature=args.temperature, max_tokens=args.max_tokens)
        if args.service_id:
            self.service_id = args.service_id
        self.service_name = args.service_name or f'LLM glossing ({args.model})'
        print(f'Model: {args.model}' + (f' via {args.api_base}' if args.api_base else ''))

    # -- request --
    def process_request(self, request_data: dict, response_helper) -> None:
        document_id = request_data.get('document_id')
        project_id = request_data.get('project_id')
        word_layer_id = request_data.get('word_token_layer_id')
        morph_layer_id = request_data.get('morpheme_token_layer_id')
        sent_layer_id = request_data.get('sentence_token_layer_id')
        for key, val in (('documentId', document_id), ('projectId', project_id),
                         ('wordTokenLayerId', word_layer_id), ('morphemeTokenLayerId', morph_layer_id),
                         ('sentenceTokenLayerId', sent_layer_id)):
            if not val:
                response_helper.error(f'Missing required parameter: {key}')
                return
        language = (request_data.get('language') or '').strip()
        if not language:
            response_helper.error('Missing required option: Language')
            return
        metalanguage = (request_data.get('metalanguage') or '').strip() or 'English'
        orthography = (request_data.get('orthography') or '').strip()
        gloss_field = (request_data.get('gloss_field') or '').strip() or 'Gloss'
        translation_field = (request_data.get('translation_field') or '').strip() or 'Translation'
        overwrite = bool(request_data.get('overwrite', False))
        try:
            n_examples = max(0, int(request_data.get('examples') or DEFAULT_EXAMPLES))
        except (TypeError, ValueError):
            n_examples = DEFAULT_EXAMPLES

        response_helper.progress(2, 'Fetching document...')
        doc = self.client.documents.get(document_id, include_body=True)
        layers = (word_layer_id, morph_layer_id, sent_layer_id)
        try:
            sentences, gloss_layer_id = derive(doc, *layers, gloss_field=gloss_field,
                                               translation_field=translation_field, orthography=orthography)
        except ValueError as e:
            response_helper.error(str(e))
            return

        targets, skipped = select_targets(sentences, overwrite)
        skipped['unaligned'] = 0
        if not targets:
            response_helper.complete({
                'document_id': document_id, 'status': 'success', 'sentences': len(sentences),
                'sentences_sent': 0, 'words_written': 0, 'words_replaced': 0, 'skipped': skipped,
                'message': 'Nothing to analyze: every word is already analyzed by a person.' if skipped['protected']
                else 'Nothing to analyze.',
            })
            return

        # Retrieval, once per run.
        response_helper.progress(5, 'Reading the lexicon...')
        project = self.client.projects.get(project_id)
        tagset = tagset_for(project, gloss_layer_id)
        system = SYSTEM_PROMPT + ('\n\n' + tagset_paragraph(tagset) if tagset else '')
        lexicon = load_lexicon(self.client, project)
        pool = load_examples(
            self.client, project_id, layers, gloss_field, translation_field, orthography,
            exclude_doc_id=document_id,
            on_progress=lambda n, total: response_helper.progress(
                8 + int(12 * n / max(total, 1)), f'Collecting analyzed sentences ({n}/{total} documents)...'),
        ) if n_examples else []

        # One model call per sentence.
        stamp_detail = {**self.model.describe(), 'language': language, 'metalanguage': metalanguage}
        plans = []
        failed = []
        replaced = 0
        total = len(targets)
        for n, (s, idxs) in enumerate(targets):
            response_helper.progress(20 + int(65 * n / total), f'Glossing sentences ({n + 1}/{total})...')
            words = [w['text'] for w in s['words']]
            entries = matching_entries(lexicon, words)
            examples = rank_examples(pool, words, n_examples) if n_examples else []
            prompt = build_user_prompt(language, metalanguage, words, (s['translation'] or '').strip(),
                                       entries, examples)
            try:
                reply = self.model.complete(system, prompt)
            except Exception as exc:
                failed.append({'sentence_id': s['id'], 'reason': f'model error: {exc}'})
                continue
            outputs = parse_interleaved(first_gloss_line(reply))
            if not outputs:
                failed.append({'sentence_id': s['id'], 'reason': 'no glossed line in the reply'})
                continue
            mapping = align_words(words, outputs)
            for i in idxs:
                out = mapping[i]
                if out is None:
                    skipped['unaligned'] += 1
                    continue
                w = s['words'][i]
                plans.append({'word': w, 'analysis': analysis_for(w['text'], out), 'sentence_id': s['id']})
                if w['state'] != 'unanalyzed':
                    replaced += 1

        response_helper.progress(88, 'Writing analyses...')
        source = service_source(self.service_id)
        with self.client.operation(f'LLM glossing ({len(plans)} words)'):
            with self.client.documents.locked(document_id):
                written = write_analyses(self.client, plans, gloss_layer_id, morph_layer_id, source, stamp_detail)

        response_helper.progress(100, 'Done')
        response_helper.complete({
            'document_id': document_id, 'status': 'success',
            'sentences': len(sentences), 'sentences_sent': total,
            'words_written': written, 'words_replaced': replaced,
            'skipped': skipped, 'sentences_failed': failed,
            'lexicon_entries': len(lexicon), 'example_sentences': len(pool),
            'tagset': tagset['name'] if tagset else None,
        })


def main():
    LLMAnalyzeService().run()


if __name__ == '__main__':
    main()
