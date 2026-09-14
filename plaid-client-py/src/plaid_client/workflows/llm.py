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

        reply = self.model.complete(system, prompt)
        if reply.truncated: ...            # the model ran out of room
        reply.text
"""

import random
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

#: How many times a call is retried when the provider says it is over its rate
#: limit or briefly unavailable. Short and bounded: the run reports nothing
#: while it waits, and a provider that is still refusing after this is a
#: per-sentence failure worth showing the linguist.
RETRIES = 3
RETRY_BASE_S = 2.0


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
                 max_tokens=None, retries=RETRIES):
        self.model = model
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
        """What goes in provDetail, so a row says which model wrote it."""
        d = {'model': self.model}
        if self.api_base:
            d['api_base'] = self.api_base
        return d

    def usage_line(self) -> str:
        """One line of accounting for the operator's log."""
        line = (f'{self.model}: {self.calls} call(s), '
                f'{self.prompt_tokens} prompt + {self.completion_tokens} completion tokens')
        return line + (f', {self.cost:.4f} in provider cost' if self.cost else '')

    def complete(self, system: str, user: str) -> Reply:
        """One chat completion, retried while the provider is rate limiting."""
        import litellm  # only the running service needs it
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

        resp = self._with_retries(litellm, kwargs)
        choice = resp.choices[0]
        self._record(resp)
        return Reply(
            text=(choice.message.content or '').strip(),
            truncated=getattr(choice, 'finish_reason', None) == 'length',
            usage=self._usage_of(resp),
        )

    # --- the parts worth having in one place --------------------------------

    def _with_retries(self, litellm, kwargs):
        """Retry a call the provider refused for a reason that passes.

        A whole document is one call per sentence, so a rate limit is not an
        edge case: without this, a burst of 429s turned into a run that failed
        every sentence it touched and wrote nothing. Full jitter, so two
        services hitting one provider do not march in step and collide again.
        """
        transient = tuple(
            e for e in (getattr(litellm, name, None) for name in
                        ('RateLimitError', 'ServiceUnavailableError',
                         'InternalServerError', 'APIConnectionError', 'Timeout'))
            if isinstance(e, type) and issubclass(e, Exception))
        for attempt in range(self.retries + 1):
            try:
                return litellm.completion(**kwargs)
            except transient as e:
                if attempt == self.retries:
                    raise
                delay = random.uniform(0, RETRY_BASE_S * (2 ** attempt))
                print(f'{type(e).__name__} from {self.model}; retrying in {delay:.1f}s '
                      f'({attempt + 1} of {self.retries})')
                time.sleep(delay)

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
    parser.add_argument('--service-id', default=None,
                        help=(f'Registered service id (default {default_service_id}); '
                              'set one per model to run several')
                        if default_service_id else 'Registered service id; set one per model to run several')
    parser.add_argument('--service-name', default=None,
                        help='Display name (default is the service plus the model)')


def setup_service(service, args) -> ChatModel:
    """Build the model, take the operator's identity overrides, and keep the
    provider key out of everything a requester sees. Returns the model, which
    it has also set as ``service.model``."""
    service.model = ChatModel(args.model, api_base=args.api_base, api_key=args.api_key,
                              temperature=args.temperature, max_tokens=args.max_tokens)
    service.REQUEST_SECRETS = provider_secrets(args.api_key)
    if args.service_id:
        service.service_id = args.service_id
    service.service_name = args.service_name or f'{service.service_name} ({args.model})'
    print(f'Model: {args.model}' + (f' via {args.api_base}' if args.api_base else ''))
    return service.model
