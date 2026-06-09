"""Compatibility shim.

The generic service scaffolding now lives in the shared client package
(`plaid_client.BaseService`) so every service across apps builds on one SDK.
This module re-exports it so existing imports keep working:

    from client.base_service import BaseService

App-specific frameworks (tokenization, ASR) still live under `client/`.
"""

from plaid_client import BaseService

__all__ = ['BaseService']
