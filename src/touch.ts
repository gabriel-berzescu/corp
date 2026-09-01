/**
 * Touch — the Logitech F310 as a skin.
 *
 * Only the analog surfaces are felt: the two sticks and the two triggers.
 * Buttons (face, bumpers, d-pad, stick clicks) are ignored — they are binary,
 * not touch-like. A stick excursion becomes one event carrying the compass
 * path it swept; a trigger squeeze becomes one event carrying its depth. The
 * deadzone is the sensory threshold — a resting stick feels like nothing,
 * exactly as silence sounds like nothing.
 */
import './sdl-env.js';
import sdl from '@kmamal/sdl';

const DEADZONE = 0.25;
const STICK_IDLE_MS = 180; // back inside the deadzone this long ⇒ gesture over
const TRIGGER_ON = 0.15;
const TRIGGER_OFF = 0.08;

const COMPASS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];

function compass(x: number, y: number): string {
  // SDL y is positive downward; flip so N is up.
  const angle = Math.atan2(-y, x); // [-π, π], 0 = E
  const idx = Math.round(angle / (Math.PI / 4));
  return COMPASS[(idx + 8) % 8];
}

interface StickState {
  active: boolean;
  path: string[]; // compass points visited, deduped
  maxMag: number;
  startedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface TriggerState { active: boolean; max: number; startedAt: number; rest: number | null; }

export class Touch {
  private controller: ReturnType<typeof sdl.controller.openDevice> | null = null;
  private axes: Record<string, number> = {};
  private sticks: Record<'left' | 'right', StickState> = {
    left: { active: false, path: [], maxMag: 0, startedAt: 0, idleTimer: null },
    right: { active: false, path: [], maxMag: 0, startedAt: 0, idleTimer: null },
  };
  private triggers: Record<'left' | 'right', TriggerState> = {
    left: { active: false, max: 0, startedAt: 0, rest: null },
    right: { active: false, max: 0, startedAt: 0, rest: null },
  };

  constructor(private feel: (text: string) => void) {}

  start(): string {
    sdl.controller.on('deviceAdd', () => {
      const name = this.tryOpen();
      if (name) this.feel(`a controller arrived: ${name}`);
    });
    sdl.controller.on('deviceRemove', () => {
      this.controller = null;
      this.feel('the controller was unplugged');
    });
    const name = this.tryOpen();
    return name ? `connected: ${name}` : 'no controller present (will feel it arrive)';
  }

  get connected(): boolean { return this.controller !== null; }

  /** Live proprioception — where the limbs are right now. */
  posture(): string {
    if (!this.controller) return 'no controller';
    const parts: string[] = [];
    for (const side of ['left', 'right'] as const) {
      const x = this.axes[`${side}x`] ?? 0;
      const y = this.axes[`${side}y`] ?? 0;
      const mag = Math.hypot(x, y);
      if (mag > DEADZONE) parts.push(`${side} stick held ${compass(x, y)} (${mag.toFixed(2)})`);
      const t = this.axes[`${side}trigger`] ?? 0;
      if (t > TRIGGER_ON) parts.push(`${side} trigger at ${t.toFixed(2)}`);
    }
    return parts.length > 0 ? parts.join('; ') : 'at rest';
  }

  private tryOpen(): string | null {
    if (this.controller) return null;
    const device = sdl.controller.devices[0];
    if (!device) return null;
    try {
      const instance = sdl.controller.openDevice(device);
      this.controller = instance;
      // Buttons are deliberately not subscribed — only the analog surfaces
      // (sticks, triggers) reach the sensorium.
      instance.on('axisMotion', ({ axis, value }: { axis: unknown; value: number }) => this.onAxis(String(axis), value));
      instance.on('close', () => { this.controller = null; });
      return device.name ?? 'controller';
    } catch (e) {
      console.error('[corp:touch] open failed:', (e as Error).message);
      return null;
    }
  }

  private onAxis(axis: string, value: number): void {
    // Normalize e.g. 'leftStickX' → 'leftx', 'rightTrigger' → 'righttrigger'.
    const key = axis.toLowerCase().replace('stick', '');
    if (key === 'lefttrigger' || key === 'righttrigger') {
      // onTrigger stores the calibrated value into this.axes itself.
      this.onTrigger(key === 'lefttrigger' ? 'left' : 'right', value);
      return;
    }
    this.axes[key] = value;
    const side = key.startsWith('left') ? 'left' : key.startsWith('right') ? 'right' : null;
    if (!side) return;
    this.onStick(side);
  }

  private onStick(side: 'left' | 'right'): void {
    const x = this.axes[`${side}x`] ?? 0;
    const y = this.axes[`${side}y`] ?? 0;
    const mag = Math.hypot(x, y);
    const s = this.sticks[side];

    if (mag > DEADZONE) {
      if (!s.active) {
        s.active = true;
        s.path = [];
        s.maxMag = 0;
        s.startedAt = Date.now();
      }
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
      const dir = compass(x, y);
      if (s.path[s.path.length - 1] !== dir) s.path.push(dir);
      if (mag > s.maxMag) s.maxMag = mag;
    } else if (s.active && !s.idleTimer) {
      s.idleTimer = setTimeout(() => this.endStickGesture(side), STICK_IDLE_MS);
    }
  }

  private endStickGesture(side: 'left' | 'right'): void {
    const s = this.sticks[side];
    s.idleTimer = null;
    if (!s.active) return;
    s.active = false;
    const dur = ((Date.now() - s.startedAt) / 1000).toFixed(1);
    const path = s.path.length > 8
      ? [...s.path.slice(0, 7), '…', s.path[s.path.length - 1]]
      : s.path;
    this.feel(s.path.length <= 1
      ? `${side} stick nudged ${path[0] ?? '?'} (${s.maxMag.toFixed(2)}, ${dur}s)`
      : `${side} stick swept ${path.join('→')} (max ${s.maxMag.toFixed(2)}, ${dur}s)`);
  }

  private onTrigger(side: 'left' | 'right', raw: number): void {
    const t = this.triggers[side];
    // Some pads report the trigger as a full-range axis resting at center —
    // the F310 on Windows sits at 0.50 released, 1.00 fully pulled. Learn the
    // resting level from the lowest value ever felt and rescale, so rest is
    // zero regardless of how the hardware reports it.
    if (t.rest === null || raw < t.rest) t.rest = raw;
    const value = t.rest >= 1 ? 0 : (raw - t.rest) / (1 - t.rest);
    this.axes[`${side}trigger`] = value;
    if (!t.active && value > TRIGGER_ON) {
      t.active = true;
      t.max = value;
      t.startedAt = Date.now();
    } else if (t.active) {
      if (value > t.max) t.max = value;
      if (value < TRIGGER_OFF) {
        t.active = false;
        const dur = ((Date.now() - t.startedAt) / 1000).toFixed(1);
        this.feel(`${side} trigger squeezed to ${t.max.toFixed(2)} (${dur}s)`);
      }
    }
  }
}
