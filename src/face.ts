/**
 * Face — a small always-on-top window the agent draws on.
 *
 * Two layers: a base canvas that only tools repaint (expressions or free
 * drawing), and a compositor pass at 10fps that adds a soft breathing dot in
 * the corner — the one thing that moves without the agent, so a glance at the
 * window answers "is the body alive" even mid-thought.
 */
import sdl from '@kmamal/sdl';
import { createCanvas, Canvas, SKRSContext2D } from '@napi-rs/canvas';

export interface DrawOp {
  op: 'clear' | 'rect' | 'circle' | 'ellipse' | 'line' | 'polygon' | 'arc' | 'text';
  [k: string]: unknown;
}

const BG = '#141824';
const INK = '#e8e4d8';

export class Face {
  private win: ReturnType<typeof sdl.video.createWindow> | null = null;
  private base: Canvas;
  private compose: Canvas;
  private w = 0;
  private h = 0;
  private pulse: ReturnType<typeof setInterval> | null = null;
  private phase = 0;
  currentExpression = 'sleepy';

  constructor(private feel: (text: string) => void, private size: number) {
    this.base = createCanvas(size, size);
    this.compose = createCanvas(size, size);
  }

  start(): string {
    try {
      this.win = sdl.video.createWindow({
        title: 'corp', width: this.size, height: this.size, alwaysOnTop: true, resizable: false,
      });
    } catch (e) {
      return `face window failed: ${(e as Error).message}`;
    }
    this.w = this.win.pixelWidth;
    this.h = this.win.pixelHeight;
    this.base = createCanvas(this.w, this.h);
    this.compose = createCanvas(this.w, this.h);
    this.win.on('close', () => {
      this.win = null;
      if (this.pulse) { clearInterval(this.pulse); this.pulse = null; }
      this.feel('the face window was closed by the world');
    });
    this.expression('sleepy');
    this.pulse = setInterval(() => this.render(), 100);
    return `face open (${this.w}x${this.h}, always on top)`;
  }

  get open(): boolean { return this.win !== null; }

  private render(): void {
    if (!this.win) return;
    const ctx = this.compose.getContext('2d');
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.drawImage(this.base, 0, 0);
    // Breathing dot, ~12 breaths/minute.
    this.phase += 0.063;
    const breath = (Math.sin(this.phase) + 1) / 2;
    ctx.beginPath();
    ctx.arc(this.w - 16, this.h - 16, 3 + breath * 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(120, 200, 160, ${0.25 + breath * 0.55})`;
    ctx.fill();
    const image = ctx.getImageData(0, 0, this.w, this.h);
    this.win.render(this.w, this.h, this.w * 4, 'rgba32', Buffer.from(image.data.buffer));
  }

  /** Execute a list of drawing ops on the base layer. Returns ops applied. */
  draw(ops: DrawOp[]): number {
    const ctx = this.base.getContext('2d');
    let applied = 0;
    for (const o of ops) {
      this.applyOp(ctx, o);
      applied++;
    }
    this.currentExpression = 'custom drawing';
    return applied;
  }

  private applyOp(ctx: SKRSContext2D, o: DrawOp): void {
    const num = (k: string, d = 0): number => (typeof o[k] === 'number' ? (o[k] as number) : d);
    const str = (k: string, d?: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : d);
    const fill = str('fill');
    const stroke = str('stroke');
    const width = num('width', 3);
    const paint = (): void => {
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke || !fill) { ctx.strokeStyle = stroke ?? INK; ctx.lineWidth = width; ctx.stroke(); }
    };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (o.op) {
      case 'clear':
        ctx.fillStyle = str('color', BG)!;
        ctx.fillRect(0, 0, this.w, this.h);
        break;
      case 'rect': {
        ctx.beginPath();
        const r = num('radius', 0);
        if (r > 0) ctx.roundRect(num('x'), num('y'), num('w'), num('h'), r);
        else ctx.rect(num('x'), num('y'), num('w'), num('h'));
        paint();
        break;
      }
      case 'circle':
        ctx.beginPath();
        ctx.arc(num('x'), num('y'), num('r', 10), 0, Math.PI * 2);
        paint();
        break;
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse(num('x'), num('y'), num('rx', 10), num('ry', 10), (num('rotationDeg') * Math.PI) / 180, 0, Math.PI * 2);
        paint();
        break;
      case 'arc':
        ctx.beginPath();
        ctx.arc(num('x'), num('y'), num('r', 10), (num('startDeg') * Math.PI) / 180, (num('endDeg', 360) * Math.PI) / 180);
        paint();
        break;
      case 'line':
      case 'polygon': {
        const points = Array.isArray(o.points) ? (o.points as [number, number][]) : [];
        if (points.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(points[0][0], points[0][1]);
        for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
        if (o.op === 'polygon') ctx.closePath();
        paint();
        break;
      }
      case 'text': {
        ctx.font = `${num('size', 24)}px ${str('font', 'sans-serif')}`;
        ctx.fillStyle = str('color', INK)!;
        ctx.textAlign = (str('align', 'left') as 'left' | 'right' | 'center');
        ctx.fillText(str('text', '')!, num('x'), num('y'));
        break;
      }
    }
  }

  /** Prebuilt expressions — quick emotes without composing draw ops. */
  expression(name: string): boolean {
    const presets: Record<string, FaceParams> = {
      neutral:   { eyeOpen: 1, mouthCurve: 0.1, mouthOpen: 0 },
      happy:     { eyeOpen: 1, mouthCurve: 0.9, mouthOpen: 0, blush: true },
      joy:       { eyeOpen: 0.15, eyeSmile: true, mouthCurve: 1, mouthOpen: 0.5, blush: true },
      curious:   { eyeOpen: 1, look: [0.5, -0.4], mouthCurve: 0.2, mouthOpen: 0.35, browTilt: 0.35 },
      thinking:  { eyeOpen: 0.8, look: [-0.55, -0.5], mouthCurve: -0.05, mouthOpen: 0, dots: true },
      sleepy:    { eyeOpen: 0.06, mouthCurve: 0.15, mouthOpen: 0.12, zzz: true },
      surprised: { eyeOpen: 1.35, mouthCurve: 0, mouthOpen: 0.9 },
      sad:       { eyeOpen: 0.7, mouthCurve: -0.7, mouthOpen: 0, browTilt: -0.3 },
      love:      { eyeOpen: 1, hearts: true, mouthCurve: 0.8, mouthOpen: 0.3, blush: true },
      wink:      { eyeOpen: 1, wink: true, mouthCurve: 0.7, mouthOpen: 0 },
    };
    const p = presets[name];
    if (!p) return false;
    this.paintFace(p);
    this.currentExpression = name;
    return true;
  }

  static expressionNames(): string[] {
    return ['neutral', 'happy', 'joy', 'curious', 'thinking', 'sleepy', 'surprised', 'sad', 'love', 'wink'];
  }

  private paintFace(p: FaceParams): void {
    const ctx = this.base.getContext('2d');
    const s = this.w;
    const u = s / 100; // face units
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, s, s);

    const [lx, ly] = p.look ?? [0, 0];
    const eyeY = 42 * u + ly * 4 * u;
    const eyeDX = 18 * u;
    const eyeR = 8.5 * u;

    for (const side of [-1, 1]) {
      const ex = 50 * u + side * eyeDX + lx * 3 * u;
      const open = p.wink && side === 1 ? 0.08 : (p.eyeOpen ?? 1);
      if (p.hearts) {
        drawHeart(ctx, ex, eyeY, eyeR * 1.25, '#ff6b81');
        continue;
      }
      if (p.eyeSmile || open <= 0.2) {
        // Closed/smiling eye: an arc.
        ctx.beginPath();
        const lift = p.eyeSmile ? -1 : 1;
        ctx.arc(ex, eyeY + lift * eyeR * 0.4, eyeR * 0.9, lift > 0 ? 0 : Math.PI, lift > 0 ? Math.PI : 0, lift < 0);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 3.4 * u;
        ctx.lineCap = 'round';
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.ellipse(ex, eyeY, eyeR, eyeR * Math.min(open, 1.35), 0, 0, Math.PI * 2);
        ctx.fillStyle = INK;
        ctx.fill();
        // Pupil glint.
        ctx.beginPath();
        ctx.arc(ex + eyeR * 0.3 + lx * eyeR * 0.3, eyeY - eyeR * 0.3 * Math.min(open, 1) + ly * eyeR * 0.2, eyeR * 0.22, 0, Math.PI * 2);
        ctx.fillStyle = BG;
        ctx.fill();
      }
      if (p.browTilt) {
        ctx.beginPath();
        const by = eyeY - eyeR * 2.1;
        ctx.moveTo(ex - eyeR, by + side * p.browTilt * -6 * u * 0.5);
        ctx.lineTo(ex + eyeR, by + side * p.browTilt * 6 * u * 0.5);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2.6 * u;
        ctx.stroke();
      }
    }

    if (p.blush) {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(50 * u + side * 30 * u, 56 * u, 6 * u, 3.5 * u, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 120, 130, 0.35)';
        ctx.fill();
      }
    }

    // Mouth.
    const my = 68 * u;
    const mw = 15 * u;
    const curve = (p.mouthCurve ?? 0) * 10 * u;
    const openH = (p.mouthOpen ?? 0) * 12 * u;
    ctx.beginPath();
    if (openH > 1) {
      ctx.ellipse(50 * u, my + curve * 0.3, mw * (0.55 + (p.mouthOpen ?? 0) * 0.3), openH, 0, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.fill();
    } else {
      ctx.moveTo(50 * u - mw, my - curve * 0.35);
      ctx.quadraticCurveTo(50 * u, my + curve, 50 * u + mw, my - curve * 0.35);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3.4 * u;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    if (p.dots) {
      ctx.fillStyle = INK;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(76 * u + i * 6 * u, 28 * u - i * 3 * u, 1.8 * u, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (p.zzz) {
      ctx.fillStyle = 'rgba(232, 228, 216, 0.75)';
      ctx.textAlign = 'left';
      ctx.font = `${9 * u}px sans-serif`;
      ctx.fillText('z', 72 * u, 30 * u);
      ctx.font = `${6.5 * u}px sans-serif`;
      ctx.fillText('z', 80 * u, 22 * u);
      ctx.font = `${4.5 * u}px sans-serif`;
      ctx.fillText('z', 86 * u, 16 * u);
    }
  }
}

interface FaceParams {
  eyeOpen?: number;
  eyeSmile?: boolean;
  wink?: boolean;
  hearts?: boolean;
  look?: [number, number];
  browTilt?: number;
  mouthCurve?: number;
  mouthOpen?: number;
  blush?: boolean;
  dots?: boolean;
  zzz?: boolean;
}

function drawHeart(ctx: SKRSContext2D, x: number, y: number, r: number, color: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y + r * 0.9);
  ctx.bezierCurveTo(x - r * 1.4, y - r * 0.1, x - r * 0.7, y - r, x, y - r * 0.35);
  ctx.bezierCurveTo(x + r * 0.7, y - r, x + r * 1.4, y - r * 0.1, x, y + r * 0.9);
  ctx.fillStyle = color;
  ctx.fill();
}
