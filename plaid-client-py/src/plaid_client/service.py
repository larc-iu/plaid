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
        self.service_registration = None
        self.processing_lock = {"is_processing": False}

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
                token = input("Enter Plaid API token: ").strip()
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
        """Wrap :meth:`process_request` with a single-request lock + error reporting."""
        if self.processing_lock["is_processing"]:
            response_helper.error(
                f"{self.service_name} is currently processing another request. "
                f"Please try again later."
            )
            return
        self.processing_lock["is_processing"] = True
        try:
            self.process_request(request_data, response_helper)
        except Exception as e:
            import traceback
            print(f"Error during {self.service_name} processing: {str(e)}")
            traceback.print_exc()
            response_helper.error(f"{self.service_name} processing error: {str(e)}")
        finally:
            self.processing_lock["is_processing"] = False

    # --- registration + lifecycle ------------------------------------------

    def register_service(self, project_id: str) -> None:
        """Open the inbound request channel (which registers the service) and
        start handling work. The standardized ``extras`` ride along for
        discovery."""
        service_info = {
            'service_id': self.service_id,
            'service_name': self.service_name,
            'description': self.description,
        }
        print(f"Registering as service: {service_info} (tasks={self.extras.get('tasks')})")
        print(f"Starting {self.service_name}, listening to project {project_id}")
        self.service_registration = self.client.messages.serve(
            project_id, service_info, self.handle_service_request, self.extras
        )
        print("Service registered successfully. Waiting for requests...")
        print("Press Ctrl+C to stop the service.")

    def run_service_loop(self) -> None:
        """Block until the service stops or Ctrl+C."""
        try:
            while self.service_registration.is_running():
                time.sleep(1)
        except KeyboardInterrupt:
            print(f"\nStopping {self.service_name}...")
            self.service_registration.stop()
            print("Service stopped.")

    # --- CLI ----------------------------------------------------------------

    def setup_parser_common_args(self, parser: argparse.ArgumentParser) -> None:
        """Add the args every service needs (project id + API url)."""
        parser.add_argument('project_id', help='Target project ID')
        parser.add_argument('--url', default='http://localhost:8085',
                            help='Plaid API URL (default: http://localhost:8085)')

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
        """Main entry point: parse args, init client, set up, register, loop."""
        parser = self.create_argument_parser()
        parsed_args = parser.parse_args(args)
        self.client = self.get_client(parsed_args.url)
        self.setup(parsed_args)
        self.register_service(parsed_args.project_id)
        self.run_service_loop()
