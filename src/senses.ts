/**
 * The sensorium — one stream of everything the body feels, with two delivery
 * lanes that never duplicate each other:
 *
 *   - vigil lane: a pending `perceive` call (the agent living inside one long
 *     turn) claims events as they arrive. A short batch window lets a gesture
 *     or an utterance finish before delivery, so the agent perceives whole
 *     movements rather than fragments.
 *   - cascade lane: with no perceiver waiting, events accumulate briefly and
 *     go out as push/event wakes (emission itself is grant-gated in index.ts).
 *
 * Silence is not an event. When nothing crosses a threshold, nothing is felt,
 * nothing is delivered, and the body simply costs nothing — dormancy falls out
 * of the physics instead of being a gate somebody imposed.
 */

export interface SenseEvent {
  t: number; // epoch ms
  organ: 'touch' | 'hearing' | 'body';
  text: string;
}

interface Waiter {
  resolve: (events: SenseEvent[]) => void;
  timeoutTimer: ReturnType<typeof setTimeout>;
  batchTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_PENDING = 1000;

export class Sensorium {
  private pending: SenseEvent[] = [];
  private waiter: Waiter | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by the server: receives batches for the cascade (push/event) lane. */
  onPushBatch: ((events: SenseEvent[]) => void) | null = null;

  constructor(
    private batchMs = 450,
    private pushDebounceMs = 1500,
  ) {}

  /** An organ reports something felt. */
  feel(organ: SenseEvent['organ'], text: string): void {
    this.pending.push({ t: Date.now(), organ, text });
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    if (this.waiter) {
      // Vigil lane: let the rest of the gesture land, then wake the perceiver.
      if (!this.waiter.batchTimer) {
        this.waiter.batchTimer = setTimeout(() => this.resolveWaiter(), this.batchMs);
      }
    } else {
      // Cascade lane: debounce so one sweep of the stick is one wake, not ten.
      if (this.pushTimer) clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => this.flushToPush(), this.pushDebounceMs);
    }
  }

  /**
   * Block until the body feels something (or the timeout passes), then return
   * everything felt since the last delivery. A newer perceive displaces an
   * older one (the old call returns empty) — there is one point of view.
   */
  perceive(timeoutMs: number): Promise<SenseEvent[]> {
    // Perceive claims anything queued for the push lane.
    if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = null; }
    if (this.waiter) this.resolveWaiter();
    if (this.pending.length > 0) return Promise.resolve(this.drain());

    return new Promise((resolve) => {
      const timeoutTimer = setTimeout(() => {
        if (this.waiter && this.waiter.resolve === resolve) {
          this.waiter = null;
          resolve(this.drain());
        }
      }, timeoutMs);
      this.waiter = { resolve, timeoutTimer, batchTimer: null };
    });
  }

  get hasPerceiver(): boolean { return this.waiter !== null; }

  private drain(): SenseEvent[] {
    const events = this.pending;
    this.pending = [];
    return events;
  }

  private resolveWaiter(): void {
    const w = this.waiter;
    if (!w) return;
    this.waiter = null;
    clearTimeout(w.timeoutTimer);
    if (w.batchTimer) clearTimeout(w.batchTimer);
    w.resolve(this.drain());
  }

  private flushToPush(): void {
    this.pushTimer = null;
    if (this.waiter || this.pending.length === 0) return;
    this.onPushBatch?.(this.drain());
  }
}

export function clockTime(t: number): string {
  return new Date(t).toLocaleTimeString('en-GB', { hour12: false });
}
