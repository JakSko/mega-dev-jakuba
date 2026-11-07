"""Step 6 gate: the contract itself is valid JSON Schema 2020-12 and follows the brief."""
from jsonschema import Draft202012Validator

from mega_mcp import contract


def test_four_tools_exact_names():
    assert contract.TOOL_NAMES == ["memo_write", "memo_search", "upload", "transcribe"]
    assert set(contract.INPUT) == set(contract.TOOL_NAMES) == set(contract.OUTPUT)


def test_every_schema_is_valid_2020_12():
    for name in contract.TOOL_NAMES:
        Draft202012Validator.check_schema(contract.INPUT[name])
        Draft202012Validator.check_schema(contract.OUTPUT[name])


def test_outputs_allow_extra_fields():
    # the brief writes `{ id, text, … }` and `{ start, text, … }`
    def walk(s):
        assert s.get("additionalProperties", True) is not False
        for v in s.get("properties", {}).values():
            walk(v)
        if "items" in s:
            walk(s["items"])
    for name in contract.TOOL_NAMES:
        walk(contract.OUTPUT[name])


def test_brief_shapes():
    assert contract.INPUT["memo_write"]["required"] == ["text"]
    assert contract.INPUT["memo_search"]["required"] == ["query"]
    assert contract.INPUT["transcribe"]["required"] == ["url"]
    assert contract.OUTPUT["memo_write"]["required"] == ["id"]
    assert contract.OUTPUT["upload"]["required"] == ["url"]
    note = contract.OUTPUT["memo_search"]["properties"]["notes"]["items"]
    assert {"id", "text"} <= set(note["required"])
    seg = contract.OUTPUT["transcribe"]["properties"]["segments"]["items"]
    assert {"start", "text"} <= set(seg["required"])
    assert seg["properties"]["start"]["type"] == "number"
