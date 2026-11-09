"""The gateway proxies POST /auth/token to the auth pool (AUTH_URLS), in every mode."""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

CREDS = {"username": "bursar", "password": "pw"}


@pytest.fixture
def auth_upstream(monkeypatch: pytest.MonkeyPatch) -> list:
    from app.services import gateway

    monkeypatch.setitem(gateway.POOLS, "auth", ["http://auth-1:3000"])
    seen: list = []

    async def fake_request(method, url, content=None, headers=None, timeout=None):
        seen.append({"method": method, "url": url, "content": content, "headers": headers})
        if b'"pw"' in (content or b""):
            return httpx.Response(200, json={"access_token": "t", "token_type": "bearer", "expires_in": 900})
        return httpx.Response(401, json={"error": "invalid credentials"})

    monkeypatch.setattr(gateway._client, "request", fake_request)
    return seen


def _client() -> TestClient:
    from app.services import gateway

    return TestClient(gateway.app)


@pytest.mark.parametrize("mode", ["baseline", "ft", "endterm"])
def test_token_request_proxied_to_auth_pool(request: pytest.FixtureRequest, auth_upstream: list,
                                            mode: str) -> None:
    if mode != "baseline":
        request.getfixturevalue(mode)
    response = _client().post("/auth/token", json=CREDS)
    assert response.status_code == 200
    assert response.json()["access_token"] == "t"
    assert [(c["method"], c["url"]) for c in auth_upstream] == [("POST", "http://auth-1:3000/token")]


def test_wrong_password_401_passes_through_without_retry(ft: None, auth_upstream: list) -> None:
    response = _client().post("/auth/token", json={"username": "bursar", "password": "nope"})
    assert response.status_code == 401
    assert response.json() == {"error": "invalid credentials"}
    assert len(auth_upstream) == 1  # 4xx is never retried


def test_auth_pool_not_reachable_through_api_prefix(ft: None, auth_upstream: list) -> None:
    assert _client().post("/api/auth/token", json=CREDS).status_code == 422  # not a Pool
    assert auth_upstream == []


def test_form_content_type_body_relayed_as_is(ft: None, auth_upstream: list) -> None:
    # `curl -d '{...}'` sends application/x-www-form-urlencoded; the gateway must not 422 it
    raw = b'{"username":"bursar","password":"pw"}'
    response = _client().post("/auth/token", content=raw,
                              headers={"content-type": "application/x-www-form-urlencoded"})
    assert response.status_code == 200
    assert auth_upstream[0]["content"] == raw


def test_authorization_header_not_forwarded_to_auth(ft: None, auth_upstream: list) -> None:
    _client().post("/auth/token", json=CREDS, headers={"authorization": "Bearer abc.def.ghi"})
    assert "authorization" not in {k.lower() for k in auth_upstream[0]["headers"]}
