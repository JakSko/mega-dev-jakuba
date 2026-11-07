"""The contract, written first (S02E03 "schema first").

Source: the Challenge brief's tools block (kept private; paraphrased here): four tools with
fixed names - memo_write (text in, id out), memo_search (query in, notes out), upload (a file in,
a public link out, served by this server) and transcribe (an audio url in, timestamped segments
out, start in seconds) - and one rule for all: every result is structured content that matches
the tool's declared output schema.
Our additions (spec R5-R8, Jakub's decisions): upload input { filename, content_base64,
mime_type? }; notes carry created_at and client_id; outputs allow extra fields (the brief's "…").

These are JSON Schema 2020-12 documents. The tool code declares its own schemas through the
SDK (types -> schema); tests/test_contract.py checks that what the server publishes in
tools/list keeps every name, type and `required` listed here, and that real results validate
against BOTH the published schema and this contract.
"""

TOOL_NAMES = ["memo_write", "memo_search", "upload", "transcribe"]

MAX_TEXT = 20_000            # characters in one note
MAX_QUERY = 500
MAX_UPLOAD_BYTES = 25 * 1024 * 1024   # same as the OpenAI audio limit, so any upload can be transcribed
MAX_FILENAME = 200

INPUT = {
    "memo_write": {
        "type": "object",
        "properties": {"text": {"type": "string", "minLength": 1, "maxLength": MAX_TEXT}},
        "required": ["text"],
    },
    "memo_search": {
        "type": "object",
        "properties": {"query": {"type": "string", "maxLength": MAX_QUERY}},
        "required": ["query"],
    },
    "upload": {
        "type": "object",
        "properties": {
            "filename": {"type": "string", "minLength": 1, "maxLength": MAX_FILENAME},
            "content_base64": {"type": "string", "minLength": 1},
            "mime_type": {"type": "string"},
        },
        "required": ["filename", "content_base64"],
    },
    "transcribe": {
        "type": "object",
        "properties": {"url": {"type": "string", "minLength": 1}},
        "required": ["url"],
    },
}

OUTPUT = {
    "memo_write": {
        "type": "object",
        "properties": {"id": {"type": "string"}},
        "required": ["id"],
    },
    "memo_search": {
        "type": "object",
        "properties": {
            "notes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "text": {"type": "string"},
                        "created_at": {"type": "string"},
                        "client_id": {"type": "string"},
                    },
                    "required": ["id", "text", "created_at", "client_id"],
                },
            }
        },
        "required": ["notes"],
    },
    "upload": {
        "type": "object",
        "properties": {"url": {"type": "string"}},
        "required": ["url"],
    },
    "transcribe": {
        "type": "object",
        "properties": {
            "segments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "start": {"type": "number", "minimum": 0},
                        "end": {"type": "number", "minimum": 0},
                        "text": {"type": "string"},
                    },
                    "required": ["start", "text"],
                },
            }
        },
        "required": ["segments"],
    },
}
