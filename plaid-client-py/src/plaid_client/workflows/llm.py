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

Every call is streamed, as the assistants' calls are (plaid-agent's
``core/agent.py``), and its deadline (``--timeout``, :data:`DEFAULT_TIMEOUT_S`
unless the operator says otherwise) is the longest SILENCE allowed, not the
length of the reply: a reasoning model that thinks for five minutes while
sending tokens all along is answering. A call that passes ``should_stop`` ends
with :class:`~plaid_client.services.ServiceCancelled` within a second of a
stop, even while the provider has not answered, and a stream is closed at its
next chunk. The temperature is the provider's own unless the operator sets one:
greedy decoding (0) sent a reasoning model round the same lines of thought
until its token limit.
"""

import random
import threading
import time
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional

from plaid_client.services import ServiceCancelled

#: How many times a call is retried when the provider says it is over its rate
#: limit or briefly unavailable. Short and bounded: the run reports nothing
#: while it waits, and a provider that is still refusing after this is a
#: per-sentence failure worth showing the linguist.
RETRIES = 3
RETRY_BASE_S = 2.0

#: Seconds a model call may go without sending anything before it is
#: abandoned, unless the operator sets ``--timeout``. The call is streamed, so
#: this is a gap between chunks, not a cap on the reply. Without a deadline
#: the provider SDK's own applies, and litellm's is 6000 s: an endpoint that
#: accepts the request and never answers held the document's write lock for
#: most of an hour per sentence.
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


#: A run that asks the model once per sentence stops after this many sentences
#: in a row the model did not answer. A model that is down otherwise costs a
#: full deadline per sentence, and the document stays locked for hours.
UNANSWERED_IN_A_ROW = 2

#: The per-sentence reason, in igt's lower-case style, for a sentence a run
#: never asked about because it had stopped.
NOT_ASKED = f'not asked: the model did not answer {UNANSWERED_IN_A_ROW} sentences in a row'


def did_not_answer(exc: BaseException) -> bool:
    """Whether a failed call means the model is not answering at all: it
    passed the deadline (:class:`ModelTimeout`), or the provider could not be
    reached or said it was unavailable, after the retries. An answer that is
    an error (a bad request, a refused key) is not this: the next sentence may
    well get a reply."""
    if isinstance(exc, ModelTimeout):
        return True
    try:
        import litellm
    except ImportError:  # pragma: no cover - only a service that calls a model gets here
        return False
    down = tuple(e for e in (getattr(litellm, n, None) for n in
                             ('APIConnectionError', 'ServiceUnavailableError'))
                 if isinstance(e, type) and issubclass(e, BaseException))
    return bool(down) and isinstance(exc, down)


class UnansweredRun:
    """Counts the sentences in a row a run's model did not answer, so the run
    can stop asking. ``answered()`` after any reply, a bad one included, and
    ``failed(exc)`` after a call that raised, which says whether to stop."""

    def __init__(self, limit: int = UNANSWERED_IN_A_ROW):
        self.limit = limit
        self.in_a_row = 0

    def answered(self) -> None:
        self.in_a_row = 0

    def failed(self, exc: BaseException) -> bool:
        self.in_a_row = self.in_a_row + 1 if did_not_answer(exc) else 0
        return self.in_a_row >= self.limit

    def stop_line(self, left: int, verb: str = 'drafted') -> str:
        """The report's line for a run that stopped: ``The model did not
        answer 2 sentences in a row, so the run stopped. 38 sentences were not
        drafted.`` Empty when no sentence was left: a run whose last two
        sentences got no answer did not stop, it finished, and each of the two
        is already named with its reason."""
        if not left:
            return ''
        line = f'The model did not answer {self.limit} sentences in a row, so the run stopped.'
        if left == 1:
            return line + f' 1 sentence was not {verb}.'
        return line + f' {left} sentences were not {verb}.'


# --- what passes, and trying again -------------------------------------------
#
# Every caller of a model in Plaid retries the same way: a model service's
# ChatModel here, and the assistants' turn and startup ping (plaid-agent's
# core/agent.py). One place decides what is worth another try and what a
# timeout is.

def transient_errors(litellm=None) -> tuple:
    """The provider failures that pass: a rate limit, a provider briefly down
    or unreachable."""
    if litellm is None:
        import litellm  # only a caller that talks to a model needs it
    return tuple(e for e in (getattr(litellm, n, None) for n in
                             ('RateLimitError', 'ServiceUnavailableError', 'InternalServerError',
                              'APIConnectionError'))
                 if isinstance(e, type) and issubclass(e, Exception))


def _timeout_errors(litellm) -> tuple:
    out = [getattr(litellm, 'Timeout', None)]
    try:  # litellm raises the openai SDK's classes too, its own Timeout among them
        from openai import APITimeoutError
        out.append(APITimeoutError)
    except ImportError:  # pragma: no cover - litellm depends on openai
        pass
    try:  # a stream that goes silent ends in the HTTP library's own read timeout
        from httpx import TimeoutException
        out.append(TimeoutException)
    except ImportError:  # pragma: no cover - the openai SDK depends on httpx
        pass
    return tuple(e for e in out if isinstance(e, type) and issubclass(e, Exception))


def _timed_out(e: BaseException, timeouts: tuple) -> bool:
    """Whether ``e``, or an error it was raised from, is one of ``timeouts``.
    A stream that goes silent after it has begun is not raised as a timeout:
    litellm wraps the read timeout in ``MidStreamFallbackError``, a
    "service unavailable", with the timeout as its cause."""
    seen = set()
    while e is not None and id(e) not in seen and timeouts:
        if isinstance(e, timeouts):
            return True
        seen.add(id(e))
        e = e.__cause__ or e.__context__
    return False


def is_timeout(e: BaseException, litellm=None) -> bool:
    """Whether the call passed its deadline without an answer: no reply began
    in time, or a reply that had begun went silent for the deadline."""
    if litellm is None:
        import litellm
    return _timed_out(e, _timeout_errors(litellm))


def retrying(call: Callable[[], Any], *, model: str, timeout: Optional[float] = None,
             retries: int = RETRIES, timeout_retries: int = TIMEOUT_RETRIES,
             sleep: Callable[[float], None] = None, on_retry: Optional[Callable[[], None]] = None,
             litellm=None):
    """``call()``, tried again when the provider refused it for a reason that
    passes, and its answer returned.

    A rate limit or a provider briefly down is tried up to ``retries`` more
    times after a wait with full jitter, so two callers hitting one provider
    do not march in step and collide again. A call that passed its deadline
    is tried ``timeout_retries`` more times, at once: a model that did not
    answer in the whole window is down or stuck, and every try costs another
    window. Anything else, or the last failure, is raised as it is.
    ``sleep(delay)`` waits between tries (a caller that can be stopped looks
    for the stop there), and ``on_retry()`` runs before each new try. The
    operator's log says what happened, and the requester never sees it."""
    if sleep is None:
        sleep = time.sleep
    if litellm is None:
        import litellm
    transient = transient_errors(litellm)
    timeouts_of = _timeout_errors(litellm)
    attempt = timeouts = 0
    while True:
        try:
            return call()
        except Exception as e:
            if _timed_out(e, timeouts_of):
                timeouts += 1
                if timeouts > timeout_retries:
                    raise
                delay = 0.0
                window = f'within {timeout:g} seconds' if timeout else 'in time'
                print(f'{model} did not answer {window}; trying once more')
            elif transient and isinstance(e, transient):
                if attempt >= retries:
                    raise
                delay = random.uniform(0, RETRY_BASE_S * (2 ** attempt))
                attempt += 1
                print(f'{model} failed ({" ".join(str(e).split())[:200]}); '
                      f'retrying in {delay:.1f}s ({attempt} of {retries})')
            else:
                raise
        sleep(delay)
        if on_retry is not None:
            on_retry()


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

    def __init__(self, model, api_base=None, api_key=None, temperature=None,
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
        """One chat completion, streamed, retried while the provider is rate
        limiting.

        ``should_stop`` is read about once a second while the call waits and
        before every retry, and a True ends the call with ``ServiceCancelled``
        (pass ``lambda: response_helper.cancelled``). Without it a stop is
        noticed only after the model answers or the deadline passes. A call
        that goes silent for the deadline is tried once more, then raises
        :class:`ModelTimeout`. The temperature is sent only when the operator
        chose one.
        """
        import litellm  # only the running service needs it
        kwargs: Dict[str, Any] = {
            'model': self.model,
            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
        }
        if self.temperature is not None:
            kwargs['temperature'] = self.temperature
        if self.timeout:
            kwargs['timeout'] = self.timeout
        # The retries are this class's alone. The OpenAI SDK under litellm
        # otherwise retries a timeout twice more on its own, which tripled
        # every deadline.
        kwargs['max_retries'] = 0
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
        """Retry a call the provider refused for a reason that passes
        (:func:`retrying`), looking for a stop before every try and while it
        waits. A timeout that is not tried again is named for the requester.
        """
        def call():
            self._check_stop(should_stop)
            return self._call(litellm, kwargs, should_stop)

        try:
            return retrying(call, model=self.model, timeout=self.timeout, retries=self.retries,
                            sleep=lambda delay: self._sleep(delay, should_stop), litellm=litellm)
        except Exception as e:
            if is_timeout(e, litellm):
                window = f'within {self.timeout:g} seconds' if self.timeout else 'in time'
                raise ModelTimeout(f'The model did not answer {window}.') from e
            raise

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
        no way to interrupt a request in flight, so a stopped call stops
        reading its stream at the next chunk (which ends the request at the
        provider), or is left to time out on its own, and its answer is
        dropped."""
        if should_stop is None:
            return _streamed(litellm, kwargs)
        done = threading.Event()
        abandoned = threading.Event()
        box: Dict[str, Any] = {}

        def work():
            try:
                box['value'] = _streamed(litellm, kwargs, abandoned)
            except BaseException as e:  # handed to the waiting thread as is
                box['error'] = e
            finally:
                done.set()

        threading.Thread(target=work, name='model-call', daemon=True).start()
        while not done.wait(STOP_POLL_S):
            if should_stop():
                abandoned.set()
                raise ServiceCancelled('The requester stopped this request')
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


def _streamed(litellm, kwargs, abandoned: Optional[threading.Event] = None):
    """One call, streamed, read back as one response: ``choices[0]`` with the
    reply's text as ``message.content`` and its ``finish_reason``, and the
    usage. The deadline in ``kwargs['timeout']`` is the provider SDK's read
    timeout, which every chunk resets, the thinking a reasoning model streams
    before its answer included.

    A provider that refuses to stream (an error before the first chunk that is
    neither a timeout nor one that passes) is asked again without streaming,
    as the assistants' calls are (plaid-agent ``core/agent.py``
    ``_complete_once``). Once ``abandoned`` is set the stream is closed at its
    next chunk."""
    chunks: List[Any] = []
    try:
        stream = litellm.completion(**kwargs, stream=True)
        if hasattr(stream, 'choices'):
            return stream  # a whole response (a test double, a provider that ignored stream=)
        for chunk in stream:
            if abandoned is not None and abandoned.is_set():
                close = getattr(stream, 'close', None)
                if callable(close):
                    close()
                raise ServiceCancelled('The requester stopped this request')
            chunks.append(chunk)
    except ServiceCancelled:
        raise
    except Exception as e:
        if chunks or is_timeout(e, litellm) or isinstance(e, transient_errors(litellm)):
            raise
        if abandoned is not None and abandoned.is_set():
            raise ServiceCancelled('The requester stopped this request') from e
        return litellm.completion(**kwargs)
    return _joined(litellm, chunks, kwargs.get('messages'))


def _joined(litellm, chunks, messages):
    """The chunks of a streamed reply as one response. The text and the finish
    reason are read here. The usage is the last one a chunk carried, or else
    litellm's count from the chunks (``stream_chunk_builder``)."""
    text = []
    finish = None
    usage = None
    for chunk in chunks:
        if getattr(chunk, 'usage', None):
            usage = chunk.usage
        for choice in getattr(chunk, 'choices', None) or []:
            delta = getattr(choice, 'delta', None)
            piece = getattr(delta, 'content', None) if delta is not None else None
            if piece:
                text.append(piece)
            if getattr(choice, 'finish_reason', None):
                finish = choice.finish_reason
    hidden: Dict[str, Any] = {}
    builder = getattr(litellm, 'stream_chunk_builder', None)
    if chunks and callable(builder):
        try:
            built = builder(chunks, messages=messages)
            usage = usage or getattr(built, 'usage', None)
            hidden = getattr(built, '_hidden_params', None) or {}
            # A model litellm has no price for is a provider the operator
            # runs, and asking prints litellm's help text into the log.
            priced = getattr(litellm, 'model_cost', None) or {}
            model = str(getattr(built, 'model', '') or '')
            if (not hidden.get('response_cost') and (model in priced or model.split('/')[-1] in priced)
                    and callable(getattr(litellm, 'completion_cost', None))):
                hidden = {**hidden, 'response_cost': litellm.completion_cost(completion_response=built)}
        except Exception:  # noqa: BLE001 - accounting only: the reply stands without it
            pass
    message = SimpleNamespace(content=''.join(text))
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason=finish)],
                           usage=usage, _hidden_params=hidden)


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
    parser.add_argument('--temperature', type=float, default=None,
                        help="Sampling temperature (default: the provider's own)")
    parser.add_argument('--max-tokens', type=int, default=None)
    add_timeout_argument(parser)
    parser.add_argument('--service-id', default=None,
                        help=(f'Registered service id (default {default_service_id}); '
                              'set one per model to run several')
                        if default_service_id else 'Registered service id; set one per model to run several')
    parser.add_argument('--service-name', default=None,
                        help='Display name (default is the service plus the model)')


def add_timeout_argument(parser) -> None:
    """``--timeout``, the seconds a model call may stay silent. Its own function so
    a model caller that does not use :func:`add_model_arguments` (the
    assistants in plaid-agent) takes the same flag with the same default."""
    parser.add_argument('--timeout', type=float, default=DEFAULT_TIMEOUT_S,
                        help=f'Seconds the model may send nothing before a reply is given up '
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
