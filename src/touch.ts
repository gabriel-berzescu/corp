/**
 * Touch — the Logitech F310 as a skin.
 *
 * Raw controller events are condensed into felt gestures: a button press
 * becomes one event carrying its duration, a stick excursion becomes one event
 * carrying the compass path it swept. The deadzone is the sensory threshold —
 * a resting stick feels like nothing, exactly as silence sounds like nothing.
 */
import sdl from '@kmamal/sdl';

const DEADZONE = 0.25;
const STICK_IDLE_MS = 180; // back inside the deadzone this long ⇒ gesture over
const TRIGGER_ON = 0.15;
const TRIGGER_OFF = 0.08;
const TAP_MS = 350;

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

interface TriggerState { active: boolean; max: number; startedAt: number; }

export class Touch {
  private controller: ReturnType<typeof sdl.controller.openDevice> | null = null;
  private presses = new Map<string, number>();
  private axes: Record<string, number> = {};
  private sticks: Record<'left' | 'right', StickState> = {
    left: { active: false, path: [], maxMag: 0, startedAt: 0, idleTimer: null },
    right: { active: false, path: [], maxMag: 0, startedAt: 0, idleTimer: null },
  };
  private triggers: Record<'left' | 'right', TriggerState> = {
    left: { active: false, max: 0, startedAt: 0 },
    right: { active: false, max: 0, startedAt: 0 },
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
    if (this.presses.size > 0) parts.push(`held down: ${[...this.presses.keys()].join(', ')}`);
    return parts.length > 0 ? parts.join('; ') : 'at rest';
  }

  private tryOpen(): string | null {
    if (this.controller) return null;
    const device = sdl.controller.devices[0];
    if (!device) return null;
    try {
      const instance = sdl.controller.openDevice(device);
      this.controller = instance;
      instance.on('buttonDown', ({ button }: { button: unknown }) => this.onButtonDown(String(button)));
      instance.on('buttonUp', ({ button }: { button: unknown }) => this.onButtonUp(String(button)));
      instance.on('axisMotion', ({ axis, value }: { axis: unknown; value: number }) => this.onAxis(String(axis), value));
      instance.on('close', () => { this.controller = null; });
      return device.name ?? 'controller';
    } catch (e) {
      console.error('[corp:touch] open failed:', (e as Error).message);
      return null;
    }
  }

  private onButtonDown(button: string): void {
    this.presses.set(button, Date.now());
  }

  private onButtonUp(button: string): void {
    let downAt = this.presses.get(button);
    let name = button;
    if (downAt === undefined && this.presses.size === 1) {
      // Some builds report the release by index rather than name; with a single
      // open press there is no ambiguity about which finger lifted.
      const [k, v] = this.presses.entries().next().value as [string, number];
      name = k; downAt = v;
    }
    if (downAt === undefined) return;
    this.presses.delete(name);
    const dur = Date.now() - downAt;
    this.feel(dur < TAP_MS
      ? `"${name}" tapped`
      : `"${name}" held ${(dur / 1000).toFixed(1)}s`);
  }

  private onAxis(axis: string, value: number): void {
    // Normalize e.g. 'leftStickX' → 'leftx', 'rightTrigger' → 'righttrigger'.
    const key = axis.toLowerCase().replace('stick', '');
    this.axes[key] = value;
    if (key === 'lefttrigger' || key === 'righttrigger') {
      this.onTrigger(key === 'lefttrigger' ? 'left' : 'right', value);
      return;
    }
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

  private onTrigger(side: 'left' | 'right', value: number): void {
    const t = this.triggers[side];
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
