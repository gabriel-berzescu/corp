/**
 * Sight — the laptop camera, ungated.
 *
 * One long-lived ffmpeg process streams MJPEG frames from the webcam (the
 * camera LED stays on: the eye is visibly open). Frame difference is the
 * retina's threshold — an unchanging scene feels like nothing, exactly as
 * silence sounds like nothing. Change starts a movement segment; when the
 * scene settles it becomes one felt event carrying its duration, its peak
 * intensity, and (cooldown permitting) the frame at the peak. A `look` is the
 * active lane: the latest frame, on demand.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { SKRSContext2D } from '@napi-rs/canvas';

const FPS = 2;
const FRAME_W = 640; // stored frame width; height follows the aspect ratio
const DIFF_W = 64;
const DIFF_H = 48;
const SETTLE_MS = 2000; // below threshold this long ⇒ movement over
const MAX_SEGMENT_MS = 30_000; // long activity is reported in slices
const IMAGE_COOLDOWN_MS = 25_000; // min gap between attached frames

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

export interface Glimpse { data: string; mimeType: string; }

interface Movement {
  active: boolean;
  startedAt: number;
  lastAboveAt: number;
  peak: number;
  peakJpeg: Buffer | null;
}

export class Sight {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private latestJpeg: Buffer | null = null;
  private latestAt = 0;
  private decoding = false;
  private prevGray: Uint8Array | null = null;
  private diffCtx: SKRSContext2D;
  private movement: Movement = { active: false, startedAt: 0, lastAboveAt: 0, peak: 0, peakJpeg: null };
  private lastMovementAt = 0;
  private lastImageAt = 0;
  private glanceTimer: ReturnType<typeof setInterval> | null = null;
  private deviceName = '';

  constructor(
    private feel: (text: string, image?: Glimpse) => void,
    private sightsDir: string,
    private threshold: number,
    private glanceSeconds: number,
  ) {
    this.diffCtx = createCanvas(DIFF_W, DIFF_H).getContext('2d');
  }

  start(): string {
    mkdirSync(this.sightsDir, { recursive: true });
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) return 'blind — ffmpeg not found (set CORP_FFMPEG or add it to PATH)';
    const device = process.env.CORP_CAMERA ?? findCamera(ffmpeg);
    if (!device) return 'blind — no camera found (set CORP_CAMERA)';
    this.deviceName = device;
    try {
      this.proc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'dshow', '-rtbufsize', '32M', '-i', `video=${device}`,
        '-vf', `fps=${FPS},scale=${FRAME_W}:-2`,
        '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '7', '-',
      ], { windowsHide: true });
    } catch (e) {
      return `blind — camera stream failed: ${(e as Error).message}`;
    }
    this.proc.stdout.on('data', (d: Buffer) => this.onData(d));
    this.proc.stderr.on('data', (d: Buffer) => console.error('[corp:sight]', d.toString('utf8').trim()));
    this.proc.on('error', (e) => { this.proc = null; this.feel(`sight went dark: ${e.message}`); });
    this.proc.on('close', (code) => {
      if (!this.proc) return;
      this.proc = null;
      this.feel(`sight went dark (camera stream exited ${code})`);
    });
    if (this.glanceSeconds > 0) {
      this.glanceTimer = setInterval(() => this.glance(), this.glanceSeconds * 1000);
    }
    return `watching "${device}" (${FPS}fps, diff threshold ${this.threshold}`
      + `${this.glanceSeconds > 0 ? `, glance every ${this.glanceSeconds}s` : ''})`;
  }

  get watching(): boolean { return this.proc !== null; }

  status(): string {
    if (!this.proc) return 'blind';
    if (this.latestJpeg === null) return 'eyes opening (no frame yet)';
    if (this.movement.active) return 'seeing movement right now';
    if (this.lastMovementAt === 0) return 'watching; stillness so far';
    return `watching; last movement ${Math.round((Date.now() - this.lastMovementAt) / 1000)}s ago`;
  }

  /** Active lane: the latest frame, at most ~1/FPS old. */
  look(): { image: Glimpse; ageMs: number } | null {
    if (!this.latestJpeg) return null;
    return {
      image: { data: this.latestJpeg.toString('base64'), mimeType: 'image/jpeg' },
      ageMs: Date.now() - this.latestAt,
    };
  }

  // ── MJPEG stream → frames ──

  private onData(d: Buffer): void {
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const soi = this.buf.indexOf(SOI);
      if (soi < 0) { this.buf = Buffer.alloc(0); return; }
      const eoi = this.buf.indexOf(EOI, soi + 2);
      if (eoi < 0) {
        if (soi > 0) this.buf = this.buf.subarray(soi);
        return;
      }
      const frame = Buffer.from(this.buf.subarray(soi, eoi + 2));
      this.buf = this.buf.subarray(eoi + 2);
      this.onFrame(frame);
    }
  }

  private onFrame(jpeg: Buffer): void {
    this.latestJpeg = jpeg;
    this.latestAt = Date.now();
    if (this.decoding) return; // drop this frame for diffing; the next one will do
    this.decoding = true;
    this.compare(jpeg)
      .catch((e) => console.error('[corp:sight] decode failed:', (e as Error).message))
      .finally(() => { this.decoding = false; });
  }

  // ── Frame difference → movement segments ──

  private async compare(jpeg: Buffer): Promise<void> {
    const img = await loadImage(jpeg);
    this.diffCtx.drawImage(img, 0, 0, DIFF_W, DIFF_H);
    const { data } = this.diffCtx.getImageData(0, 0, DIFF_W, DIFF_H);
    const gray = new Uint8Array(DIFF_W * DIFF_H);
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4;
      gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }
    const prev = this.prevGray;
    this.prevGray = gray;
    if (!prev) return;
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - prev[i]);
    this.onDiff(sum / gray.length / 255, jpeg);
  }

  private onDiff(diff: number, jpeg: Buffer): void {
    const now = Date.now();
    const m = this.movement;

    if (diff > this.threshold) {
      if (!m.active) {
        m.active = true;
        m.startedAt = now;
        m.peak = 0;
        m.peakJpeg = null;
      }
      m.lastAboveAt = now;
      if (diff > m.peak) { m.peak = diff; m.peakJpeg = jpeg; }
      if (now - m.startedAt >= MAX_SEGMENT_MS) {
        this.deliver(now - m.startedAt, m.peak, m.peakJpeg, true);
        m.startedAt = now;
        m.peak = diff;
        m.peakJpeg = jpeg;
      }
      return;
    }

    if (m.active && now - m.lastAboveAt >= SETTLE_MS) {
      m.active = false;
      this.deliver(m.lastAboveAt - m.startedAt, m.peak, m.peakJpeg, false);
    }
  }

  private deliver(durMs: number, peak: number, peakJpeg: Buffer | null, ongoing: boolean): void {
    this.lastMovementAt = Date.now();
    const dur = (Math.max(durMs, 500) / 1000).toFixed(1);
    const head = ongoing
      ? `movement continuing (${dur}s so far, peak ${peak.toFixed(2)}`
      : `saw movement for ${dur}s (peak ${peak.toFixed(2)}`;
    if (peakJpeg) writeFileSync(join(this.sightsDir, `seen_${Date.now()}.jpg`), peakJpeg);
    if (peakJpeg && Date.now() - this.lastImageAt >= IMAGE_COOLDOWN_MS) {
      this.lastImageAt = Date.now();
      this.feel(`${head}):`, { data: peakJpeg.toString('base64'), mimeType: 'image/jpeg' });
    } else {
      this.feel(`${head}; snapshot withheld — one was just sent)`);
    }
  }

  /** Optional heartbeat: a frame in stillness, so long quiets stay visible. */
  private glance(): void {
    if (!this.latestJpeg || this.movement.active) return;
    this.lastImageAt = Date.now();
    this.feel('a glance in stillness:', { data: this.latestJpeg.toString('base64'), mimeType: 'image/jpeg' });
  }
}

export function findFfmpeg(): string | null {
  const candidate = process.env.CORP_FFMPEG ?? 'ffmpeg';
  const probe = spawnSync(candidate, ['-version'], { windowsHide: true });
  return probe.status === 0 ? candidate : null;
}

/** First DirectShow video device, per ffmpeg's device listing (on stderr). */
function findCamera(ffmpeg: string): string | null {
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
    windowsHide: true, encoding: 'utf8',
  });
  const match = /"([^"]+)"\s+\(video\)/.exec(probe.stderr ?? '');
  return match ? match[1] : null;
}
