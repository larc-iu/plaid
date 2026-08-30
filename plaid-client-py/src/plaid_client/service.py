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
import sys
import threading
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from plaid_client.client import PlaidClient
from plaid_client.http import PlaidAPIError, short_error
from plaid_client.service_schema import build_extras
from plaid_client.services import ServiceRegistrationError


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
        delegation: Act on the REQUESTER's behalf. The server mints a
            short-lived token for whoever submits each request; this class
            turns it into ``request_data['requester_client']``, a
            ``PlaidClient`` authenticated as that user. Use it (not
            ``self.client``) for everything done for the request, so the work
            runs under the requester's permissions and is attributed to them.
            Readers may drive a delegating service.
    """

    def __init__(self, service_id: str, service_name: str, description: str, *,
                 tasks: Optional[List[str]] = None,
                 summary: Optional[str] = None,
                 parameters: Optional[List[Dict[str, Any]]] = None,
                 extras: Optional[Dict[str, Any]] = None,
                 delegation: bool = False):
        self.service_id = service_id
        self.service_name = service_name
        self.description = description
        self.delegation = delegation
        self.extras = build_extras(tasks=tasks or [], summary=summary,
                                   parameters=parameters, extra=extras,
                                   delegation=delegation)
        self.client: Optional[PlaidClient] = None
        # One registration per served project (a service can serve many at once;
        # see :meth:`run`). The lock makes the instance single-flight ACROSS all
        # of them — each project has its own SSE reader thread, so without it two
        # projects' requests could enter :meth:`process_request` (and the shared
        # client's batch state) concurrently.
        self.service_registrations: List[Any] = []
        # Serve-all bookkeeping: which project each registration covers, so the
        # periodic sync pass can diff against the live project list. Failed
        # project ids are remembered only to keep the retry loop from
        # re-printing the same error every pass.
        self._registrations_by_project: Dict[str, Any] = {}
        self._sync_failed_projects: set = set()
        self._processing_lock = threading.Lock()
        # Which projects to serve: a fixed list, or None for "every project the
        # token can access" (serve-all). Set by :meth:`run`.
        self._target_projects: Optional[List[str]] = None
        self._project_names: Dict[str, str] = {}
        # Connection-state reporting. Registrations reconnect on their own, so
        # the operator's only question during an outage is whether it is
        # healing. These keep the answer to two lines per outage no matter how
        # many projects are served, instead of one pair per project.
        self._status_lock = threading.Lock()
        self._disconnected_projects: set = set()
        self._server_unreachable = False

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
                # A token the server REJECTS means "try again". A server that
                # cannot be reached says nothing about the token, so take it on
                # trust and let the run loop wait for the server. Otherwise a
                # service could not even be configured while Plaid is down.
                try:
                    _ = client.projects.list_page(limit=1)
                    verdict = "Token valid."
                except PlaidAPIError as e:
                    if e.status:
                        print(f"Plaid rejected that token: {e}")
                        continue
                    verdict = f"Could not reach Plaid to check the token ({e}), keeping it."
                except Exception as e:
                    verdict = f"Could not reach Plaid to check the token ({e}), keeping it."
                with open(".token", "w") as f:
                    f.write(token)
                    print(f"{verdict} Wrote token to .token")
                return client
        return PlaidClient(api_url, token)

    # --- request handling ---------------------------------------------------

    @abstractmethod
    def process_request(self, request_data: Dict[str, Any], response_helper) -> None:
        """Process one service request.

        Args:
            request_data: The request payload. Read declared parameters under the
                same key you put in the schema. For a delegating service it also
                carries ``requester_client``, a ``PlaidClient`` authenticated as
                the user who submitted the request.
            response_helper: ``.progress(percent, msg)`` / ``.complete(data)`` /
                ``.error(msg)``.
        """
        raise NotImplementedError

    #: Handle requests concurrently (each on its own thread) instead of
    #: single-flight. Right for an I/O-bound service such as a chat assistant
    #: waiting on a remote model; wrong for a GPU-bound one. A concurrent
    #: service must not touch shared mutable state (including batch/operation
    #: state on ``self.client``) from :meth:`process_request`; a delegating one
    #: naturally works through the per-request ``requester_client``.
    CONCURRENT = False

    def handle_service_request(self, request_data: Dict[str, Any], response_helper) -> None:
        """Wrap :meth:`process_request` with a single-flight lock + error reporting.

        When serving several projects each has its own SSE reader thread, so a
        cross-project race is real. We REJECT (don't block) a second concurrent
        request: blocking could outlast the requester's response timeout, badly
        so for slow models. The work is CPU/GPU-bound anyway — one at a time is
        the right model. (:attr:`CONCURRENT` services skip the lock and handle
        each request on a thread of its own.)
        """
        if self.CONCURRENT:
            threading.Thread(target=self._handle_request,
                             args=(request_data, response_helper), daemon=True).start()
            return
        if not self._processing_lock.acquire(blocking=False):
            response_helper.error(
                f"{self.service_name} is currently processing another request. "
                f"Please try again later."
            )
            return
        try:
            self._handle_request(request_data, response_helper)
        finally:
            self._processing_lock.release()

    def _handle_request(self, request_data: Dict[str, Any], response_helper) -> None:
        """One request: delegation, operation-group adoption, process, report."""
        # Delegation: the server's per-request token for the requesting user
        # becomes a client of their own. It is only ever minted for a service
        # that declared ``delegation``, so its absence there is a hard error
        # rather than a silent fall-back to the service's own credentials.
        requester = None
        if isinstance(request_data, dict):
            token = request_data.pop('delegated_token', None)
            if token:
                requester = PlaidClient(self.client.base_url, token)
                request_data['requester_client'] = requester
            elif self.delegation:
                response_helper.error(f"{self.service_name} acts on the requester's behalf but "
                                      f"the request carried no delegated token (server too old?)")
                return
        # A requester with an open logical operation propagates it as
        # ``operation_group`` (see ``request_service``); adopt it so this
        # service's writes fold under the requester's audit-log entry. The
        # service's own ``with client.operation(...)`` then flattens into it
        # (outer label wins). Popped so it never reaches process_request as a
        # stray parameter. Adopted on whichever client does the writing.
        group = request_data.pop('operation_group', None) if isinstance(request_data, dict) else None
        joined = bool(group and isinstance(group, dict) and group.get('id'))
        op_client = requester or self.client
        if joined:
            op_client.begin_operation(group.get('message'), group_id=group['id'])
        try:
            self.process_request(request_data, response_helper)
        except Exception as e:
            import traceback
            print(f"Error during {self.service_name} processing: {str(e)}")
            traceback.print_exc()
            response_helper.error(f"{self.service_name} processing error: {str(e)}")
        finally:
            if joined:
                op_client.end_operation()

    # --- registration + lifecycle ------------------------------------------

    #: How often (seconds) to re-run the reconciliation pass: in serve-all mode
    #: this re-lists projects so ones created after launch get registered on and
    #: deleted ones get dropped. Override on a subclass or instance to tune.
    PROJECT_SYNC_INTERVAL_S = 30.0

    #: How soon to re-run that pass when it could not reach the server. Short,
    #: so a service that outlived a server restart (or was started before the
    #: server came up) picks it back up promptly instead of waiting out a full
    #: sync interval. Registrations that already exist heal on their own, faster
    #: still (see ``ServiceRegistration``).
    SERVER_RETRY_INTERVAL_S = 5.0

    def _project_label(self, project_id: str) -> str:
        """Name (when known) plus id, for operator-facing lines."""
        name = self._project_names.get(project_id)
        return f'{name} ({project_id})' if name else project_id

    def _on_channel_status(self, event: str, project_id: str, detail=None) -> None:
        """Report a registration's connection transitions to the operator.

        A registration re-opens its own channel after a server restart, so the
        only thing the operator needs to know is that it is healing and that
        restarting the service is unnecessary. Reported per SERVICE, not per
        project: an outage prints one "lost" line and one "back" line however
        many projects are served."""
        with self._status_lock:
            if event == 'registered':
                print(f"  Serving project {self._project_label(project_id)}")
            elif event == 'waiting':
                print(f"  Not connected yet for project {self._project_label(project_id)} "
                      f"({detail}). Will keep trying.")
            elif event == 'disconnected':
                first = not self._disconnected_projects
                self._disconnected_projects.add(project_id)
                if first:
                    print(f"  Lost the connection to Plaid ({detail}). Retrying every few "
                          f"seconds. This service re-registers itself as soon as the server "
                          f"is back, so there is no need to restart it.")
            elif event == 'reconnected':
                self._disconnected_projects.discard(project_id)
                if not self._disconnected_projects:
                    print(f"  Reconnected to Plaid, serving "
                          f"{len(self._registrations_by_project)} project(s) again.")

    def register_service(self, project_id: str):
        """Open the inbound request channel on one project (which registers the
        service for discovery) and start handling work. The standardized
        ``extras`` ride along for discovery. Records and returns the
        ``ServiceRegistration``; call once per project to serve several at once.

        The registration is self-healing: it reopens its channel whenever it
        drops and waits for a server that is not up yet, so this call succeeds
        (and the service stays useful) across server restarts. It raises only
        when retrying cannot help: a bad token, no write access, an unknown
        project."""
        service_info = {
            'service_id': self.service_id,
            'service_name': self.service_name,
            'description': self.description,
        }
        registration = self.client.messages.serve(
            project_id, service_info, self.handle_service_request, self.extras,
            on_status=self._on_channel_status,
        )
        self.service_registrations.append(registration)
        self._registrations_by_project[project_id] = registration
        return registration

    def _target_project_names(self) -> Optional[Dict[str, str]]:
        """The projects this service should be serving, as {id: name}, or None
        if the server could not be asked. In serve-all mode that is every
        accessible project (re-read each pass, so projects created or shared
        after launch are picked up). With explicit ids it is just those, and no
        request is needed."""
        if self._target_projects is not None:
            return {pid: self._project_names.get(pid, '') for pid in self._target_projects}
        try:
            projects = self.client.projects.list()
        except Exception as e:
            if not self._server_unreachable:
                self._server_unreachable = True
                print(f"  Cannot reach the Plaid server ({short_error(e)}). Waiting for "
                      f"it to come back, then registering automatically.")
            return None
        if self._server_unreachable:
            self._server_unreachable = False
            print("  Plaid server is reachable again.")
        return {p['id']: p.get('name', '') for p in projects}

    def _sync_served_projects(self) -> bool:
        """One reconciliation pass: make the served set match the target set.

        Registers on every target project not already served — including, in
        serve-all mode, projects created (or shared with this token) after
        launch — and stops registrations whose project is gone (deleted, or
        access revoked) so their supervisors stop retrying a dead channel.
        Per-project failures are non-fatal; the next pass retries them. Failing
        to reach the server leaves the current set untouched (the existing
        registrations are already reconnecting on their own).

        Returns whether the pass could talk to the server."""
        current = self._target_project_names()
        if current is None:
            return False
        self._project_names.update({pid: name for pid, name in current.items() if name})

        for pid in [pid for pid in self._registrations_by_project if pid not in current]:
            registration = self._registrations_by_project.pop(pid)
            try:
                registration.stop()
            except Exception:
                pass
            try:
                self.service_registrations.remove(registration)
            except ValueError:
                pass
            self._disconnected_projects.discard(pid)
            print(f"  No longer serving project {self._project_label(pid)} "
                  f"(deleted or access revoked)")

        for pid in current:
            if pid in self._registrations_by_project:
                continue
            try:
                # Registration announces itself through _on_channel_status.
                self.register_service(pid)
            except ServiceRegistrationError as e:
                # Retrying cannot fix this one (bad token, no write access,
                # unknown project). Say so once, then let later passes stay
                # quiet unless it starts working.
                if pid not in self._sync_failed_projects:
                    self._sync_failed_projects.add(pid)
                    print(f"  Cannot serve project {self._project_label(pid)}: {e}")
                continue
            except Exception as e:
                if pid not in self._sync_failed_projects:
                    self._sync_failed_projects.add(pid)
                    print(f"  Cannot serve project {self._project_label(pid)} yet, "
                          f"will keep retrying: {e}")
                continue
            self._sync_failed_projects.discard(pid)
        return True

    def run_service_loop(self, project_sync_interval_s: Optional[float] = None) -> None:
        """Run until Ctrl+C, re-running :meth:`_sync_served_projects` on an
        interval, then stop every registration.

        The loop never exits on its own: registrations reconnect through server
        restarts rather than ending, and in serve-all mode the service keeps
        running even while zero projects are served. A pass that could not reach
        the server is retried after :attr:`SERVER_RETRY_INTERVAL_S` instead of
        the full interval."""
        interval = project_sync_interval_s or self.PROJECT_SYNC_INTERVAL_S
        try:
            next_sync = time.monotonic() + interval
            while True:
                time.sleep(1)
                if time.monotonic() >= next_sync:
                    reached = self._sync_served_projects()
                    next_sync = time.monotonic() + (interval if reached
                                                    else self.SERVER_RETRY_INTERVAL_S)
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
        """Add the args every service needs (project ids + API url).

        Project ids are OPTIONAL: omit them (or pass ``--all``) and the service
        registers on EVERY project the token can access — existing and future,
        since the run loop keeps re-listing projects — so it's discoverable
        everywhere without a launch per project. Pass one or more ids to serve
        just those."""
        parser.add_argument('project_ids', nargs='*', default=[], metavar='PROJECT_ID',
                            help='Project ID(s) to serve. Omit (or pass --all) to '
                                 'serve every accessible project, existing and '
                                 'future.')
        parser.add_argument('--all', action='store_true',
                            help='Serve every project the token can access, '
                                 'including ones created later (the default '
                                 'when no project ID is given).')
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

    def _check_credentials(self) -> None:
        """One cheap call before any expensive :meth:`setup`, to separate the
        two ways a server can refuse us.

        A token the server REJECTS is an operator error worth dying on now,
        rather than after minutes of model loading. A server that is merely
        down is not an error at all: we go on to set up and then wait for it,
        exactly as a running service waits out a restart."""
        try:
            self.client.projects.list_page(limit=1)
        except PlaidAPIError as e:
            if e.status in (401, 403):
                print(f"Plaid rejected this service's token: {e}")
                print("Create an API token in the web UI (Profile → API Tokens) and put "
                      "it in .token, or delete .token to be prompted for a new one.")
                raise SystemExit(1)
            self._server_unreachable = True
            print(f"  Plaid is not reachable yet ({short_error(e)}); starting anyway "
                  f"and registering as soon as it answers.")
        except Exception as e:
            self._server_unreachable = True
            print(f"  Plaid is not reachable yet ({short_error(e)}); starting anyway "
                  f"and registering as soon as it answers.")

    def run(self, args=None) -> None:
        """Main entry point: parse args, init client, set up, register on the
        target project(s), loop.

        With no project ids (or ``--all``) the service serves EVERY project the
        token can access — existing and future; with ids, just those. Server side, registration is
        project-scoped (one SSE channel per project), so universal coverage
        means one registration per project; the run loop re-lists projects
        every ``PROJECT_SYNC_INTERVAL_S`` seconds to register on projects
        created after launch (and to drop deleted ones), so new projects are
        covered without a restart. Every registration shares this instance's
        client and single-flight lock, so requests are still handled one at a
        time across all served projects.

        A service outlives the server: an unreachable server is waited for at
        startup, and every registration reopens its channel when the server
        comes back, so restarting Plaid never means restarting its services.
        Only a token the server rejects stops startup.
        """
        # A service is usually run with its output redirected (nohup, systemd,
        # a log file), where stdout is block-buffered: the connection-state
        # lines below would sit in an 8KB buffer for hours, which is exactly
        # when an operator is reading them to decide whether to restart. `run`
        # owns the process, so switch stdout to line buffering for good.
        try:
            sys.stdout.reconfigure(line_buffering=True)
        except Exception:
            pass

        parser = self.create_argument_parser()
        parsed_args = parser.parse_args(args)
        self.client = self.get_client(parsed_args.url)

        project_ids = list(getattr(parsed_args, 'project_ids', None) or [])
        serve_all = getattr(parsed_args, 'all', False) or not project_ids
        self._target_projects = None if serve_all else project_ids

        self._check_credentials()
        self.setup(parsed_args)

        print(f"Registering {self.service_name} (service_id={self.service_id}, "
              f"tasks={self.extras.get('tasks')})…")
        # Initial registration is just the first pass of the same reconciliation
        # the run loop repeats, so a server that is down now is handled the same
        # way as one that goes down later: keep trying.
        self._sync_served_projects()
        if serve_all:
            if not self.service_registrations:
                print("  No projects served yet; waiting for projects to appear…")
            print(f"{self.service_name} serving {len(self.service_registrations)} "
                  f"project(s); syncing with the project list every "
                  f"{self.PROJECT_SYNC_INTERVAL_S:g}s. Waiting for requests… "
                  f"(Press Ctrl+C to stop.)")
        else:
            print(f"{self.service_name} registered on "
                  + (f"project {project_ids[0]}" if len(project_ids) == 1
                     else f"{len(project_ids)} projects")
                  + ". Waiting for requests… (Press Ctrl+C to stop.)")
        self.run_service_loop(project_sync_interval_s=self.PROJECT_SYNC_INTERVAL_S)
