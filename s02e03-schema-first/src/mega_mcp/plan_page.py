"""The plan page (spec R9): named as resource_documentation in the protected resource metadata."""
from __future__ import annotations

import html

from .config import Config


def render(cfg: Config) -> str:
    mb = lambda n: f"{n // (1024 * 1024)} MB"  # noqa: E731
    u = html.escape(cfg.public_url)
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Jakub's MCP tools - plan</title><style>body{{font:16px/1.5 system-ui;max-width:46em;margin:2em auto;padding:0 1em}}
code{{background:#eee;padding:0 .3em}}h2{{margin-top:1.6em}}</style></head><body>
<h1>Jakub's MCP tools</h1>
<p>A remote MCP server (protocol revision <code>2026-07-28</code>; older clients on <code>2025-11-25</code> are served too).
Endpoint: <code>{u}/mcp</code> (Streamable HTTP, POST). Built for the MEGA.dev course, Challenge S02E03.</p>

<h2>What the tools do</h2>
<ul>
<li><code>memo_write</code> - saves a note. Input <code>{{text}}</code> (1 to 20,000 characters). Result <code>{{id}}</code>.</li>
<li><code>memo_search</code> - finds notes. Input <code>{{query}}</code>: every word must appear in the note (case-insensitive);
an empty query lists all notes. Result <code>{{notes: [{{id, text, created_at, client_id}}]}}</code>, newest first, at most 100.</li>
<li><code>upload</code> - stores a file and returns a link anyone can open, served by this server.
Input <code>{{filename, content_base64, mime_type?}}</code>, up to 25 MB. Result <code>{{url}}</code>
(<code>{u}/files/&lt;id&gt;.&lt;ext&gt;</code>). HTML, SVG and scripts are served as downloads, never as pages.</li>
<li><code>transcribe</code> - turns audio at a URL into timestamped text. Input <code>{{url}}</code> (a public http(s) URL or a link
from <code>upload</code>). Result <code>{{segments: [{{start, end, text}}]}}</code>, times in seconds.
Formats: mp3, mp4, mpeg, mpga, m4a, wav, webm; up to 25 MB.</li>
</ul>
<p>Every result is structured content that matches the tool's declared output schema. memo_write, memo_search and upload also send the same JSON as text; transcribe sends a one-line summary as text instead, so its result stays small. A tool error names what was wrong, for transcribe the url.</p>

<h2>How sign-in works</h2>
<p>OAuth 2.1. Without a valid token every request to <code>/mcp</code> gets <code>401</code> with a
<code>WWW-Authenticate</code> header pointing to the protected resource metadata
(<code>/.well-known/oauth-protected-resource/mcp</code>). The authorization server is this same host
(<code>/.well-known/oauth-authorization-server</code>): Dynamic Client Registration at <code>/register</code>,
authorization code with PKCE (S256) at <code>/authorize</code>, tokens at <code>/token</code>, one scope <code>mcp</code>.
A client gets a code only after the owner signs in on the consent page, which names the client, its redirect host and the scope.
Access tokens last 1 hour and are valid only for <code>{u}/mcp</code>; refresh tokens rotate on each use.
The authorization response carries <code>iss</code>.</p>

<h2>What data it keeps</h2>
<ul>
<li>Notes you write, with the time and the id of the client that wrote them. Kept until the owner deletes them.</li>
<li>Uploaded files, with their name, type and size. Kept until the owner deletes them; anyone with a link can open that file.</li>
<li>Audio for <code>transcribe</code> is held in memory only for the call and sent to the OpenAI API (model <code>whisper-1</code>);
it is not stored here. OpenAI's own data rules apply to what it receives.</li>
<li>Registered OAuth clients, and codes and tokens as SHA-256 hashes.</li>
<li>A request log on the host with tokens, passwords, keys and note texts masked, kept by the host provider.</li>
</ul>
<p>Nothing else: no tool lists files, reads the environment, runs code or fetches private addresses.
To have something deleted, ask the owner (Jakub).</p>

<h2>Limits</h2>
<ul>
<li>Uploads and audio: 25 MB. Download timeout {int(cfg.fetch_timeout)} s; a transcription call may take up to {int(cfg.transcribe_timeout)} s.</li>
<li>Transcription: at most {cfg.calls_per_day} calls and {mb(cfg.bytes_per_day)} of audio per day (UTC), shared by all clients;
over the daily cap the tool returns an error.</li>
<li>{cfg.tool_calls_per_minute} tool calls per minute per client.</li>
<li><code>whisper-1</code> is deprecated by OpenAI and shuts down on 2027-02-26; the engine will be switched before then.</li>
</ul>
</body></html>"""
