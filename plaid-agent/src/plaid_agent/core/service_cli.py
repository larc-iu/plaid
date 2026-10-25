"""The assistant's command line and startup: its flags, the model and the
search provider it is pointed at, and the pings that check both before it
registers, so a mistake is the operator's to see at once."""

import argparse
import os
import re
import time
from urllib.parse import urlsplit

from plaid_client.workflows.llm import add_timeout_argument, provider_secrets

from .agent import (DEFAULT_MAX_OUTPUT_TOKENS, ModelConfig, ModelTooSlow, PING_TIMEOUT_S, context_window, output_cap,
                    ping_model)
from .limits import MAX_PROJECTS
from .ops import RECORD_PROTOCOL
from .web import BACKENDS, WebConfig, ping as ping_search


class ServiceCli:
    """The flags and the startup of `BaseAssistantService`."""

    def add_arguments(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument('--model', required=True,
                            help='litellm model string, e.g. openai/gpt-4o, anthropic/claude-sonnet-4-5, '
                                 'ollama/llama3.1, or openai/<name> with --api-base for any OpenAI-compatible server')
        parser.add_argument('--api-base', default=None, help='Provider base URL (OpenAI-compatible servers, proxies)')
        parser.add_argument('--api-key', default=None, help='Provider API key (else the provider\'s env var)')
        parser.add_argument('--max-steps', type=int, default=50, help='Tool-call rounds per turn (default 50)')
        parser.add_argument('--temperature', type=float, default=None)
        parser.add_argument('--max-output-tokens', dest='max_tokens', type=_positive_int,
                            default=None, metavar='N',
                            help=f'The most one model call may write, its reasoning included (default '
                                 f'{DEFAULT_MAX_OUTPUT_TOKENS}, or less for a model known to write less). '
                                 'A call that reaches it ends the turn with a message to the user.')
        add_timeout_argument(parser)
        parser.add_argument('--context-window', type=_positive_int, default=None, metavar='TOKENS',
                            help='How many tokens the model can be sent. The conversation gauge shows '
                                 'how full a conversation is against it and warns near the limit. '
                                 'Without it the model library\'s figure is used, and a model it does '
                                 'not know shows a count with no percentage.')
        parser.add_argument('--no-stream', action='store_true',
                            help='Do not stream the reply as it is written (for a provider that misbehaves '
                                 'under streaming); the reply then arrives whole')
        parser.add_argument('--service-id', default=None,
                            help=f'Service id (default {self.APP}:assist:<model>). Several assistants can be '
                                 'online on one project as long as their ids differ; the Assistant tab '
                                 'offers a picker.')
        parser.add_argument('--service-name', default=None,
                            help=f'Display name (default "{self.APP_LABEL} (<model>)")')
        parser.add_argument('--disclosure', default=None, metavar='TEXT',
                            help='What users should know before using this assistant, such as where the '
                                 'model runs and where what they send it goes. Shown in the Assistant '
                                 'panel as given, as coming from whoever runs the assistant')
        parser.add_argument('--web-search', default=None, choices=sorted(BACKENDS),
                            help='Let the assistant look things up on the web with this provider. '
                                 'Off unless given: without it the web tools are not offered to the '
                                 'model and the prompt does not mention them. '
                                 + ' · '.join(f'{b.name}: ' + (b.note or f'key in {b.env_key}')
                                              for b in BACKENDS.values()))
        parser.add_argument('--web-search-key', default=None,
                            help='Key for --web-search, for a provider that takes one (else its own '
                                 'environment variable)')
        parser.add_argument('--web-search-url', default=None,
                            help='Base URL of a self-hosted --web-search provider, e.g. '
                                 'http://localhost:8888 for SearXNG')

    def setup(self, args) -> None:
        self.cfg = ModelConfig(model=args.model, api_base=args.api_base, api_key=args.api_key,
                               max_steps=args.max_steps, temperature=args.temperature,
                               max_tokens=output_cap(args.model, args.max_tokens),
                               stream=not getattr(args, 'no_stream', False), timeout=args.timeout,
                               context_window=getattr(args, 'context_window', None))
        self.kit = self.toolkit()
        # A provider quotes the key it refused back in its own error text.
        self.REQUEST_SECRETS = provider_secrets(args.api_key)
        # One registration per model by default, so an operator can run several
        # assistants side by side (different models, or the same model with a
        # different base) and users pick one in the tab. Two instances with the
        # SAME id on a project still collide (409): that is the dedupe guard.
        slug = re.sub(r'[^A-Za-z0-9._-]+', '-', self.cfg.model).strip('-')
        self.service_id = args.service_id or f'{self.APP}:assist:{slug}'
        self.service_name = args.service_name or f'{self.APP_LABEL} ({self.cfg.model})'
        # Advertised so the UI can say which model answers, and so it can tell
        # its OWN assistant from another app's: a conversation's record is
        # namespaced by app, so an app that offered a foreign assistant sent
        # every turn to a service that could not find the conversation.
        self.extras['model'] = self.cfg.model
        # And which version of it, for the page's row of a conversation just
        # sent, drawn before the service writes the entry.
        self.extras['version'] = self.version
        self.extras['app'] = self.APP
        # Which requests it takes: the pages that send ops (and write nothing
        # of the record themselves) offer only an assistant that says so.
        self.extras['record'] = RECORD_PROTOCOL
        # How many projects one conversation may read, its own included. The
        # browser offers to add projects only when this is here, and stops at
        # it: the one number, so the control and the service cannot disagree.
        self.extras['max_projects'] = MAX_PROJECTS
        # The operator's own statement for users (`--disclosure`): Plaid cannot
        # know where a given site's model runs or where what is sent to it
        # goes, so whoever runs the assistant says, and the panel shows it.
        disclosure = (getattr(args, 'disclosure', None) or '').strip()
        if disclosure:
            self.extras['disclosure'] = disclosure
        print(f'Model: {self.cfg.model}' + (f' via {self.cfg.api_base}' if self.cfg.api_base else ''))
        window = context_window(self.cfg.model, self.cfg.context_window)
        if self.cfg.context_window:
            print(f'  Context window: {window} tokens (--context-window).')
        elif window:
            print(f'  Context window: {window} tokens (the model library\'s figure).')
        else:
            print('  Context window: unknown, so the conversation gauge shows a count with no '
                  'percentage. State it with --context-window.')
        print(f'  Output cap: {self.cfg.max_tokens} tokens per model call'
              + (' (--max-output-tokens).' if args.max_tokens else '.'))
        # Ask the model one question before registering. A service that cannot
        # reach its model has nothing to offer, and the operator is here NOW.
        started = time.monotonic()
        try:
            ping_model(self.cfg)
        except ModelTooSlow:
            # A timeout is not evidence of a mistake. Refusing to start on one
            # takes an assistant off the air for a provider that is merely
            # loading a model, and the operator cannot tell that from a typo
            # because the message named the same three things either way.
            print(f'  No answer within {PING_TIMEOUT_S}s. Serving anyway: a slow provider is '
                  f'not a misconfigured one, and the first question will wait for it.')
        except Exception as e:  # noqa: BLE001 - whatever the provider says, the operator needs to read it
            print(f'  The model did not answer: {e}')
            print('  Check --model (a litellm model string), --api-base, and the provider key '
                  '(--api-key or the provider\'s environment variable).')
            raise SystemExit(1)
        else:
            print(f'  Answered in {time.monotonic() - started:.1f}s.')
        self.web_cfg = build_web_config(args)
        if self.web_cfg is None:
            print('Web lookup: off (--web-search to turn it on)')
        else:
            # Same reasoning as the model ping: a bad key should be the
            # operator's problem now, not a user's mid-conversation.
            where = f' at {self.web_cfg.api_base}' if self.web_cfg.api_base else ''
            print(f'Web lookup: {self.web_cfg.backend}{where}')
            try:
                print(f'  {ping_search(self.web_cfg, self.PING_QUERY)} results for a test search.')
            except Exception as e:  # noqa: BLE001 - the provider's own complaint is what helps
                print(f'  The search provider did not answer: {e}')
                print(f'  {check_hint(BACKENDS[self.web_cfg.backend])}')
                raise SystemExit(1)


def _positive_int(text: str) -> int:
    """An argparse type for a count that has to be above zero."""
    try:
        n = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f'{text!r} is not a whole number') from None
    if n <= 0:
        raise argparse.ArgumentTypeError(f'{n} is not above zero')
    return n


def check_hint(backend) -> str:
    """What to look at when a provider will not answer."""
    if backend.needs_base:
        return f'Check --web-search-url ({backend.note}).'
    return f'Check --web-search-key (or {backend.env_key}).'


def build_web_config(args) -> 'WebConfig | None':
    """The web configuration, or None when the operator did not ask for one.
    What a provider needs is the provider's own business (see web.BACKENDS):
    a hosted one wants a key, a self-hosted one wants a URL and no key.

    The Plaid server's own host is denied to any fetch: aimed there, this
    service would be reaching back into the network it is trusted inside."""
    if not args.web_search:
        return None
    backend = BACKENDS[args.web_search]
    key = args.web_search_key or (os.environ.get(backend.env_key) if backend.env_key else '') or ''
    if backend.env_key and not key:
        print(f'--web-search {backend.name} needs a key: --web-search-key or '
              f'{backend.env_key} in the environment.')
        raise SystemExit(1)
    base = (args.web_search_url or '').strip()
    if backend.needs_base and not base:
        print(f'--web-search {backend.name} needs --web-search-url ({backend.note}).')
        raise SystemExit(1)
    host = urlsplit(args.url).hostname
    return WebConfig(backend=backend.name, api_key=key, api_base=base,
                     deny_hosts=tuple(h for h in (host,) if h))
