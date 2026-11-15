"""``plaid-job-worker``: the process that runs a server's unattended jobs.

The operator runs one, under an administrator's named API token (``.token``
in the working folder, as the services read theirs), with the model of their
choice (CONTRACT 11)::

    plaid-job-worker --url URL --model MODEL --api-base BASE --context-window N
        --model-pool NAME [--timeout S] [--max-output-tokens N] [--trace-dir DIR] [--apps igt]

It asks for a job every 30 seconds, runs one at a time (``core.job``) and
writes as the person who started each, with the token core mints for them.
``--model-pool`` names the model key it shares with the services, so it waits
while people use the model; without it, it yields to nothing and says so.
``--trace-dir`` keeps every model call of every stretch on this machine's
disk, the only place a job's transcripts go (the owner, SPEC question 2).

``--scripted-model PATH`` answers every model call from a file instead of a
model, for tests and a rehearsal on a sandbox: a JSON list of replies in
order, each ``{"content": "Done."}`` or ``{"calls": [{"name": ..., "arguments":
{...}}]}``, the last one given again once the list runs out. A reply with
``"wait_s"`` is given that many seconds late, as a slow model's (a rehearsal
of a job seen while it runs). No model is asked anything, so it is refused
together with ``--api-base``.
"""

import argparse
import json
import logging
import sys
import time
from types import SimpleNamespace

from plaid_client import BaseService, PlaidClient
from plaid_client.workflows.llm import add_model_pool_argument, add_timeout_argument

from .core.agent import ModelConfig, ModelTooSlow, output_cap, ping_model
from .core.job import Worker, not_answering
from .core.limits import JOB_IDLE_POLL_S, JOB_MODEL_RETRY_S
from .igt.job import runner_factory

#: The apps a worker can run, and how it builds each one's runner.
APPS = {'igt': runner_factory}


class ScriptedModel:
    """The model, answered from a file: one reply per call, in order, the
    last one given again once the file runs out."""

    def __init__(self, replies):
        if not isinstance(replies, list) or not replies:
            raise ValueError('a scripted model is a non-empty JSON list of replies')
        self.replies = replies
        self.n = 0

    @classmethod
    def load(cls, path: str) -> 'ScriptedModel':
        with open(path, encoding='utf-8') as fh:
            return cls(json.load(fh))

    def __call__(self, **kwargs):
        r = self.replies[min(self.n, len(self.replies) - 1)]
        self.n += 1
        if r.get('wait_s'):
            time.sleep(r['wait_s'])
        calls = [SimpleNamespace(id=f'scripted-{self.n}-{i}', type='function',
                                 function=SimpleNamespace(name=c['name'],
                                                          arguments=json.dumps(c.get('arguments') or {})))
                 for i, c in enumerate(r.get('calls') or [])]
        msg = SimpleNamespace(role='assistant', content=r.get('content'), tool_calls=calls or None)
        return SimpleNamespace(choices=[SimpleNamespace(index=0, message=msg, finish_reason='stop')], usage=None)


def count_chars(value) -> int:
    """Tokens as a scripted run counts them, without a tokenizer: a quarter
    of the characters."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return len(text) // 4


def answered(cfg: ModelConfig, wait: bool = True) -> bool:
    """Ping the model until it answers, as a job asks a model that does not
    answer mid-job: a failure that passes (a rate limit, a provider at
    capacity or down, a timeout, no connection: :func:`~.core.job.not_answering`,
    by the provider's error class, never its message) is logged in one line
    and asked again after JOB_MODEL_RETRY_S, so a worker a script starts
    while the endpoint is full is there once it is not (BRIEF PF). Any
    other failure (a refused key, an unknown model, another 4xx) does not
    heal by waiting: False, and the worker exits. With ``wait`` False
    (``--once``, one job and exit) the ping is asked once and any failure
    is False (REV-L2-6)."""
    while True:
        try:
            ping_model(cfg)
            return True
        except ModelTooSlow:
            print('  No answer to the ping in time. Running anyway: the first stretch will wait for it.')
            return True
        except Exception as e:  # noqa: BLE001 - the provider's own complaint is what the operator needs
            if not wait or not not_answering(e):
                print(f'  The model did not answer: {e}')
                return False
            logging.getLogger(__name__).warning('The model did not answer (%s). Asking it again in %s s.',
                                                ' '.join(str(e).split())[:200], JOB_MODEL_RETRY_S)
            time.sleep(JOB_MODEL_RETRY_S)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog='plaid-job-worker', description='Run the unattended assistant jobs of a '
                                                                     'Plaid server, one at a time.')
    p.add_argument('--url', required=True, help='The Plaid server, e.g. http://localhost:8080')
    p.add_argument('--model', required=True, help='litellm model string, e.g. openai/<name> with --api-base')
    p.add_argument('--api-base', default=None, help='Provider base URL (OpenAI-compatible servers, proxies)')
    p.add_argument('--api-key', default=None, help='Provider API key (else the provider\'s env var)')
    p.add_argument('--context-window', type=int, default=None, metavar='TOKENS',
                   help='How many tokens the model can be sent')
    p.add_argument('--max-output-tokens', dest='max_tokens', type=int, default=None, metavar='N',
                   help='The most one model call may write, its reasoning included')
    add_timeout_argument(p)
    add_model_pool_argument(p)
    p.add_argument('--reasoning-effort', default=None, metavar='LEVEL',
                   help='How hard the model should reason, in the provider\'s own word for it (for example '
                        'low or high), sent with every model call')
    p.add_argument('--trace-dir', default=None, metavar='DIR',
                   help='Write every model call of every stretch to this folder, one file per call')
    p.add_argument('--apps', nargs='+', default=sorted(APPS), choices=sorted(APPS),
                   help='The apps whose jobs this worker takes (default: every one it can run)')
    p.add_argument('--scripted-model', default=None, metavar='PATH',
                   help='Answer every model call from this JSON file instead of a model (tests, rehearsals)')
    p.add_argument('--once', action='store_true', help='Take one job if one waits, run it, and exit')
    return p


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
    args = parser().parse_args(argv)
    count = None
    if args.scripted_model:
        if args.api_base:
            print('--scripted-model answers every call from a file, so it does not go with --api-base.')
            return 2
        from .core import agent
        agent.litellm.completion = ScriptedModel.load(args.scripted_model)
        # A scripted model has no provider: litellm's "Provider List" banner says nothing here.
        agent.litellm.suppress_debug_info = True
        count = count_chars
        print(f'Model: scripted, from {args.scripted_model}')
    cfg = ModelConfig(model=args.model, api_base=args.api_base, api_key=args.api_key, max_steps=1000,
                      max_tokens=output_cap(args.model, args.max_tokens), timeout=args.timeout,
                      context_window=args.context_window, stream=not args.scripted_model,
                      reasoning_effort=args.reasoning_effort)
    if not args.scripted_model:
        print(f'Model: {cfg.model}' + (f' via {cfg.api_base}' if cfg.api_base else ''))
        if cfg.reasoning_effort:
            print(f'Reasoning effort: {cfg.reasoning_effort} (--reasoning-effort).')
        if not answered(cfg, wait=not args.once):
            return 1
    if args.model_pool:
        print(f'Model key: "{args.model_pool}". Jobs wait while services of that key are working.')
    else:
        print('Model key: none given (--model-pool), so jobs wait for nobody using the model.')
    admin = BaseService.get_client(args.url)
    runners = {app: APPS[app](cfg, trace_dir=args.trace_dir, count=count) for app in args.apps}
    worker = Worker(admin, runners, cfg.model, client_for=lambda token: PlaidClient(args.url, token),
                    pool=args.model_pool, idle_s=JOB_IDLE_POLL_S)
    print(f'Worker {worker.worker_id} asking for jobs of {", ".join(args.apps)} every {JOB_IDLE_POLL_S} s.')
    if args.once:
        worker.once()
        return 0
    worker.run_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main())
