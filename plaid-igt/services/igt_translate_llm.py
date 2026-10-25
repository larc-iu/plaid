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
from typing import Dict, Optional

from plaid_client import BaseService, TASKS, Param, service_source
from plaid_client.service import PhasedProgress, held_run, machine_detail, requester_message
from plaid_client.workflows.requester import requester_of
from plaid_client.workflows.llm import (ChatModel, UnansweredRun,
                                        add_model_arguments, setup_service)
from plaid_client.metadata_ops import metadata_ops
from plaid_client.provenance import PROVENANCE_KEYS, stamp_inferred, prov_state, MACHINE
from plaid_client.workflows.igt import NoGlossField, derive, field_layer_id, gloss_of

DEFAULT_SERVICE_ID = 'llm-translator'
DEFAULT_CONTEXT = 2
WRITE_CHUNK = 400  # sentences per atomic batch, one bulk update and one bulk create

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
            gloss = (gloss_of(w, m, gloss_layer_id) or {}).get('value')
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

def sentence_state(span) -> str:
    """'empty' | 'machine' | 'protected' for a sentence's translation span."""
    if not span or (span.get('value') or '') == '':
        return 'empty'
    state = prov_state(span.get('metadata'))
    return 'machine' if state == MACHINE else 'protected'


# --- the service ---------------------------------------------------------------


def translation_result(document_id, sentences, skipped, *, written=0, replaced=0, failed=(),
                       not_asked=(), gloss_missing=None):
    """The result of a ``translate`` run, in one shape (the core manual,
    "Service results"): the app words what the person is told from it.
    ``skipped`` counts sentences left alone, ``protected`` (a person's
    translation, Overwrite off) and ``empty`` (no words). ``failed`` names
    each sentence the model could not translate as ``{'sentence_id',
    'reason'}``, ``not_asked`` lists the ids of the sentences never sent
    because the model stopped answering, and ``gloss_missing`` is the gloss field the request named
    and the document lacks, read for context only."""
    return {
        'document_id': document_id, 'status': 'success', 'sentences': sentences,
        'sentences_written': written, 'sentences_replaced': replaced,
        'skipped': {'protected': 0, 'empty': 0, **skipped}, 'sentences_failed': list(failed),
        'sentences_not_asked': list(not_asked),
        'gloss_field_missing': gloss_missing,
    }

class TranslateProgress(PhasedProgress):
    """The bar's stretch for translating the sentences."""

    TRANSLATE = (5, 85)


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
                Param.field('translation_field', 'Translation field', 'Sentence', role='translation',
                            required=True, description='The sentence-scope field that receives the drafts.'),
                Param.boolean('use_glosses', 'Use glosses', default=True,
                              description="Show the model the sentence's morpheme glosses."),
                Param.field('gloss_field', 'Gloss field', 'Morpheme', role='gloss',
                            description='The morpheme-scope field holding the glosses.'),
                Param.number('context', 'Context sentences', default=DEFAULT_CONTEXT, min=0,
                             description='How many preceding sentences to show the model.'),
                Param.boolean('overwrite', 'Overwrite human-edited translations', default=False,
                              description='Also replace translations a person wrote or verified.'),
            ],
        )
        self.model: Optional[ChatModel] = None

    # -- CLI --
    def add_arguments(self, parser: argparse.ArgumentParser) -> None:
        add_model_arguments(parser, default_service_id=DEFAULT_SERVICE_ID)

    def setup(self, args) -> None:
        setup_service(self, args)

    # -- request --
    def process_request(self, request_data: dict, response_helper) -> None:
        document_id = request_data.get('document_id')
        requester = requester_of(self.client, request_data)
        progress = TranslateProgress(response_helper)
        word_layer_id = request_data.get('word_token_layer_id')
        morph_layer_id = request_data.get('morpheme_token_layer_id')
        sent_layer_id = request_data.get('sentence_token_layer_id')
        for key, val in (('documentId', document_id), ('wordTokenLayerId', word_layer_id),
                         ('morphemeTokenLayerId', morph_layer_id), ('sentenceTokenLayerId', sent_layer_id)):
            if not val:
                response_helper.error(f'Missing required parameter: {key}')
                return
        language = request_data['language'].strip()
        if not language:
            response_helper.error('Missing required option: Language')
            return
        metalanguage = request_data['metalanguage'].strip()
        orthography = request_data['orthography'].strip()
        # The fields come from the request, never from a name: the translation
        # field is the one written, and one left out is an error. The gloss
        # field is context, read only when one is named.
        translation_field = request_data['translation_field'].strip()
        if not translation_field:
            response_helper.error('Choose the translation field.')
            return
        use_glosses = request_data['use_glosses']
        gloss_field = request_data['gloss_field'].strip() or None
        overwrite = request_data['overwrite']
        n_context = int(request_data['context'])

        # The document is held from the read the run plans from through the
        # last write, so no edit can land while the model works (one rule for
        # every service, Luke's ruling R15). The result goes once it is let go.
        with held_run(self.client, response_helper, document_id) as run:
            response_helper.progress(3, 'Fetching document…')
            doc = self.client.documents.get(document_id, include_body=True)
            layers = (word_layer_id, morph_layer_id, sent_layer_id)
            gloss_layer_id = None
            # The glosses are context only, so a run goes on without them, and says
            # so rather than translating a little worse without a word.
            gloss_missing = None
            try:
                try:
                    sentences, gloss_layer_id = derive(doc, *layers, gloss_field=gloss_field if use_glosses else None,
                                                       translation_field=translation_field, orthography=orthography)
                except NoGlossField:
                    # No such gloss field: translate from the words alone.
                    gloss_missing = gloss_field
                    sentences, _ = derive(doc, *layers, gloss_field=None,
                                          translation_field=translation_field, orthography=orthography)
            except ValueError as e:
                run.refusal = str(e)
                return
            # The field derive read the translations from, by the same rule.
            tr_layer_id = field_layer_id(doc, sent_layer_id, translation_field, 'Sentence')
            if not tr_layer_id:
                run.refusal = (f'No sentence-scope field named "{translation_field}". Set the Translation '
                               'field parameter to one of the project\'s sentence fields.')
                return

            # Targets under the write contract.
            skipped = {'protected': 0, 'empty': 0}
            targets = []  # (index, sentence, existing span or None)
            for i, s in enumerate(sentences):
                if not s['words']:
                    skipped['empty'] += 1
                    continue
                span = s['translation_span']
                st = sentence_state(span)
                if st == 'protected' and not overwrite:
                    skipped['protected'] += 1
                    continue
                targets.append((i, s, span if st != 'empty' else None))
            if not targets:
                run.result = translation_result(document_id, len(sentences), skipped,
                                                gloss_missing=gloss_missing)
                return

            # One model call per sentence, in document order so earlier drafts can
            # serve as context for later sentences.
            source = service_source(self.service_id)
            base_detail = requester.detail(machine_detail(self.version, **self.model.describe(),
                                                          language=language, metalanguage=metalanguage))
            drafts: Dict[str, str] = {}
            plans = []  # (sentence, existing span or None, text)
            failed = []
            not_asked = []
            # A model that does not answer at all is down: the run stops after two
            # sentences in a row get no answer, rather than wait out a deadline on
            # every sentence with the document locked.
            unanswered = UnansweredRun()
            for n, (i, s, span) in enumerate(targets):
                progress.count(TranslateProgress.TRANSLATE, n, len(targets),
                               f'Translating sentences ({n + 1}/{len(targets)})…')
                words = [w['text'] for w in s['words']]
                context = []
                for c in sentences[max(0, i - n_context):i]:
                    if not c['words']:
                        continue
                    context.append({'text': ' '.join(w['text'] for w in c['words']),
                                    'translation': drafts.get(c['id']) or (c['translation'] or '').strip()})
                prompt = build_user_prompt(language, metalanguage, words, gloss_line(s, gloss_layer_id), context)
                try:
                    reply = self.model.complete(
                        SYSTEM_PROMPT.format(language=language, metalanguage=metalanguage), prompt,
                        should_stop=lambda: response_helper.cancelled)
                except Exception as exc:
                    # The provider's own error text is the operator's: it can carry
                    # the endpoint, the request body, and the key that was refused.
                    print(f'Model call failed for sentence {s["id"]}: {exc}')
                    failed.append({'sentence_id': s['id'],
                                   'reason': f'model error: {requester_message(exc, secrets=self.REQUEST_SECRETS)}'})
                    if unanswered.failed(exc):
                        untried = [t[1]['id'] for t in targets[n + 1:]]
                        ended = unanswered.stop_line(len(untried), verb='translated')
                        if untried:
                            print(f'{ended} Not asked: {", ".join(untried)}')
                        not_asked = untried
                        break
                    continue
                unanswered.answered()
                if reply.truncated:
                    # Half a translation reads like a whole one. A draft the model
                    # did not finish is not written at all.
                    failed.append({'sentence_id': s['id'],
                                   'reason': 'the reply was cut off at the token limit'})
                    continue
                text = first_line(reply.text)
                if not text:
                    failed.append({'sentence_id': s['id'], 'reason': 'empty reply'})
                    continue
                drafts[s['id']] = text
                plans.append((s, span, text))

            print(self.model.usage_line())
            response_helper.progress(88, 'Writing translations…')
            replaced = 0
            # The writes cannot be stopped once begun.
            with response_helper.critical():
                with self.client.operation(requester.label(f'LLM translation ({len(plans)} sentences)'),
                                           kind='service-run', ref=service_source(self.service_id)):
                    # Per chunk, one bulk update of the translations already
                    # there and one bulk create of the new ones, in one batch.
                    # A replaced span's metadata is patched: the provenance
                    # keys become the new stamp's, and every other key on it
                    # (a comment anchor, another app's) stays.
                    for start in range(0, len(plans), WRITE_CHUNK):
                        updates, creates = [], []
                        for s, span, text in plans[start:start + WRITE_CHUNK]:
                            stamp = stamp_inferred(source, detail={**base_detail, 'value': text})
                            if span:
                                stored = span.get('metadata') or {}
                                gone = {k: None for k in PROVENANCE_KEYS if k in stored}
                                updates.append({'id': span['id'], 'value': text,
                                                'metadata': metadata_ops({**gone, **stamp})})
                            else:
                                creates.append({'span_layer_id': tr_layer_id, 'tokens': [s['id']],
                                                'value': text, 'metadata': stamp})
                        with self.client.batched() as b:
                            if updates:
                                b.spans.bulk_update(updates)
                            if creates:
                                b.spans.bulk_create(creates)
                        replaced += len(updates)

            run.result = translation_result(document_id, len(sentences), skipped,
                                            written=len(plans), replaced=replaced, failed=failed,
                                            not_asked=not_asked,
                                            gloss_missing=gloss_missing)


def main():
    LLMTranslateService().run()


if __name__ == '__main__':
    main()
