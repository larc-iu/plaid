"""Plaid is the identity provider.

Logging in posts the credentials to Plaid; the Plaid token comes back and is kept
in a signed session cookie. Every request that touches Plaid uses a client bound
to that token, so Plaid's own roles gate the work and the audit log names the
person. Logging out revokes the token at Plaid too.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass

from fastapi import Request
from itsdangerous import BadSignature, URLSafeSerializer
from plaid_client import PlaidClient
from plaid_client.http import PlaidAPIError

from .config import settings

COOKIE = "dig4el_session"


@dataclass
class User:
    id: str
    display_name: str
    token: str
    is_admin: bool = False
    is_guest: bool = False  # the shared read-only account, used for visitors who are not logged in

    def client(self) -> PlaidClient:
        return PlaidClient(settings().plaid_url, self.token)


# ------------------------------------------------------------ the guest account
# One Plaid account, a reader on every project a caretaker opened to guests. Its named
# API token is kept in the data directory; visitors who are not logged in browse as it.

GUEST_FILE = "guest_account.json"


def guest_config() -> dict | None:
    path = settings().data_dir / GUEST_FILE
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except ValueError:
        return None


def save_guest_config(cfg: dict) -> None:
    path = settings().data_dir / GUEST_FILE
    path.write_text(json.dumps(cfg))
    path.chmod(0o600)


def clear_guest_config() -> None:
    path = settings().data_dir / GUEST_FILE
    if path.exists():
        path.unlink()


def guest_user() -> User | None:
    cfg = guest_config()
    if not cfg or not cfg.get("token"):
        return None
    return User(id=cfg["user_id"], display_name="Guest", token=cfg["token"], is_guest=True)


def _serializer() -> URLSafeSerializer:
    return URLSafeSerializer(settings().secret_key, salt="session")


def _jwt_user_id(token: str) -> str | None:
    """The user id carried in a Plaid JWT's payload. Not verified here: Plaid
    verifies the token on every call we make with it."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return data.get("user/id") or data.get("user-id") or data.get("sub")
    except Exception:
        return None


def login(user_id: str, password: str) -> User:
    client = PlaidClient.login(settings().plaid_url, user_id, password)
    uid = _jwt_user_id(client.token) or user_id
    info = {}
    try:
        info = client.users.get(uid) or {}
    except PlaidAPIError:
        pass
    return User(id=uid, display_name=info.get("display_name") or uid, token=client.token,
                is_admin=bool(info.get("is_admin")))


def session_cookie_value(user: User) -> str:
    return _serializer().dumps({"id": user.id, "name": user.display_name, "token": user.token,
                                "admin": user.is_admin})


def user_from_request(request: Request) -> User | None:
    raw = request.cookies.get(COOKIE)
    if not raw:
        return None
    try:
        data = _serializer().loads(raw)
    except BadSignature:
        return None
    return User(id=data["id"], display_name=data.get("name") or data["id"], token=data["token"],
                is_admin=bool(data.get("admin")))


def logout(user: User) -> None:
    try:
        user.client()._request("POST", "/api/v1/logout")
    except Exception:
        pass
