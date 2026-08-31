/**
 * Hearing — the laptop microphone, ungated.
 *
 * The mic runs continuously; an RMS energy threshold is the eardrum. Below it
 * there is nothing to hear and nothing happens. Above it a segment starts
 * (with a little pre-roll so first syllables survive), ends after sustained
 * quiet, gets written to a WAV, and — when whisper.cpp is present — comes back
 * as words. Every heard segment is one felt event.
 */
import sdl from '@kmamal/sdl';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FREQ = 16000; // whisper's native rate
const CHUNK_MS = 100;
const PREROLL_MS = 350;
const SILENCE_END_MS = 900;
const MIN_SEGMENT_MS = 350;
const MAX_SEGMENT_MS = 30_000;

export interface WhisperConfig { cli: string; model: string; }

export class Hearing {
  private instance: ReturnType<typeof sdl.audio.openDevice> | null = null;
  private pump: ReturnType<typeof setInterval> | null = null;
  private preroll: Buffer[] = [];
  private prerollBytes = 0;
  private segment: Buffer[] = [];
  private segmentStartedAt = 0;
  private quietMs = 0;
  private voiced = false;
  private lastHeardAt = 0;
  private transcribeQueue: Promise<void> = Promise.resolve();
  private speaking = false;
  private speakingTail = 0;
  private segmentWhileSpeaking = false;

  constructor(
    private feel: (text: string) => void,
    private soundsDir: string,
    private whisper: WhisperConfig | null,
    private threshold: number,
  ) {}

  start(): string {
    mkdirSync(this.soundsDir, { recursive: true });
    const device = sdl.audio.devices.find((d) => d.type === 'recording');
    if (!device) return 'no microphone found';
    try {
      this.instance = sdl.audio.openDevice({ type: 'recording' }, {
        channels: 1, frequency: FREQ, format: 's16', buffered: 2048,
      });
      (this.instance as { play: () => void }).play();
    } catch (e) {
      return `microphone open failed: ${(e as Error).message}`;
    }
    this.pump = setInterval(() => this.drainMic(), CHUNK_MS);
    return `listening on "${device.name}" (16kHz, threshold ${this.threshold}`
      + `${this.whisper ? ', whisper STT' : ', NO STT — sounds felt but not understood'})`;
  }

  get listening(): boolean { return this.instance !== null; }

  /** Efference copy: while the voice speaks, the mic hears the body itself.
   *  Segments that start during speech (plus a short echo tail) are labeled
   *  rather than trusted as the world talking. */
  setSpeaking(active: boolean): void {
    if (this.speaking && !active) this.speakingTail = Date.now() + 500;
    this.speaking = active;
  }

  status(): string {
    if (!this.instance) return 'deaf';
    if (this.voiced) return 'hearing something right now';
    if (this.lastHeardAt === 0) return 'listening; nothing heard yet';
    return `listening; last sound ${Math.round((Date.now() - this.lastHeardAt) / 1000)}s ago`;
  }

  private drainMic(): void {
    const inst = this.instance as unknown as { queued: number; dequeue: (b: Buffer) => number } | null;
    if (!inst) return;
    while (inst.queued > 0) {
      const buf = Buffer.alloc(Math.min(inst.queued, 65536));
      const n = inst.dequeue(buf);
      if (n <= 0) break;
      this.onChunk(buf.subarray(0, n));
    }
  }

  private rms(chunk: Buffer): number {
    let sum = 0;
    const samples = chunk.length >> 1;
    if (samples === 0) return 0;
    for (let i = 0; i < samples; i++) {
      const v = chunk.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    return Math.sqrt(sum / samples);
  }

  private onChunk(chunk: Buffer): void {
    const level = this.rms(chunk);
    const chunkMs = (chunk.length / 2 / FREQ) * 1000;

    if (!this.voiced) {
      this.preroll.push(chunk);
      this.prerollBytes += chunk.length;
      const maxPreroll = (PREROLL_MS / 1000) * FREQ * 2;
      while (this.prerollBytes > maxPreroll && this.preroll.length > 1) {
        this.prerollBytes -= this.preroll.shift()!.length;
      }
      if (level > this.threshold) {
        this.voiced = true;
        this.segment = [...this.preroll];
        this.segmentStartedAt = Date.now();
        this.segmentWhileSpeaking = this.speaking || Date.now() < this.speakingTail;
        this.quietMs = 0;
        this.preroll = [];
        this.prerollBytes = 0;
      }
      return;
    }

    this.segment.push(chunk);
    // Hysteresis: the segment survives brief dips below the trigger level.
    if (level < this.threshold * 0.6) this.quietMs += chunkMs;
    else this.quietMs = 0;

    const durMs = Date.now() - this.segmentStartedAt;
    if (this.quietMs >= SILENCE_END_MS || durMs >= MAX_SEGMENT_MS) {
      this.voiced = false;
      const audio = Buffer.concat(this.segment);
      this.segment = [];
      const audibleMs = durMs - this.quietMs;
      if (audibleMs >= MIN_SEGMENT_MS) this.onSegment(audio, audibleMs);
    }
  }

  private onSegment(audio: Buffer, durMs: number): void {
    this.lastHeardAt = Date.now();
    const dur = (durMs / 1000).toFixed(1);
    const echo = this.segmentWhileSpeaking ? ' [while I was speaking — may be my own voice]' : '';
    const wavPath = join(this.soundsDir, `heard_${Date.now()}.wav`);
    writeFileSync(wavPath, wav(audio, FREQ));

    if (!this.whisper) {
      this.feel(`heard a sound (${dur}s)${echo} — saved to ${wavPath}, no STT configured`);
      return;
    }
    // One transcription at a time; segments queue behind each other.
    this.transcribeQueue = this.transcribeQueue.then(async () => {
      try {
        const text = await this.transcribe(wavPath);
        this.feel(text
          ? `heard (${dur}s)${echo}: "${text}"`
          : `heard a sound (${dur}s)${echo} — no words recognized`);
      } catch (e) {
        this.feel(`heard a sound (${dur}s) — transcription failed: ${(e as Error).message}`);
      }
    });
  }

  private transcribe(wavPath: string): Promise<string> {
    const { cli, model } = this.whisper!;
    return new Promise((resolve, reject) => {
      const proc = spawn(cli, ['-m', model, '-f', wavPath, '-l', 'auto', '--no-timestamps', '--no-prints'], {
        windowsHide: true,
      });
      let out = '';
      let err = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) return reject(new Error(`whisper exited ${code}: ${err.slice(-200)}`));
        resolve(out.replace(/\s+/g, ' ').trim());
      });
    });
  }
}

export function findWhisper(baseDir: string): WhisperConfig | null {
  const cli = process.env.WHISPER_CLI
    ?? [join(baseDir, 'whisper', 'Release', 'whisper-cli.exe'), join(baseDir, 'whisper', 'whisper-cli.exe')]
      .find(existsSync);
  const model = process.env.WHISPER_MODEL
    ?? [join(baseDir, 'whisper', 'ggml-base.bin')].find(existsSync);
  if (cli && model && existsSync(cli) && existsSync(model)) return { cli, model };
  return null;
}

/** Minimal 16-bit mono PCM WAV container. */
function wav(pcm: Buffer, freq: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(freq, 24);
  header.writeUInt32LE(freq * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
