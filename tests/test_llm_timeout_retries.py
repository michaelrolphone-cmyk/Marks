import unittest
from unittest.mock import patch
import sys
import types

if "requests" not in sys.modules:
    requests_stub = types.ModuleType("requests")
    requests_stub.get = lambda *a, **k: None
    requests_stub.post = lambda *a, **k: None
    requests_stub.request = lambda *a, **k: None
    sys.modules["requests"] = requests_stub

if "websocket" not in sys.modules:
    websocket_stub = types.ModuleType("websocket")
    websocket_stub.WebSocketApp = object
    sys.modules["websocket"] = websocket_stub

from marks import OpenAICompat


class _FakeResponse:
    def __init__(self, payload=None):
        self._payload = payload or {"choices": [{"message": {"content": "ok"}}]}

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class OpenAICompatRetryTests(unittest.TestCase):
    def test_increases_timeout_after_transient_timeout_error(self):
        client = OpenAICompat(
            base_url="http://localhost:1234/v1",
            api_key="lm_studio",
            model="test-model",
            timeout_s=10,
            retries=1,
            timeout_backoff_factor=1.5,
            max_timeout_s=60,
        )

        timeouts = []

        def fake_post(_url, **kwargs):
            timeouts.append(kwargs.get("timeout"))
            if len(timeouts) == 1:
                raise RuntimeError("Read timed out")
            return _FakeResponse()

        with patch("marks.requests.post", side_effect=fake_post), patch("marks.time.sleep", return_value=None):
            out = client.chat_completions(messages=[{"role": "user", "content": "hello"}], stream=False)

        self.assertEqual(out["choices"][0]["message"]["content"], "ok")
        self.assertEqual(timeouts, [10, 15])


    def test_timeout_zero_disables_request_timeout(self):
        client = OpenAICompat(
            base_url="http://localhost:1234/v1",
            api_key="lm_studio",
            model="test-model",
            timeout_s=0,
            retries=0,
            max_timeout_s=60,
        )

        captured = {}

        def fake_post(_url, **kwargs):
            captured["timeout"] = kwargs.get("timeout")
            return _FakeResponse()

        with patch("marks.requests.post", side_effect=fake_post):
            out = client.chat_completions(messages=[{"role": "user", "content": "hello"}], stream=False)

        self.assertEqual(out["choices"][0]["message"]["content"], "ok")
        self.assertIsNone(captured["timeout"])

    def test_raises_when_transient_timeouts_exhaust_retries(self):
        client = OpenAICompat(
            base_url="http://localhost:1234/v1",
            api_key="lm_studio",
            model="test-model",
            timeout_s=10,
            retries=1,
            timeout_backoff_factor=2.0,
            max_timeout_s=60,
        )

        with patch("marks.requests.post", side_effect=RuntimeError("Connection timed out")), patch("marks.time.sleep", return_value=None):
            with self.assertRaises(RuntimeError):
                client.chat_completions(messages=[{"role": "user", "content": "hello"}], stream=False)


if __name__ == "__main__":
    unittest.main()
