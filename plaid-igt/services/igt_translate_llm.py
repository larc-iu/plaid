"""
LLM translation service

Drafts a free translation for every sentence of a document with any chat
model litellm can reach (OpenAI, Anthropic, Gemini, Ollama, vLLM, any
OpenAI-compatible server). Serves the `translate` task: step 1 of the IGT
app's Auto-analyze dialog, ahead of the analyzers, which take the free
translation as input.

Per sentence the prompt carries the words (baseline or a named orthography),
the sentence's morpheme glosses when it has any (the interlinear line is most
of a translation already, and keeps the translation consistent with the
analysis), and the preceding sentences with their translations as discourse
context. One span per sentence is written in the sentence-scope translation
field, stamped machine-made with the recorded prediction (`provDetail.value`);
no `provProb`, since a chat model gives no calibrated probability.

Write contract (the provenance convention), per sentence:
  * a sentence with no translation is always written;
  * a machine-made, unverified translation is REPLACED;
  * a translation a person wrote or verified is skipped unless `overwrite`.

The provider is chosen at launch, exactly as for the LLM glossing service:

    python services/igt_translate_llm.py --url http://localhost:8085 --model openai/gpt-oss-120b
    python services/igt_translate_llm.py --url ... --model ollama/llama3.1

Requirements (on top of plaid-client): litellm.
"""

import argparse
from typing import Any, Dict, List, Optional

from plaid_client import BaseService, TASKS, Param, service_source
from plaid_client.provenance import stamp_inferred, prov_state, MACHINE, HUMAN
from plaid_client.workflows.igt import derive

DEFAULT_SERVICE_ID = 'llm-translator'
DEFAULT_CONTEXT = 2
WRITE_CHUNK = 400  # ops per atomic batch (the server caps a batch at 1000)

SUMMARY = """\
**LLM translation** drafts a free translation for every sentence of the
document with a language model, from the words, the sentence's morpheme
glosses when it has any, and the preceding sentences as context.

- **Language** / **Metalanguage**: the object language's name and the
  language to translate into.
- **Orthography**: leave blank to send the baseline text; name a word
  orthography to send that instead.
- **Translation field**: the sentence-scope field that receives the drafts.
- **Use glosses** / **Gloss field**: show the model the sentence's morpheme
  glosses, which it must stay consistent with.
- **Context sentences**: how many preceding sentences to show.
- **Overwrite human-edited translations**: by default the service only writes
  sentences with no translation or with a machine draft nobody has confirmed.

Every draft is stamped machine-made and shows as unverified (violet) until a
person edits it or confirms it with Ctrl+Enter.
"""

SYSTEM_PROMPT = """\
You are a careful translator on a language documentation project. Translate
the given sentence from {language} into {metalanguage}. When morpheme glosses
are given they are authoritative: the translation must be consistent with
them. Preceding sentences are context only. Output exactly one line: the
translation, nothing else (no quotation marks, no label, no commentary)."""


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


def first_line(text: str) -> str:
    """The translation out of a reply that may carry a label, quotes or prose."""
    for line in (text or '').splitlines():
        s = line.strip().strip('`')
        if not s:
            continue
        low = s.lower()
        if low.startswith('translation:'):
            s = s[len('translation:'):].strip()
        if len(s) >= 2 and s[0] in '"“\'' and s[-1] in '"”\'':
            s = s[1:-1].strip()
        if s:
            return s
    return ''


# --- what the prompt sees ------------------------------------------------------

def gloss_line(sentence, gloss_layer_id) -> Optional[str]:
    """The sentence's morpheme glosses as an interleaved line, unglossed
    morphemes shown as ?(segment); None when no word has any gloss."""
    if not gloss_layer_id:
        return None
    items = []
    any_gloss = False
    for w in sentence['words']:
        pieces = []
        for m in w['morphs']:
            gloss = next((sp.get('value') for sl, sp in w['morph_spans'].get(m['id'], [])
                          if sl == gloss_layer_id and sp.get('value')), None)
            seg = (m.get('metadata') or {}).get('form') or w['surface']
            if gloss:
                any_gloss = True
            pieces.append(f'{gloss or "?"}({seg})')
        items.append('-'.join(pieces) if pieces else f'?({w["text"]})')
    return ' '.join(items) if any_gloss else None


def build_user_prompt(language, metalanguage, words, glosses, context) -> str:
    parts = [f'Language: {language}. Translate into {metalanguage}.']
    if context:
        blocks = []
        for c in context:
            b = f'Text: {c["text"]}'
            if c.get('translation'):
                b += f'\nTranslation: {c["translation"]}'
            blocks.append(b)
        parts.append('Preceding sentences:\n' + '\n'.join(blocks))
    tail = f'Now translate this sentence.\nText: {" ".join(words)}'
    if glosses:
        tail += f'\nGlosses: {glosses}'
    tail += '\nTranslation:'
    parts.append(tail)
    return '\n\n'.join(parts)


# --- the translation field and its write contract ------------------------------

def translation_spans(doc, sentence_layer_id, translation_field):
    """-> (span layer id or None, {sentence token id: span}) for the
    sentence-scope field named `translation_field`."""
    for tl in doc.get('text_layers', []):
        for tk in tl.get('token_layers', []):
            if tk['id'] != sentence_layer_id:
                continue
            for sl in tk.get('span_layers', []):
                if sl['name'] != translation_field:
                    continue
                scope = ((sl.get('config') or {}).get('igt') or {}).get('scope')
                if scope not in (None, 'Sentence'):
                    continue
                by_sentence = {}
                for sp in sl.get('spans', []):
                    for tid in sp.get('tokens') or []:
                        by_sentence[tid] = sp
                return sl['id'], by_sentence
    return None, {}


def sentence_state(span) -> str:
    """'empty' | 'machine' | 'protected' for a sentence's translation span."""
    if not span or (span.get('value') or '') == '':
        return 'empty'
    state = prov_state(span.get('metadata'))
    return 'machine' if state == MACHINE else 'protected'


# --- the service ---------------------------------------------------------------

class LLMTranslateService(BaseService):
    def __init__(self):
        super().__init__(
            service_id=DEFAULT_SERVICE_ID,
            service_name='LLM translation',
            description='Drafts a free translation for every sentence with a language model',
            tasks=[TASKS.TRANSLATE],
            summary=SUMMARY,
            parameters=[
                Param.string('language', 'Language', required=True, placeholder='e.g. Lezgian',
                             description="The object language's name."),
                Param.string('metalanguage', 'Metalanguage', default='English',
                             description='The language to translate into.'),
                Param.string('orthography', 'Orthography', default='', placeholder='baseline',
                             description='Name of a word orthography to send instead of the baseline text.'),
                Param.string('translation_field', 'Translation field', default='Translation',
                             description='The sentence-scope field that receives the drafts.'),
                Param.boolean('use_glosses', 'Use glosses', default=True,
                              description="Show the model the sentence's morpheme glosses."),
                Param.string('gloss_field', 'Gloss field', default='Gloss',
                             description='The morpheme-scope field holding the glosses.'),
                Param.number('context', 'Context sentences', default=DEFAULT_CONTEXT,
                             description='How many preceding sentences to show the model.'),
                Param.boolean('overwrite', 'Overwrite human-edited translations', default=False,
                              description='Also replace translations a person wrote or verified.'),
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
        parser.add_argument('--service-name', default=None, help='Display name (default "LLM translation (<model>)")')

    def setup(self, args) -> None:
        self.model = ChatModel(args.model, api_base=args.api_base, api_key=args.api_key,
                               temperature=args.temperature, max_tokens=args.max_tokens)
        if args.service_id:
            self.service_id = args.service_id
        self.service_name = args.service_name or f'LLM translation ({args.model})'
        print(f'Model: {args.model}' + (f' via {args.api_base}' if args.api_base else ''))

    # -- request --
    def process_request(self, request_data: dict, response_helper) -> None:
        document_id = request_data.get('document_id')
        word_layer_id = request_data.get('word_token_layer_id')
        morph_layer_id = request_data.get('morpheme_token_layer_id')
        sent_layer_id = request_data.get('sentence_token_layer_id')
        for key, val in (('documentId', document_id), ('wordTokenLayerId', word_layer_id),
                         ('morphemeTokenLayerId', morph_layer_id), ('sentenceTokenLayerId', sent_layer_id)):
            if not val:
                response_helper.error(f'Missing required parameter: {key}')
                return
        language = (request_data.get('language') or '').strip()
        if not language:
            response_helper.error('Missing required option: Language')
            return
        metalanguage = (request_data.get('metalanguage') or '').strip() or 'English'
        orthography = (request_data.get('orthography') or '').strip()
        translation_field = (request_data.get('translation_field') or '').strip() or 'Translation'
        use_glosses = bool(request_data.get('use_glosses', True))
        gloss_field = (request_data.get('gloss_field') or '').strip() or 'Gloss'
        overwrite = bool(request_data.get('overwrite', False))
        try:
            n_context = max(0, int(request_data.get('context') or 0))
        except (TypeError, ValueError):
            n_context = DEFAULT_CONTEXT

        response_helper.progress(3, 'Fetching document...')
        doc = self.client.documents.get(document_id, include_body=True)
        layers = (word_layer_id, morph_layer_id, sent_layer_id)
        gloss_layer_id = None
        try:
            try:
                sentences, gloss_layer_id = derive(doc, *layers, gloss_field=gloss_field if use_glosses else None,
                                                   translation_field=translation_field, orthography=orthography)
            except ValueError as e:
                if not use_glosses or 'morpheme-scope field' not in str(e):
                    raise
                # No such gloss field: translate from the words alone.
                sentences, _ = derive(doc, *layers, gloss_field=None,
                                      translation_field=translation_field, orthography=orthography)
        except ValueError as e:
            response_helper.error(str(e))
            return
        tr_layer_id, existing = translation_spans(doc, sent_layer_id, translation_field)
        if not tr_layer_id:
            response_helper.error(f'No sentence-scope field named "{translation_field}" — set the Translation '
                                  'field parameter to one of the project\'s sentence fields.')
            return

        # Targets under the write contract.
        skipped = {'protected': 0, 'empty': 0}
        targets = []  # (index, sentence, existing span or None)
        for i, s in enumerate(sentences):
            if not s['words']:
                skipped['empty'] += 1
                continue
            span = existing.get(s['id'])
            st = sentence_state(span)
            if st == 'protected' and not overwrite:
                skipped['protected'] += 1
                continue
            targets.append((i, s, span if st != 'empty' else None))
        if not targets:
            response_helper.complete({
                'document_id': document_id, 'status': 'success', 'sentences': len(sentences),
                'sentences_written': 0, 'sentences_replaced': 0, 'skipped': skipped,
                'message': 'Nothing to translate: every sentence already has a translation by a person.'
                if skipped['protected'] else 'Nothing to translate.',
            })
            return

        # One model call per sentence, in document order so earlier drafts can
        # serve as context for later sentences.
        source = service_source(self.service_id)
        base_detail = {**self.model.describe(), 'language': language, 'metalanguage': metalanguage}
        drafts: Dict[str, str] = {}
        plans = []  # (sentence, existing span or None, text)
        failed = []
        for n, (i, s, span) in enumerate(targets):
            response_helper.progress(5 + int(80 * n / len(targets)), f'Translating sentences ({n + 1}/{len(targets)})...')
            words = [w['text'] for w in s['words']]
            context = []
            for c in sentences[max(0, i - n_context):i]:
                if not c['words']:
                    continue
                context.append({'text': ' '.join(w['text'] for w in c['words']),
                                'translation': drafts.get(c['id']) or (c['translation'] or '').strip()})
            prompt = build_user_prompt(language, metalanguage, words, gloss_line(s, gloss_layer_id), context)
            try:
                text = first_line(self.model.complete(SYSTEM_PROMPT.format(language=language, metalanguage=metalanguage), prompt))
            except Exception as exc:
                failed.append({'sentence_id': s['id'], 'reason': f'model error: {exc}'})
                continue
            if not text:
                failed.append({'sentence_id': s['id'], 'reason': 'empty reply'})
                continue
            drafts[s['id']] = text
            plans.append((s, span, text))

        response_helper.progress(88, 'Writing translations...')
        replaced = 0
        with self.client.operation(f'LLM translation ({len(plans)} sentences)'):
            with self.client.documents.locked(document_id):
                for start in range(0, len(plans), WRITE_CHUNK // 2):
                    with self.client.batched():
                        for s, span, text in plans[start:start + WRITE_CHUNK // 2]:
                            stamp = stamp_inferred(source, detail={**base_detail, 'value': text})
                            if span:
                                self.client.spans.update(span['id'], text)
                                self.client.spans.set_metadata(span['id'], stamp)
                                replaced += 1
                            else:
                                self.client.spans.create(tr_layer_id, [s['id']], text, stamp)

        response_helper.progress(100, 'Done')
        response_helper.complete({
            'document_id': document_id, 'status': 'success', 'sentences': len(sentences),
            'sentences_written': len(plans), 'sentences_replaced': replaced,
            'skipped': skipped, 'sentences_failed': failed,
        })


def main():
    LLMTranslateService().run()


if __name__ == '__main__':
    main()
