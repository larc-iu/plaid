"""One chat model for every Plaid service that asks a language model.

A service that talks to a model over `litellm <https://docs.litellm.ai>`_ needs
the same things each time: the operator's choice of provider, the call itself,
what to do when the provider says "too many requests", whether the reply was
cut off at the token limit, and what the run cost. This holds all of that once.

Nothing here imports litellm at module level — the pure helpers of a service
stay testable without it, and a service that does not call a model does not
need it installed.

    from plaid_client.workflows.llm import ChatModel, add_model_arguments, setup_service

    def add_arguments(self, parser):
        add_model_arguments(parser, default_service_id=DEFAULT_SERVICE_ID)

    def setup(self, args):
        setup_service(self, args)          # self.model is a ChatModel

        reply = self.model.complete(system, prompt,
                                    should_stop=lambda: response_helper.cancelled)
        if reply.truncated: ...            # the model ran out of room
        reply.text

Every call has a deadline (``--timeout``, :data:`DEFAULT_TIMEOUT_S` unless the
operator says otherwise), and a call that passes ``should_stop`` ends with
:class:`~plaid_client.services.ServiceCancelled` within a second of a stop,
even while the provider has not answered.
"""

import random
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

from plaid_client.services import ServiceCancelled

#: How many times a call is retried when the provider says it is over its rate
#: limit or briefly unavailable. Short and bounded: the run reports nothing
#: while it waits, and a provider that is still refusing after this is a
#: per-sentence failure worth showing the linguist.
RETRIES = 3
RETRY_BASE_S = 2.0

#: Seconds one model call may take before it is abandoned, unless the operator
#: sets ``--timeout``. Without a deadline the provider SDK's own applies, and
#: litellm's is 6000 s: an endpoint that accepts the request and never answers
#: held the document's write lock for most of an hour per sentence.
DEFAULT_TIMEOUT_S = 120.0

#: A timed-out call is tried again at most this many times. A model that did
#: not answer in the whole window is not rate limiting, it is down or stuck,
#: and every retry costs the requester another full window of waiting.
TIMEOUT_RETRIES = 1

#: How often a waiting call looks at ``should_stop``.
STOP_POLL_S = 1.0


class ModelTimeout(Exception):
    """The model did not answer within the operator's deadline, twice. The
    message is written for the requester, unlike the provider's own."""


@dataclass
class Reply:
    """One model reply. ``truncated`` means the model stopped because it ran
    out of room, not because it had finished: the caller decides whether a
    part of an answer is worth anything (a partial gloss line still aligns the
    words it reached; half a translation is just wrong)."""

    text: str
    truncated: bool = False
    usage: Dict[str, Any] = field(default_factory=dict)


class ChatModel:
    """A chat model chosen by the operator at launch, not per request.

    One service instance serves one model, and ``--service-id`` gives a second
    instance its own identity, so a project can offer several. That is why the
    model and its base URL are CLI arguments rather than request parameters:
    the model a project uses is an operator's deployment decision, and putting
    it in the request form would let any requester point the service at any
    endpoint with the operator's key.
    """

    def __init__(self, model, api_base=None, api_key=None, temperature=0.0,
                 max_tokens=None, retries=RETRIES, timeout=DEFAULT_TIMEOUT_S):
        self.model = model
        self.timeout = timeout
        self.api_base = api_base
        self.api_key = api_key
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.retries = retries
        # Totals for the operator's log: a paid provider's bill for a run is
        # otherwise invisible until it arrives.
        self.calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.cost = 0.0

    def describe(self):
        """What goes in provDetail, so a row says which model wrote it. The
        base URL stays out: every reader of the project can read provDetail,
        and an internal endpoint is the operator's business."""
        return {'model': self.model}

    def usage_line(self) -> str:
        """One line of accounting for the operator's log."""
        line = (f'{self.model}: {self.calls} call(s), '
                f'{self.prompt_tokens} prompt + {self.completion_tokens} completion tokens')
        return line + (f', {self.cost:.4f} in provider cost' if self.cost else '')

    def complete(self, system: str, user: str,
                 should_stop: Optional[Callable[[], bool]] = None) -> Reply:
        """One chat completion, retried while the provider is rate limiting.

        ``should_stop`` is read about once a second while the call waits and
        before every retry, and a True ends the call with ``ServiceCancelled``
        (pass ``lambda: response_helper.cancelled``). Without it a stop is
        noticed only after the model answers or the deadline passes. A call
        that times out is tried once more, then raises :class:`ModelTimeout`.
        """
        import litellm  # only the running service needs it
        kwargs: Dict[str, Any] = {
            'model': self.model,
            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
            'temperature': self.temperature,
        }
        if self.timeout:
            kwargs['timeout'] = self.timeout
        if self.api_base:
            kwargs['api_base'] = self.api_base
        if self.api_key:
            kwargs['api_key'] = self.api_key
        if self.max_tokens:
            kwargs['max_tokens'] = self.max_tokens

        resp = self._with_retries(litellm, kwargs, should_stop)
        choice = resp.choices[0]
        self._record(resp)
        return Reply(
            text=(choice.message.content or '').strip(),
            truncated=getattr(choice, 'finish_reason', None) == 'length',
            usage=self._usage_of(resp),
        )

    # --- the parts worth having in one place --------------------------------

    def _with_retries(self, litellm, kwargs, should_stop=None):
        """Retry a call the provider refused for a reason that passes.

        A whole document is one call per sentence, so a rate limit is not an
        edge case: without this, a burst of 429s turned into a run that failed
        every sentence it touched and wrote nothing. Full jitter, so two
        services hitting one provider do not march in step and collide again.
        A timeout is retried :data:`TIMEOUT_RETRIES` times at most, whatever
        ``retries`` says.
        """
        timeout_error = getattr(litellm, 'Timeout', None)
        if not (isinstance(timeout_error, type) and issubclass(timeout_error, Exception)):
            timeout_error = None
        transient = tuple(
            e for e in (getattr(litellm, name, None) for name in
                        ('RateLimitError', 'ServiceUnavailableError',
                         'InternalServerError', 'APIConnectionError'))
            if isinstance(e, type) and issubclass(e, Exception))
        attempt = 0
        timeouts = 0
        while True:
            self._check_stop(should_stop)
            try:
                return self._call(litellm, kwargs, should_stop)
            except Exception as e:
                if timeout_error is not None and isinstance(e, timeout_error):
                    timeouts += 1
                    window = f'within {self.timeout:g} seconds' if self.timeout else 'in time'
                    if timeouts > TIMEOUT_RETRIES:
                        raise ModelTimeout(f'The model did not answer {window}.') from e
                    delay = 0.0
                    print(f'{self.model} did not answer {window}; trying once more')
                elif isinstance(e, transient):
                    if attempt == self.retries:
                        raise
                    delay = random.uniform(0, RETRY_BASE_S * (2 ** attempt))
                    attempt += 1
                    print(f'{type(e).__name__} from {self.model}; retrying in {delay:.1f}s '
                          f'({attempt} of {self.retries})')
                else:
                    raise
            self._sleep(delay, should_stop)

    @staticmethod
    def _check_stop(should_stop) -> None:
        if should_stop is not None and should_stop():
            raise ServiceCancelled('The requester stopped this request')

    def _sleep(self, delay: float, should_stop) -> None:
        """Wait out a retry delay, looking for a stop while it passes."""
        if should_stop is None:
            if delay > 0:
                time.sleep(delay)
            return
        remaining = delay
        while remaining > 0:
            self._check_stop(should_stop)
            step = min(STOP_POLL_S, remaining)
            time.sleep(step)
            remaining -= step
        self._check_stop(should_stop)

    def _call(self, litellm, kwargs, should_stop):
        """One provider call. With ``should_stop`` it runs on a worker thread
        so the stop can be seen while the provider is silent: litellm offers
        no way to interrupt a request in flight, so a stopped call is left to
        finish or time out on its own, and its answer is dropped."""
        if should_stop is None:
            return litellm.completion(**kwargs)
        done = threading.Event()
        box: Dict[str, Any] = {}

        def work():
            try:
                box['value'] = litellm.completion(**kwargs)
            except BaseException as e:  # handed to the waiting thread as is
                box['error'] = e
            finally:
                done.set()

        threading.Thread(target=work, name='model-call', daemon=True).start()
        while not done.wait(STOP_POLL_S):
            self._check_stop(should_stop)
        if 'error' in box:
            raise box['error']
        return box['value']

    def _usage_of(self, resp) -> Dict[str, Any]:
        usage = getattr(resp, 'usage', None)
        if usage is None:
            return {}
        return {'prompt_tokens': getattr(usage, 'prompt_tokens', 0) or 0,
                'completion_tokens': getattr(usage, 'completion_tokens', 0) or 0}

    def _record(self, resp) -> None:
        usage = self._usage_of(resp)
        self.calls += 1
        self.prompt_tokens += usage.get('prompt_tokens', 0)
        self.completion_tokens += usage.get('completion_tokens', 0)
        hidden = getattr(resp, '_hidden_params', None) or {}
        try:
            self.cost += float(hidden.get('response_cost') or 0)
        except (TypeError, ValueError):
            pass


def provider_secrets(api_key=None, environ=None):
    """Everything that must be kept out of what a requester is shown.

    A provider quotes the key it refused back in its own error text, and that
    text is reported against the sentence that failed. The key may have come
    from ``--api-key`` or from the environment litellm reads, so both count.
    """
    import os
    env = os.environ if environ is None else environ
    keys = [api_key] + [v for k, v in env.items() if k.endswith('API_KEY')]
    return tuple(v for v in keys if v)


def add_model_arguments(parser, default_service_id: Optional[str] = None) -> None:
    """The operator arguments every model-backed service takes."""
    parser.add_argument('--model', required=True,
                        help='litellm model id, e.g. openai/gpt-4o-mini, anthropic/..., ollama/llama3.1')
    parser.add_argument('--api-base', default=None,
                        help='Provider base URL (OpenAI-compatible servers, proxies)')
    parser.add_argument('--api-key', default=None, help="Provider API key (else the provider's env var)")
    parser.add_argument('--temperature', type=float, default=0.0)
    parser.add_argument('--max-tokens', type=int, default=None)
    add_timeout_argument(parser)
    parser.add_argument('--service-id', default=None,
                        help=(f'Registered service id (default {default_service_id}); '
                              'set one per model to run several')
                        if default_service_id else 'Registered service id; set one per model to run several')
    parser.add_argument('--service-name', default=None,
                        help='Display name (default is the service plus the model)')


def add_timeout_argument(parser) -> None:
    """``--timeout``, the seconds one model call may take. Its own function so
    a model caller that does not use :func:`add_model_arguments` (the
    assistants in plaid-agent) takes the same flag with the same default."""
    parser.add_argument('--timeout', type=float, default=DEFAULT_TIMEOUT_S,
                        help=f'Seconds to wait for one model reply before giving up '
                             f'(tried once more after a timeout; default {DEFAULT_TIMEOUT_S:g})')


def setup_service(service, args) -> ChatModel:
    """Build the model, take the operator's identity overrides, and keep the
    provider key out of everything a requester sees. Returns the model, which
    it has also set as ``service.model``."""
    service.model = ChatModel(args.model, api_base=args.api_base, api_key=args.api_key,
                              temperature=args.temperature, max_tokens=args.max_tokens,
                              timeout=args.timeout)
    service.REQUEST_SECRETS = provider_secrets(args.api_key)
    if args.service_id:
        service.service_id = args.service_id
    service.service_name = args.service_name or f'{service.service_name} ({args.model})'
    print(f'Model: {args.model}' + (f' via {args.api_base}' if args.api_base else ''))
    return service.model
