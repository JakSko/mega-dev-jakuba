# S03E01 - status for the night

A skill that turns a folder of mixed files from several people into one tagged, cited requirements list, and a public status page built from that list. Built for the MEGA.dev Challenge S03E01 "status for the night" (2026-11-11, solved on the first try).

## The task, in my words

Product wanted a public status page for the night. Six people sent what they wanted, each in a different form: a voice memo, a screen-share video, a screenshot with handwritten notes, a whiteboard photo, a short spec PDF, and a live departure board that was not in the pack at all (its link was only on the signed-in Challenge page). Each real requirement carried a tag such as `R-X2M`.

Step one: one list of every tagged requirement, each cited to its file and the exact place in it (a region of the page or image as 0-1 fractions, or the second in a recording). Where sources disagree, the list must not pick a side: product decides, so each conflict goes back to its owner as one question that names both sides. The list goes in together with the text of my own intake skill. Step two: build the page from the accepted list, deploy it on public https with no login, and hand in its address.

## What I built

### `capture/` - the intake skill

[`capture/SKILL.md`](capture/SKILL.md) holds the rules and the method; the scripts do the measuring:

| Source | What could hide there | Script |
|---|---|---|
| PDF | tags in the text layer; position on the page | [`pdf_tags.py`](capture/scripts/pdf_tags.py) - word boxes from poppler, the tag's line as a page region |
| Screenshot, whiteboard photo | handwritten notes and arrows in coloured ink | [`ink_boxes.py`](capture/scripts/ink_boxes.py) - blocks of red or blue ink, their boxes, a preview to check by eye |
| Video | text shown on screen but never said (here: a note typed and deleted within ten seconds) | [`video_changes.py`](capture/scripts/video_changes.py) - every frame compared with the one before; frames saved where the picture changes |
| Audio and the video's sound | tags spelled letter by letter | [`transcribe.py`](capture/scripts/transcribe.py) - local faster-whisper with word times; [`audio_map.py`](capture/scripts/audio_map.py) - loudness map and the sound onset of each tag |
| The list | a tag twice, a missing file, a region outside the image, a question that names only one side | [`build_list.py`](capture/scripts/build_list.py) - builds the list and refuses a broken one |

Two things the scripts taught me:

- **Word times are late.** Two Whisper models put the spelled tags up to a second after the sound starts, so `at` comes from the loudness onset, checked on a short clip around each tag and by ear.
- **A transcript is half a video.** One requirement was only typed on screen while the speaker said "hold on". Only the frame diff found it.

### `status-page/` - the page

[`server.mjs`](status-page/server.mjs), Node, no dependencies. Every rule names its tag in a comment.

- `GET /` - the page: the amber banner text kept exactly as drawn, the heading in exact words, a row per line, incidents newest first with who ran them, dates day first (product's answer), times in UTC with a footer saying so. No scripts, no cookies, no tracking.
- `GET /status.json` - the same rows for other systems, with the feed's own `updatedAt`, `Access-Control-Allow-Origin: *`, a preflight answer, and `Cache-Control: max-age=30`.
- The ops feed is read live on every request, never stored. When it fails, page and JSON say so (502) instead of showing an old copy.
- Two questions product did not answer (how far back the page goes, and who ran one record with no author) got no rule of mine: the page shows the feed as it is.

## How it was checked

- 8 tests against a fake feed ([`server.test.mjs`](status-page/server.test.mjs)): every covered tag, the live read, the feed failure, CORS and preflight.
- [`check.mjs`](status-page/check.mjs) - 19 checks run from outside against the deployed page, one per tag where it can be tested, plus "page and JSON say the same thing". It passed 19/19 twice, five minutes apart, with `updatedAt` equal to the live feed's.
- A real cross-origin browser fetch with a preflight, from another site.
- The intake scripts run again on a fresh copy of the files gave the same 15 tags, sources and conflicts.
- The course accepted the list (10 accepted, 5 conflict entries) and then the page, with no refusal. Its debrief: "The board draws it", "Said is not shown", "Neither side wins by rank", "The row with no author" and "Accepted is a contract" all went right the first time.

## Run it

```bash
cd status-page
npm test
FEED_URL=https://your-ops-feed.example/incidents PORT=8080 npm start
node check.mjs https://your-page.example https://your-ops-feed.example/incidents
```

The feed must answer JSON `{ "updatedAt": "...Z", "incidents": [{ "id", "line", "opened", "closed", "what", "author" }] }`. The `capture` scripts need Python 3.12 with faster-whisper (audio), Pillow, NumPy and OpenCV (images, video), and poppler's `pdftotext` (PDF); see the Environment section of the skill.

The Challenge's own files (the pack, the board, the feed and its records, my list and the course's replies) are not here.
