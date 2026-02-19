import sys
import types
import unittest


if "requests" not in sys.modules:
    requests_stub = types.ModuleType("requests")
    requests_stub.get = lambda *a, **k: None
    requests_stub.post = lambda *a, **k: None
    sys.modules["requests"] = requests_stub

if "websocket" not in sys.modules:
    websocket_stub = types.ModuleType("websocket")
    websocket_stub.WebSocketApp = object
    sys.modules["websocket"] = websocket_stub

from marks import extract_user_request_from_messages


class ExtractUserRequestTests(unittest.TestCase):
    def test_prefers_last_user_string_message(self):
        messages = [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "ack"},
            {"role": "user", "content": "final request"},
        ]
        self.assertEqual(extract_user_request_from_messages(messages), "final request")

    def test_supports_multimodal_text_parts(self):
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Find parcel"},
                    {"type": "image_url", "image_url": {"url": "http://example/img.png"}},
                    {"type": "text", "text": "by APN 123"},
                ],
            }
        ]
        self.assertEqual(extract_user_request_from_messages(messages), "Find parcel\nby APN 123")

    def test_fallback_to_last_message_when_no_user_role(self):
        messages = [{"role": "system", "content": "do x"}]
        self.assertEqual(extract_user_request_from_messages(messages), "do x")


if __name__ == "__main__":
    unittest.main()
