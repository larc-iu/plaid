"""Base class for Plaid NLP services.

Generic scaffolding shared by all Plaid services: client/token bootstrap,
service registration, the single-request processing lock, and the CLI run loop.
A concrete service subclasses :class:`BaseService`, declares the tasks it serves
plus a summary and a parameter schema (assembled into ``extras`` automatically),
and implements :meth:`process_request`.

This consolidates what used to be each app's own ``base_service.py`` so every
service across apps builds on one SDK. App-specific frameworks (tokenization,
ASR, …) layer on top of this — they are NOT part of the client.

Two distinct kinds of "arguments", do not conflate them:
  * **CLI/operator args** (argparse) — host, project id, model paths: set once by
    whoever launches the service. Add them via :meth:`add_arguments`.
  * **Per-request user args** — the schema ``parameters`` the end user fills in
    per request, delivered in ``request_data``.
"""

import argparse
import threading
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from plaid_client.client import PlaidClient
from plaid_client.service_schema import build_extras


class BaseService(ABC):
    """Base class for Plaid services.

    Args:
        service_id: Unique id for the service (e.g. ``'tok:nltk-punkt'``).
        service_name: Human-readable name.
        description: Short one-line description.
        tasks: Tasks this service serves (use ``plaid_client.TASKS``).
        summary: Optional rich human description (markdown) for the UI.
        parameters: Optional list of per-request parameter descriptors
            (use ``plaid_client.Param``).
        extras: Optional dict of additional service-specific extras to merge in.
    """

    def __init__(self, service_id: str, service_name: str, description: str, *,
                 tasks: Optional[List[str]] = None,
                 summary: Optional[str] = None,
                 parameters: Optional[List[Dict[str, Any]]] = None,
                 extras: Optional[Dict[str, Any]] = None):
        self.service_id = service_id
        self.service_name = service_name
        self.description = description
        self.extras = build_extras(tasks=tasks or [], summary=summary,
                                   parameters=parameters, extra=extras)
        self.client: Optional[PlaidClient] = None
        # One registration per served project (a service can serve many at once;
        # see :meth:`run`). The lock makes the instance single-flight ACROSS all
        # of them — each project has its own SSE reader thread, so without it two
        # projects' requests could enter :meth:`process_request` (and the shared
        # client's batch state) concurrently.
        self.service_registrations: List[Any] = []
        self._processing_lock = threading.Lock()

    # --- client bootstrap ---------------------------------------------------

    @staticmethod
    def get_client(api_url: str) -> PlaidClient:
        """Return an authenticated client, reading/prompting for a token.

        Reads a ``.token`` file in the cwd; if absent, prompts and validates,
        then caches it.
        """
        try:
            with open(".token", "r") as f:
                token = f.read().strip()
        except FileNotFoundError:
            while True:
                # Prefer a NAMED API token (web UI: Profile → API Tokens): it
                # doesn't expire, survives password changes, can be revoked on
                # its own, and its name shows up as the actor in the audit log,
                # so rows a service writes are attributable to the machine.
                token = input("Enter Plaid API token (create one in the web UI: "
                              "Profile → API Tokens): ").strip()
                client = PlaidClient(api_url, token)
                # Any failure validating the token (bad token -> PlaidAPIError,
                # or a network error) just means "try again".
                try:
                    _ = client.projects.list()
                except Exception as e:
                    print(f"Error when attempting to connect to Plaid API: {e}")
                    continue
                with open(".token", "w") as f:
                    f.write(token)
                    print("Token valid. Wrote token to .token")
                return client
        return PlaidClient(api_url, token)

    # --- request handling ---------------------------------------------------

    @abstractmethod
    def process_request(self, request_data: Dict[str, Any], response_helper) -> None:
        """Process one service request.

        Args:
            request_data: The request payload. Read declared parameters under the
                same key you put in the schema.
            response_helper: ``.progress(percent, msg)`` / ``.complete(data)`` /
                ``.error(msg)``.
        """
        raise NotImplementedError

    def handle_service_request(self, request_data: Dict[str, Any], response_helper) -> None:
        """Wrap :meth:`process_request` with a single-flight lock + error reporting.

        When serving several projects each has its own SSE reader thread, so a
        cross-project race is real. We REJECT (don't block) a second concurrent
        request: blocking could outlast the requester's response timeout, badly
        so for slow models. The work is CPU/GPU-bound anyway — one at a time is
        the right model.
        """
        if not self._processing_lock.acquire(blocking=False):
            response_helper.error(
                f"{self.service_name} is currently processing another request. "
                f"Please try again later."
            )
            return
        try:
            self.process_request(request_data, response_helper)
        except Exception as e:
            import traceback
            print(f"Error during {self.service_name} processing: {str(e)}")
            traceback.print_exc()
            response_helper.error(f"{self.service_name} processing error: {str(e)}")
        finally:
            self._processing_lock.release()

    # --- registration + lifecycle ------------------------------------------

    def register_service(self, project_id: str):
        """Open the inbound request channel on one project (which registers the
        service for discovery) and start handling work. The standardized
        ``extras`` ride along for discovery. Records and returns the
        ``ServiceRegistration``; call once per project to serve several at once."""
        service_info = {
            'service_id': self.service_id,
            'service_name': self.service_name,
            'description': self.description,
        }
        registration = self.client.messages.serve(
            project_id, service_info, self.handle_service_request, self.extras
        )
        self.service_registrations.append(registration)
        return registration

    def run_service_loop(self) -> None:
        """Block until every registration stops or Ctrl+C, then stop them all."""
        try:
            while any(reg.is_running() for reg in self.service_registrations):
                time.sleep(1)
        except KeyboardInterrupt:
            print(f"\nStopping {self.service_name}...")
        finally:
            for reg in self.service_registrations:
                try:
                    reg.stop()
                except Exception:
                    pass
            print("Service stopped.")

    # --- CLI ----------------------------------------------------------------

    def setup_parser_common_args(self, parser: argparse.ArgumentParser) -> None:
        """Add the args every service needs (project id + API url).

        The project id is OPTIONAL: omit it (or pass ``--all``) and the service
        registers on EVERY project the token can access, so it's discoverable
        everywhere without a launch per project. Pass a single id for the old
        one-project behavior."""
        parser.add_argument('project_id', nargs='?', default=None,
                            help='Target project ID. Omit (or pass --all) to '
                                 'serve every accessible project.')
        parser.add_argument('--all', action='store_true',
                            help='Serve every project the token can access (the '
                                 'default when no project ID is given).')
        parser.add_argument('--url', default='http://localhost:8080',
                            help='Plaid API URL (default: http://localhost:8080)')

    def add_arguments(self, parser: argparse.ArgumentParser) -> None:
        """Override to add service-specific CLI (operator) arguments."""
        pass

    def create_argument_parser(self) -> argparse.ArgumentParser:
        """Build the CLI parser (common args + :meth:`add_arguments`).

        Subclasses may override this entirely, but overriding
        :meth:`add_arguments` is usually enough.
        """
        parser = argparse.ArgumentParser(description=f'{self.service_name} service')
        self.setup_parser_common_args(parser)
        self.add_arguments(parser)
        return parser

    def setup(self, args) -> None:
        """Override for service-specific setup after arg parsing, before
        registration."""
        pass

    def run(self, args=None) -> None:
        """Main entry point: parse args, init client, set up, register on the
        target project(s), loop.

        With no project id (or ``--all``) the service fans out one registration
        per project the token can access. That gives universal coverage: server
        side, registration is project-scoped (one SSE channel per project), so
        being discoverable everywhere means registering everywhere. Every
        registration shares this instance's client and single-flight lock, so
        requests are still handled one at a time across all served projects.
        """
        parser = self.create_argument_parser()
        parsed_args = parser.parse_args(args)
        self.client = self.get_client(parsed_args.url)

        # Resolve the target project set (fail fast before any expensive setup()).
        serve_all = getattr(parsed_args, 'all', False) or not parsed_args.project_id
        if serve_all:
            try:
                projects = self.client.projects.list()
            except Exception as e:
                print(f"Failed to list projects: {e}")
                raise SystemExit(1)
            targets = [(p['id'], p.get('name', p['id'])) for p in projects]
            if not targets:
                print("Token has access to no projects; nothing to serve.")
                raise SystemExit(1)
        else:
            targets = [(parsed_args.project_id, parsed_args.project_id)]

        self.setup(parsed_args)

        print(f"Registering {self.service_name} (service_id={self.service_id}, "
              f"tasks={self.extras.get('tasks')}) on {len(targets)} project(s)…")
        for pid, pname in targets:
            try:
                self.register_service(pid)
                print(f"  Serving project {pname} ({pid})")
            except Exception as e:
                # A project the token can list but not register on (e.g. another
                # live instance already holds this service id) shouldn't take
                # down coverage of the rest.
                print(f"  Skipping project {pid}: failed to register: {e}")

        if not self.service_registrations:
            print("No services registered; exiting.")
            raise SystemExit(1)

        print(f"{self.service_name} registered on {len(self.service_registrations)} "
              f"project(s). Waiting for requests… (Press Ctrl+C to stop.)")
        self.run_service_loop()
