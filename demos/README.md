# Real-call demos

The player at the top of the public page (`src/web/listen.ts`, page code in `src/web/client/listen*.ts`); `/listen/<slug>` opens it on that call, playing (the README's links). Each is a real recording from production. Its files in `calls/` are already redacted: Subtitles show one line at a time, two in a quick exchange or cross-talk (`shownLines` in `src/web/client/listen-story.ts`); on a phone they sit under the stage. The ⛶ button (or turning a phone to landscape while it plays) puts the player in fullscreen, the browser's or, on iPhone Safari, a CSS one; ✕, Escape, Back or turning back to portrait leave it (`src/web/client/listen-fullscreen.ts`).

- `<slug>.mp3`: names beeped out (rules can redact the transcript only: the email is masked there but audible), each side normalized to -20 LUFS, a softened stereo mix (caller left, bot right) normalized to -16 LUFS.
- `<slug>.json`: the transcript with word timings (redactions shown as `[redacted]` or `*`), the beeps, each side's speech level for the mouths, and Jev's verdicts and the call-flow stages from the call's events.

- `<slug>.jpg`: its tile's thumbnail.

`posters/` holds the README's splash images (`record.ts <slug> --still <s> --size 1280x720 --poster`).

## Making one

The inputs name the people being redacted, so they stay in `data/demos/<slug>/` (gitignored), never in the repo.

1. Copy the recording and the database: `bun run prod get-recording <call id>`, `bun run prod get-db`. The tools take the WAV; a call with only its MP3 left (`recordings.delete_wav_after_mp3`) can be decoded back: `ffmpeg -i <id>.mp3 -c:a pcm_s16le <id>.wav` (lossy, but fine for transcribing).
2. Transcribe each side: `bun demos/tools/transcribe.ts data/prod/recordings/<id>.wav data/demos/<slug> [--from <s>] [--end <s>]`. Each utterance goes to Whisper on its own, because a whole channel at once drops lines after long silences. `--from`/`--end` take a clip; the timings stay on the recording's clock (transcribe a wider window first to find where the clip's words are: the database's times can be a few seconds off the recording's).
3. Write the redaction rules (`data/demos/redact.json`) and any fixes (`data/demos/<slug>/edits.json`). The formats are at the top of `tools/build.ts`. Whisper mishears names (one came back as "pita"), so read the whole transcript with `--preview`. Compare each mention with the call's transcript on the admin page. A rule's beep snaps to the pauses around the word, up to 0.45 s early, so it can swallow a filler right before a name ("Hi, uh, Peter"). For those, a per-call rules file with `"beep": false` (passed as a second `--redact`, the last one wins) and the beeps in `edits.json`, placed from the channel's energy.
4. Build: `bun demos/tools/build.ts <slug> --wav … --words data/demos/<slug> --redact data/demos/redact.json --db data/prod/callsitter-….db --call <id>`, with the same `--from`/`--end` for a clip (its verdicts and stages are lined up on its first agent line; a stage entered earlier starts at 0). `--song <mp3> --lyrics <lyrics.json>` appends a song after the call, with karaoke lines (format at the top of `tools/build.ts`). The song's files aren't private but live with the other inputs in `data/demos/<slug>/`; only the combined MP3 is committed. `trims` in `edits.json` cut pauses out of the call (crossfaded, everything after moved up); `gap` and `tease` in `lyrics.json` set the silence before the song and how early its banner comes. `--prologue <prologue.json>` puts an opening before the call (below). `data/demos/build-all.sh` rebuilds every call with its options.
5. Check for leaks: transcribe the redacted audio (`transcribe.ts data/demos/<slug>/final.flac data/demos/<slug>/verify`) and search it for every redacted name. Whisper hears a beep as a censored word (`****`).
6. Add the call to `DEMOS` in `src/web/listen.ts`. For its tile in the main README, a poster (`record.ts <slug> --still <s> --size 1280x720 --poster`, saved as `posters/<slug>.jpg`) and its kind (scam, spam or genuine) and length under it.

## Prologue

A call can open with a prologue: a storyboard played before it, on the same clock, so the landing page and a video show the same thing (areyouai's: the phone ringing with the caller ID, the bot picking up, the caller's intro, the scam banner, a time-lapse to eight minutes in, the owner texting the bot, the antenna blinking as it gets the message). Its spec, `data/demos/<slug>/prologue.json`, is private like the other inputs (it names stretches of the recording). The format is at the top of `tools/prologue.ts`; in short:

- `voice`: lines from the recording, placed on the prologue's clock and cut to their words (subtitles from a whole-recording transcript, with the slug's `edits.json` and the rules applied). A background one (`gain`, either or `both` sides, an ffmpeg `filter`) has no subtitle and no mouth.
- `offLimits`: stretches of the recording never to use (names, an email). The build stops on a line that touches one, or that holds a word a rule would beep.
- `beats`: what the player draws (`src/web/client/listen-story.ts` Beat): the ring, the camera (follow one side), cards, a tag, the clock, a dim, the phone, the antenna's blinks. Each brings its sounds (`tools/sfx.ts`, synthesized with ffmpeg); `sfx` adds more.
- `stages`: call-flow stages entered in it, so the player's own banner ("SCAM SPOTTED") plays there; `mime`: a mouth moving where nobody's heard.
- Times are seconds or names with an offset (`"intro.end+0.6"`, `"stage+3.3"`, `"song"`), so retiming one beat moves what hangs off it.

The build lays the lines (each side evened out) and the effects, makes the whole as loud as the call, and puts it first in the MP3 and `final.flac`; the JSON gets the prologue's lines and stages, its storyboard in `prologue`, and everything else moved later by its length.

## Video

`bun demos/tools/record.ts <slug>` renders the player (`/listen/render/<slug>`) frame by frame in the installed Google Chrome, at 1920×1080 and 30 fps, to `data/demos/video/<slug>.mp4` with the audio. Every frame is a function of the call time, so workers render stretches in parallel. On an M-series Mac it runs at about 90 frames/s. Other options:

- `--from`/`--to` for a clip.
- `--size 1280x720` for a smaller frame. Any shape works: `--size 1080x1920` (Shorts, Reels, TikTok) stacks the rooms, the caller's over the bot's, each side's subtitle under its own room, and the song's disco becomes one camera on both. It keeps text off the bottom fifth and the right edge, where those apps put the title and buttons (`--no-safe` lets it in). `--layout wide|stack|follow` overrides the layout chosen from the shape (follow: one camera on whoever spoke last). 16:9 looks as it always did.
- `--still 12,34` for single PNG frames, to `data/demos/stills/` (`--out <dir>` for another folder).

### Edits

`--edit <cut.json>` renders an edit of a call instead of the whole thing: stretches of it in any order, stills, sped-up montages, with cards, the phone owner's messages to the bot, a call timer and an end card over them. The audio is cut from the same stretches with short crossfades, every cut on a frame, so it stays in sync. `--from`/`--to` and `--still` are then on the edit's clock (`--still` is the quick way to check one). The format is at the top of `tools/record.ts`, the types in `src/web/client/listen-cut.ts`. In short:

```json
{"segments": [{"from": 0, "to": 5.4}, {"from": 5.4, "to": 23.5, "speed": 6}, {"from": 72, "to": 82, "snap": "bar"}, {"hold": 82.1, "for": 2}],
 "overlays": [{"type": "card", "start": 0, "end": 1.5, "text": "MY *BOT* PICKED UP"},
              {"type": "message", "start": 6.6, "end": 12, "chat": "My bot", "text": ["Ask him what model he is"]},
              {"type": "clock", "start": 1.5, "end": 18, "label": "into the call"},
              {"type": "endcard", "start": 28.9, "title": "CALLSITTER", "url": "callsitter.org"}]}
```

Segments are in the call's seconds, overlays in the edit's. Edits that aren't the app's own (social cuts) live with whoever makes them; the tool takes a path from the working directory, and finds the demos' files from the repo wherever it runs.

The MP4s are too big for git. Upload them to YouTube, or drag one into a GitHub comment or README edit to get a playable link.
