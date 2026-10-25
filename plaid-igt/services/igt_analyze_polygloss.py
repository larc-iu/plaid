"""
PolyGloss analysis service

Proposes a morpheme segmentation and morpheme glosses for the words of a
document with PolyGloss (Ginn et al. 2026, https://github.com/lecs-lab/polygloss),
a ByT5 seq2seq model that jointly segments and glosses a sentence given its
transcription and free translation. Serves the `analyze` task.

What it writes, per word it is allowed to touch: the morpheme chain (the
word's existing default morpheme becomes the first slot, further slots are
created; `metadata.form` carries the segment, `metadata.morphType` the clitic
side of a `=` boundary) and one span per morpheme in the morpheme-scope gloss
field. Everything is stamped machine-made (`prov`/`provSource`/`provDetail`)
and renders as unverified in the editor until a person confirms it. The
prediction itself is kept in `provDetail` (`form` on each morpheme, `value` on
each gloss span, plus the model and the `boundaries` string on the first
morpheme) so that, after a person verifies or corrects it, what the model
originally said is still on the row. PolyGloss decodes with a small beam and
exposes no probabilities, so no `provProb` / `valueProbs` are written.

Write contract (the provenance convention):
  * unanalyzed words are always written;
  * words whose analysis is entirely machine-made and unverified are REPLACED,
    except one copied from precedent (Auto-analyze's copy step), which is
    skipped unless the `overwrite` parameter is set;
  * words with any human-made or human-verified piece of morpheme analysis
    (a segmentation, or a span or link on a morpheme) are skipped unless the
    `overwrite` parameter is set. Word-scope fields such as a word gloss are
    never written, so they protect nothing;
  * words the request names in `skip_word_ids` are never written, whatever
    `overwrite` says (Auto-analyze names the words its copy step wrote in the
    same run). Declared in the self-description as `request_fields`.

The model's output is whitespace-aligned to the input words only when it
behaves. The bookkeeping and mending live in `plaid_client.workflows.igt`
(derive the document, apply the write contract, parse the interleaved output,
align output words to input words allowing dropped/inserted/merged words,
degrade unparsable words to a single morpheme carrying the joined gloss, write
in budgeted batches); this file is the model, its prompt, and the continuation
passes over the untranscribed tail of a truncated generation. The unit of
writing is the word: unaligned words are simply left alone and reported.

Requirements (on top of plaid-client): torch, transformers (>=4.51), and
peft only when launching with --adapter. A GPU is assumed for whole-document
runs; CPU works but is many times slower.
"""

import argparse
from typing import Dict, List, Optional, Tuple

from plaid_client import BaseService, TASKS, Param
from plaid_client.workflows.igt import (
    ParsedWord, parse_interleaved, align_words, analysis_for,
    ANALYZE_REQUEST_FIELDS,
)
from plaid_client.workflows.igt.analyze import (AnalysisProgress, begin_analysis, finish_analysis,
                                                read_analysis_request)

DEFAULT_MODEL = 'lecslab/polygloss-byt5-interleaved-2025-12-28'

# The prompt PolyGloss was trained with (src/dataset/polygloss.interleaved.t2sg.prompt).
PROMPT = (
    'Predict the glosses and morphological segmentation (in parentheses) for the following text in {lang}.\n'
    '\n'
    'Text in {lang}: {transcription}\n'
    'Translation in {metalang}: {translation}\n'
    '\n'
    'Output: '
)
MAX_NEW_TOKENS = 1024  # ByT5 tokens are bytes
MAX_CONTINUATIONS = 2  # extra passes over the tail of a truncated sentence

SUMMARY = """\
**PolyGloss** (Ginn et al. 2026) proposes a morpheme **segmentation** and
**glosses** for every word of the document in one pass, from the words and each
sentence's free translation. It is a single multilingual model trained on IGT
from ~2,000 languages; results are best for languages it has seen. The model
reads each word in the baseline, and the morphemes are written in the baseline.

- **Language** / **Metalanguage**: the object language's name as the model
  would know it (e.g. `Lezgian`) and the translation's language.
- **Gloss field**: the morpheme-scope field that receives the glosses.
- **Overwrite human-edited annotations**: by default the service only writes
  words that have no analysis yet or whose analysis is entirely machine-made
  and unverified, other than one copied from a previous analysis. Enable this
  to replace copied, human-made and human-verified analyses too (their
  morphemes, every morpheme field, and links are discarded).

Everything it writes is stamped machine-made and shows as unverified until a
person confirms it (edit, ✓, or Ctrl+Enter on the word).
"""


# --- model -----------------------------------------------------------------

class PolyGlossModel:
    def __init__(self, model_id, adapter=None, dtype='bf16', device=None, batch_size=16, num_beams=2):
        self.model_id = model_id
        self.adapter = adapter
        self.dtype_name = dtype
        self.device = device
        self.batch_size = batch_size
        self.num_beams = num_beams
        self._model = None
        self._tok = None

    def load(self):
        if self._model is not None:
            return
        import torch
        import transformers
        dtype = {'bf16': torch.bfloat16, 'fp16': torch.float16, 'fp32': torch.float32}[self.dtype_name]
        device = self.device or ('cuda' if torch.cuda.is_available() else 'cpu')
        if device == 'cpu' and dtype is not torch.float32:
            print('CPU inference: using fp32')
            dtype = torch.float32
        print(f'Loading {self.model_id} ({self.dtype_name}) on {device}...')
        self._tok = transformers.AutoTokenizer.from_pretrained(self.model_id, use_fast=False)
        model = transformers.AutoModelForSeq2SeqLM.from_pretrained(
            self.model_id, trust_remote_code=True, dtype=dtype)
        if self.adapter:
            from peft import PeftModel
            print(f'Loading adapter {self.adapter}...')
            model = PeftModel.from_pretrained(model, self.adapter)
        self._model = model.to(device).eval()
        print('Model ready.')

    def describe(self):
        d = {'model': self.model_id}
        if self.adapter:
            d['adapter'] = self.adapter
        return d

    def predict(self, prompts: List[str], on_batch=None) -> List[Tuple[str, bool]]:
        """-> [(text, truncated)] in input order.

        Prompts are batched by length (longest first) rather than in document
        order: a batch decodes until its longest output finishes, so mixing one
        long sentence with short ones wastes most of the batch. Results are
        restored to input order."""
        import torch
        self.load()
        order = sorted(range(len(prompts)), key=lambda i: -len(prompts[i]))
        out: List[Optional[Tuple[str, bool]]] = [None] * len(prompts)
        total = (len(prompts) + self.batch_size - 1) // self.batch_size
        for b in range(0, len(order), self.batch_size):
            idxs = order[b:b + self.batch_size]
            enc = self._tok([prompts[i] for i in idxs], return_tensors='pt', padding=True).to(self._model.device)
            with torch.no_grad():
                gen = self._model.generate(**enc, max_new_tokens=MAX_NEW_TOKENS,
                                           num_beams=self.num_beams, do_sample=False)
            texts = self._tok.batch_decode(gen, skip_special_tokens=True)
            for i, row, text in zip(idxs, gen, texts):
                truncated = (row == self._tok.eos_token_id).sum().item() == 0
                out[i] = (text, truncated)
            if on_batch:
                on_batch(b // self.batch_size + 1, total)
        return out  # type: ignore[return-value]


# --- the service ---------------------------------------------------------------

class AnalyzeProgress(AnalysisProgress):
    """The bar's stretches for the first pass over the sentences and the
    continuations of the ones cut short."""

    ANALYZE, CONTINUE = (15, 80), (80, 88)


class PolyGlossService(BaseService):
    def __init__(self):
        super().__init__(
            service_id='polygloss-analyzer',
            service_name='PolyGloss',
            description='Proposes morpheme segmentation and glosses for every word with the PolyGloss model',
            tasks=[TASKS.ANALYZE],
            summary=SUMMARY,
            extras={'request_fields': ANALYZE_REQUEST_FIELDS},
            parameters=[
                Param.string('language', 'Language', required=True, placeholder='e.g. Lezgian',
                             description="The object language's name as the model would know it."),
                Param.string('metalanguage', 'Metalanguage', default='English',
                             description="The language of the free translations."),
                Param.field('gloss_field', 'Gloss field', 'Morpheme', role='gloss', required=True,
                            description='The morpheme-scope field that receives the glosses.'),
                Param.field('translation_field', 'Translation field', 'Sentence', role='translation',
                            description='The sentence-scope field holding the free translation.'),
                Param.boolean('overwrite', 'Overwrite human-edited annotations', default=False,
                              description='Also replace copied analyses and ones a person made or verified.'),
            ],
        )
        self.model: Optional[PolyGlossModel] = None

    # -- CLI --
    def add_arguments(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument('--model', default=DEFAULT_MODEL, help='HF model id or local path')
        parser.add_argument('--adapter', default=None, help='PEFT/LoRA adapter directory (fine-tuned)')
        parser.add_argument('--dtype', default='bf16', choices=['bf16', 'fp16', 'fp32'])
        parser.add_argument('--device', default=None, help='cuda | cpu (default: auto)')
        parser.add_argument('--batch-size', type=int, default=16)
        parser.add_argument('--num-beams', type=int, default=2)
        parser.add_argument('--lazy', action='store_true', help='Load the model on first request, not at startup')

    def setup(self, args) -> None:
        self.model = PolyGlossModel(args.model, adapter=args.adapter, dtype=args.dtype,
                                    device=args.device, batch_size=args.batch_size,
                                    num_beams=args.num_beams)
        if not args.lazy:
            self.model.load()

    # -- request --
    def process_request(self, request_data: dict, response_helper) -> None:
        request = read_analysis_request(self.client, request_data, response_helper, language=True)
        if request is None:
            return
        progress = AnalyzeProgress(response_helper)
        language, metalanguage = request.language, request.metalanguage

        with begin_analysis(self.client, response_helper, request, fetch_percent=3) as run:
            # Eligible sentences: any word we may write (the write contract).
            if run is None or not run.choose_targets():
                return
            targets, skipped = run.targets, run.skipped

            # Generate, with continuation passes for truncated tails.
            stamp_detail = self.stamp_detail(request.requester, **self.model.describe(),
                                             language=language, metalanguage=metalanguage)
            aligned: Dict[str, List[Optional[ParsedWord]]] = {}  # sentence id -> per input word
            pending = [(s, 0) for s, _ in targets]  # (sentence, first word index still to transcribe)
            for s, _ in targets:
                aligned[s['id']] = [None] * len(s['words'])
            passes = 0
            failed = []
            while pending and passes <= MAX_CONTINUATIONS:
                prompts = []
                for s, start in pending:
                    transcription = ' '.join(w['surface'] for w in s['words'][start:])
                    translation = (s['translation'] or '').strip() or 'None'
                    prompts.append(PROMPT.format(lang=language, metalang=metalanguage,
                                                 transcription=transcription, translation=translation))
                phase = AnalyzeProgress.ANALYZE if passes == 0 else AnalyzeProgress.CONTINUE

                def on_batch(done, total):
                    progress.count(phase, done, total, f'Analyzing sentences ({done}/{total} batches)…')
                results = self.model.predict(prompts, on_batch=on_batch)
                next_pending = []
                for (s, start), (text, truncated) in zip(pending, results):
                    outputs = parse_interleaved(text)
                    surfaces = [w['surface'] for w in s['words'][start:]]
                    if not outputs:
                        failed.append({'sentence_id': s['id'], 'reason': 'empty output'})
                        continue
                    mapping = align_words(surfaces, outputs)
                    for k, out in enumerate(mapping):
                        aligned[s['id']][start + k] = out
                    if truncated:
                        last = max((k for k, o in enumerate(mapping) if o is not None), default=-1)
                        tail_start = start + last + 1
                        if tail_start < len(s['words']):
                            next_pending.append((s, tail_start))
                pending = next_pending
                passes += 1

            # Plan writes.
            plans = []
            replaced = 0
            for s, idxs in targets:
                for i in idxs:
                    w = s['words'][i]
                    out = aligned[s['id']][i]
                    if out is None:
                        skipped['unaligned'] += 1
                        continue
                    plans.append({'word': w, 'analysis': analysis_for(w['surface'], out), 'sentence_id': s['id']})
                    if w['state'] != 'unanalyzed':
                        replaced += 1

            finish_analysis(self.client, response_helper, run, plans, service_id=self.service_id,
                            label='PolyGloss analysis', stamp_detail=stamp_detail, replaced=replaced,
                            failed=failed)


def main():
    PolyGlossService().run()


if __name__ == '__main__':
    main()
