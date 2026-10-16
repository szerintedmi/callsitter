# Real-call demos

The player at the top of the public page (`src/web/listen.ts`, page code in `src/web/client/listen*.ts`); `/listen/<slug>` opens it on that call, playing (the README's links). Each is a real recording from production. Its files in `calls/` are already redacted:

- `<slug>.mp3`: names beeped out (rules can redact the transcript only: the email is masked there but audible), each side normalized to -20 LUFS, a softened stereo mix (caller left, bot right) normalized to -16 LUFS.
- `<slug>.json`: the transcript with word timings (redactions shown as `[redacted]` or `*`), the beeps, each side's speech level for the mouths, and Jev's verdicts and the call-flow stages from the call's events.

- `<slug>.jpg`: its tile's thumbnail.

`posters/` holds the README's splash images (`record.ts <slug> --still <s> --size 1280x720 --poster`).

## Making one

The inputs name the people being redacted, so they stay in `data/demos/<slug>/` (gitignored), never in the repo.

1. Copy the recording and the database: `bun run prod get-recording <call id>`, `bun run prod get-db`.
2. Transcribe each side: `bun demos/tools/transcribe.ts data/prod/recordings/<id>.wav data/demos/<slug> [--from <s>] [--end <s>]`. Each utterance goes to Whisper on its own, because a whole channel at once drops lines after long silences. `--from`/`--end` take a clip; the timings stay on the recording's clock (transcribe a wider window first to find where the clip's words are: the database's times can be a few seconds off the recording's).
3. Write the redaction rules (`data/demos/redact.json`) and any fixes (`data/demos/<slug>/edits.json`). The formats are at the top of `tools/build.ts`. Whisper mishears names (one came back as "pita"), so read the whole transcript with `--preview`. Compare each mention with the call's transcript on the admin page. A rule's beep snaps to the pauses around the word, up to 0.45 s early, so it can swallow a filler right before a name ("Hi, uh, Peter"). For those, a per-call rules file with `"beep": false` (passed as a second `--redact`, the last one wins) and the beeps in `edits.json`, placed from the channel's energy.
4. Build: `bun demos/tools/build.ts <slug> --wav … --words data/demos/<slug> --redact data/demos/redact.json --db data/prod/scamsitter-….db --call <id>`, with the same `--from`/`--end` for a clip (its verdicts and stages are lined up on its first agent line; a stage entered earlier starts at 0). `--song <mp3> --lyrics <lyrics.json>` appends a song after the call, with karaoke lines (format at the top of `tools/build.ts`). The song's files aren't private but live with the other inputs in `data/demos/<slug>/`; only the combined MP3 is committed. `data/demos/build-all.sh` rebuilds every call with its options.
5. Check for leaks: transcribe the redacted audio (`transcribe.ts data/demos/<slug>/final.flac data/demos/<slug>/verify`) and search it for every redacted name. Whisper hears a beep as a censored word (`****`).
6. Add the call to `DEMOS` in `src/web/listen.ts`.

## Video

`bun demos/tools/record.ts <slug>` renders the player (`/listen/render/<slug>`) frame by frame in the installed Google Chrome, at 1920×1080 and 30 fps, to `data/demos/video/<slug>.mp4` with the audio. Every frame is a function of the call time, so workers render stretches in parallel. On an M-series Mac it runs at about 90 frames/s. Other options:

- `--from`/`--to` for a clip.
- `--size 1280x720` for a smaller frame.
- `--still 12,34` for single PNG frames.

The MP4s are too big for git. Upload them to YouTube, or drag one into a GitHub comment or README edit to get a playable link.
