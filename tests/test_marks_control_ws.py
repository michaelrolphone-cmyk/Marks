import sys
import types
import unittest
from argparse import Namespace


if "requests" not in sys.modules:
    requests_stub = types.ModuleType("requests")
    requests_stub.get = lambda *a, **k: None
    requests_stub.post = lambda *a, **k: None
    sys.modules["requests"] = requests_stub

if "websocket" not in sys.modules:
    websocket_stub = types.ModuleType("websocket")
    websocket_stub.WebSocketApp = object
    sys.modules["websocket"] = websocket_stub

from marks import (
    ToolDef,
    answer_conversational_request,
    execute_agent_request,
    extract_user_request_from_messages,
    should_use_tools_for_request,
)


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def chat_completions(self, **kwargs):
        self.calls.append(kwargs)
        if not self.responses:
            raise AssertionError("No more fake responses configured")
        return self.responses.pop(0)


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


class ToolRoutingTests(unittest.TestCase):
    def test_should_use_tools_fast_path_for_action_words(self):
        client = FakeClient([])
        self.assertTrue(should_use_tools_for_request("Please lookup parcel 123", client, [], False))
        self.assertEqual(client.calls, [])

    def test_should_use_tools_uses_classifier_for_non_action_prompt(self):
        client = FakeClient([
            {"choices": [{"message": {"content": "CONVERSATIONAL"}}]},
        ])
        self.assertFalse(should_use_tools_for_request("Tell me a joke", client, [], False))
        self.assertEqual(len(client.calls), 1)

    def test_execute_agent_request_conversational_path_skips_tools(self):
        client = FakeClient([
            {"choices": [{"message": {"content": "CONVERSATIONAL"}}]},
            {"choices": [{"message": {"content": "Sure, here's a quick joke."}}]},
        ])
        args = Namespace(
            stream=False,
            resolve_steps=1,
            execute_steps=1,
            no_write_guard=False,
            no_verify_guard=False,
        )
        tools = [ToolDef(name="sample__GET__thing", description="", parameters={}, fn=lambda _: {})]
        out = execute_agent_request("Tell me a joke", args, client, tools, debug=False, trace=False, action_gate_on=True, action_gate_unlocked=False)
        self.assertEqual(out, "Sure, here's a quick joke.")
        self.assertEqual(len(client.calls), 2)

    def test_answer_conversational_request_returns_done_when_empty(self):
        client = FakeClient([
            {"choices": [{"message": {"content": ""}}]},
        ])
        self.assertEqual(answer_conversational_request("Hi", client, False), "Done.")


if __name__ == "__main__":
    unittest.main()
