# corp

An embodiment MCPL server. One process, one body, four organs:

| organ | hardware | direction | how it feels |
|---|---|---|---|
| **touch** | Logitech F310 gamepad | in | analog surfaces only: sticks → compass-path gestures (`left stick swept N→NE→E`); triggers → analog squeezes. Buttons are ignored. The deadzone is the sensory threshold. |
| **hearing** | laptop microphone | in | continuous, ungated. RMS voice-activity detection segments the stream; whisper.cpp transcribes (`heard (2.1s): "salut"`). Silence is not an event — dormancy is physics, not policy. |
| **voice** | laptop speakers | out | `say` via Windows SAPI TTS; utterances queue. While speaking, heard segments get an efference-copy label (`may be my own voice`). |
| **face** | small always-on-top window | out | `face_expression` presets (neutral, happy, joy, curious, thinking, sleepy, surprised, sad, love, wink) or free `face_draw` ops on a canvas. A breathing dot pulses at 10fps so the window always shows the body is alive. |

## Liveness: two lanes, one sensorium

- **Vigil** — the agent calls the blocking `perceive` tool in a loop and lives
  inside one long turn: sensations resolve the call (with a ~450ms batch window
  so gestures/utterances arrive whole), stillness returns a timeout report.
- **Cascade** — with no perceiver waiting, sensations debounce ~1.5s and go out
  as `push/event` wakes (`body.touch` / `body.hearing` feature sets, grant-gated
  per MCPL 0.5 — the policy plane is heartbeat-mcpl's `mcpl05.ts`).

Both lanes drain the same buffer; nothing is felt twice.

## Run

```bash
npm install && npm run build
npm test              # spawns the body, handshakes, pokes every organ
node dist/src/index.js --stdio
```

Test by hand with mcpl-harness:

```bash
cd ../mcpl-harness && npm run web -- --open -- node ../corp/dist/src/index.js --stdio
```

### Claude Code (mcpl-cc-bridge)

`../.mcpl-bridge.json` already registers corp with grant `["tools", "pushEvents"]`.
Tools work in any session; the **wake lane** (push events starting turns) needs:

```bash
claude --dangerously-load-development-channels plugin:mcpl-bridge@mcpl-bridge-dev
```

## Config (env)

| var | default | meaning |
|---|---|---|
| `CORP_DATA_DIR` | `<repo>/corp-data` | heard-segment WAVs land in `sounds/` |
| `CORP_VAD_RMS` | `0.012` | the eardrum: RMS level that starts a heard segment |
| `CORP_FACE_SIZE` | `380` | face window size (px) |
| `CORP_ORGANS` | `touch,hearing,voice,face` | disable organs by omission |
| `WHISPER_CLI` / `WHISPER_MODEL` | auto-detected in `<repo>/whisper/` | STT toolchain (`whisper-cli.exe`, `ggml-base.bin` multilingual) |

## Layout

- `src/index.ts` — server: handshake, MCPL 0.5 negotiated policy, tools, push lane
- `src/senses.ts` — the sensorium (vigil/cascade delivery)
- `src/touch.ts`, `src/hearing.ts`, `src/voice.ts`, `src/face.ts` — organs
- `src/mcpl05.ts` — grant/receipt machinery, copied from heartbeat-mcpl
- `test/smoke.mjs` — stdio host that exercises everything
