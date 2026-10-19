/**
 * Seeking a `<video>` without making it chase every key press.
 *
 * A seek into time that isn't buffered costs a round trip to the server, and on a
 * transcode it can cost an ffmpeg restart at the new spot. Five quick presses of
 * → used to be five of those, each throwing away the one before, which is where
 * skipping felt laggy. Here a seek that lands inside what is already buffered goes
 * out at once (it's free, so it should feel instant), and anything else waits for
 * the presses to stop and goes out once, at the final target.
 *
 * Framework-free so it can be unit tested; the player wraps it in a hook.
 */

/** Quiet time after the last seek input before an unbuffered seek is committed. */
export const SEEK_SETTLE_MS = 300;
/** How long the burst total stays on screen after the last input. */
export const SEEK_OSD_HOLD_MS = 900;
/** A target this close to a buffered range's edges still counts as inside it. */
const BUFFERED_SLACK_S = 0.25;

/** The parts of an HTMLMediaElement the coalescer touches. */
export interface SeekableMedia {
  currentTime: number;
  readonly duration: number;
  readonly buffered: {
    readonly length: number;
    start(index: number): number;
    end(index: number): number;
  };
}

/**
 * What the UI shows while a burst of seeks is under way: where it's going, how
 * far that is from where the burst began, whether it is still waiting to be
 * committed, and whether it is a run of relative skips (worth a running total on
 * screen) rather than a jump to a chosen time. `null` once the burst is over.
 */
export type SeekBurst = {
  target: number;
  delta: number;
  pending: boolean;
  relative: boolean;
} | null;

/** Whether `t` is inside one of the media's buffered ranges. */
export function isBuffered(media: SeekableMedia, t: number): boolean {
  const ranges = media.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (t >= ranges.start(i) - BUFFERED_SLACK_S && t <= ranges.end(i) - BUFFERED_SLACK_S) {
      return true;
    }
  }
  return false;
}

export class SeekCoalescer {
  private pending: number | null = null;
  private origin: number | null = null;
  private relative = false;
  private lastTarget = 0;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private burstTimer: ReturnType<typeof setTimeout> | null = null;
  private media: SeekableMedia | null = null;

  constructor(
    private readonly onBurst: (burst: SeekBurst) => void = () => {},
    private readonly settleMs = SEEK_SETTLE_MS
  ) {}

  /** Point at the element to seek (or none). Anything queued for the last one is dropped. */
  attach(media: SeekableMedia | null): void {
    if (media === this.media) return;
    this.cancel();
    this.media = media;
  }

  /** Seek relative to where the burst has got to (not to the lagging playhead). */
  seekBy(delta: number): void {
    const media = this.media;
    if (!media) return;
    const from = this.pending ?? media.currentTime;
    // Skips add up from where the run of them began.
    if (!this.relative || this.origin == null) this.origin = from;
    this.relative = true;
    this.go(media, from + delta);
  }

  /** Seek to an absolute time (the scrubber, a chapter, a jump key). */
  seekTo(time: number): void {
    const media = this.media;
    if (!media) return;
    this.origin = this.pending ?? media.currentTime;
    this.relative = false;
    this.go(media, time);
  }

  private go(media: SeekableMedia, time: number): void {
    const end = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : Infinity;
    const target = Math.max(0, Math.min(end, time));
    this.lastTarget = target;

    // Free and nothing queued ahead of it → go now. With a commit already queued,
    // queue behind it instead, so the seeks can't land out of order.
    if (this.pending == null && isBuffered(media, target)) {
      apply(media, target);
    } else {
      this.pending = target;
      this.clear("commit");
      this.commitTimer = setTimeout(() => this.commit(), this.settleMs);
    }
    this.emit();
  }

  /** Commit a queued seek now (e.g. the scrubber was released). */
  flush(): void {
    if (this.pending != null) this.commit();
  }

  /** Drop anything queued and clear the burst. */
  cancel(): void {
    this.clear("commit");
    this.clear("burst");
    const hadBurst = this.origin != null;
    this.pending = null;
    this.origin = null;
    if (hadBurst) this.onBurst(null);
  }

  private commit(): void {
    this.clear("commit");
    const target = this.pending;
    this.pending = null;
    const media = this.media;
    if (target != null && media) apply(media, target);
    this.emit();
  }

  private emit(): void {
    const origin = this.origin ?? this.lastTarget;
    this.onBurst({
      target: this.lastTarget,
      delta: this.lastTarget - origin,
      pending: this.pending != null,
      relative: this.relative,
    });
    this.clear("burst");
    this.burstTimer = setTimeout(() => {
      if (this.pending != null) return; // still waiting on a commit; it re-arms this
      this.origin = null;
      this.onBurst(null);
    }, this.settleMs + SEEK_OSD_HOLD_MS);
  }

  private clear(which: "commit" | "burst"): void {
    const timer = which === "commit" ? this.commitTimer : this.burstTimer;
    if (timer) clearTimeout(timer);
    if (which === "commit") this.commitTimer = null;
    else this.burstTimer = null;
  }
}

function apply(media: SeekableMedia, target: number): void {
  try {
    media.currentTime = target;
  } catch {
    /* not seekable yet: the element keeps its position */
  }
}
