import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  SEEK_OSD_HOLD_MS,
  SEEK_SETTLE_MS,
  SeekCoalescer,
  isBuffered,
  type SeekBurst,
} from "./seek-coalescer";

/** A stand-in <video>: records every seek, with fixed buffered ranges. */
function media(currentTime: number, ranges: [number, number][] = [], duration = 3600) {
  const seeks: number[] = [];
  let time = currentTime;
  return {
    seeks,
    el: {
      get currentTime() {
        return time;
      },
      set currentTime(t: number) {
        time = t;
        seeks.push(t);
      },
      duration,
      buffered: {
        length: ranges.length,
        start: (i: number) => ranges[i][0],
        end: (i: number) => ranges[i][1],
      },
    },
  };
}

function attached(el: ReturnType<typeof media>["el"], onBurst?: (b: SeekBurst) => void) {
  const seeker = new SeekCoalescer(onBurst);
  seeker.attach(el);
  return seeker;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("isBuffered", () => {
  test("inside a range, not past its edge", () => {
    const m = media(0, [[10, 40]]).el;
    expect(isBuffered(m, 20)).toBe(true);
    expect(isBuffered(m, 39.9)).toBe(false);
    expect(isBuffered(m, 50)).toBe(false);
  });
});

describe("SeekCoalescer", () => {
  test("a burst of unbuffered skips goes out as one seek, at the final target", () => {
    const m = media(100);
    const seeker = attached(m.el);
    seeker.seekBy(10);
    seeker.seekBy(10);
    seeker.seekBy(10);
    expect(m.seeks).toEqual([]);
    vi.advanceTimersByTime(SEEK_SETTLE_MS);
    expect(m.seeks).toEqual([130]);
  });

  test("a skip into what's buffered goes out at once", () => {
    const m = media(100, [[90, 160]]);
    const seeker = attached(m.el);
    seeker.seekBy(10);
    expect(m.seeks).toEqual([110]);
  });

  test("once a seek is queued, a buffered one queues behind it", () => {
    const m = media(100, [[90, 160]]);
    const seeker = attached(m.el);
    seeker.seekBy(200); // 300, not buffered → queued
    seeker.seekBy(-180); // 120, buffered — but it must not overtake the 300
    expect(m.seeks).toEqual([]);
    vi.advanceTimersByTime(SEEK_SETTLE_MS);
    expect(m.seeks).toEqual([120]);
  });

  test("clamps to the media's length", () => {
    const m = media(10, [], 60);
    const seeker = attached(m.el);
    seeker.seekBy(-30);
    vi.advanceTimersByTime(SEEK_SETTLE_MS);
    seeker.seekTo(500);
    vi.advanceTimersByTime(SEEK_SETTLE_MS);
    expect(m.seeks).toEqual([0, 60]);
  });

  test("reports the burst total, then clears it", () => {
    const bursts: SeekBurst[] = [];
    const m = media(100);
    const seeker = attached(m.el, (b) => bursts.push(b));
    seeker.seekBy(10);
    seeker.seekBy(10);
    expect(bursts.at(-1)).toEqual({ target: 120, delta: 20, pending: true, relative: true });
    vi.advanceTimersByTime(SEEK_SETTLE_MS);
    expect(bursts.at(-1)).toEqual({ target: 120, delta: 20, pending: false, relative: true });
    vi.advanceTimersByTime(SEEK_SETTLE_MS + SEEK_OSD_HOLD_MS);
    expect(bursts.at(-1)).toBeNull();
  });

  test("a jump to a chosen time starts its own burst, not a running total", () => {
    const bursts: SeekBurst[] = [];
    const m = media(100);
    const seeker = attached(m.el, (b) => bursts.push(b));
    seeker.seekBy(10);
    seeker.seekTo(400);
    expect(bursts.at(-1)).toEqual({ target: 400, delta: 290, pending: true, relative: false });
    seeker.seekBy(10); // skips after the jump count from the jump
    expect(bursts.at(-1)).toEqual({ target: 410, delta: 10, pending: true, relative: true });
  });

  test("flush commits now; cancel drops what's queued", () => {
    const m = media(100);
    const seeker = attached(m.el);
    seeker.seekTo(500);
    seeker.flush();
    expect(m.seeks).toEqual([500]);
    seeker.seekTo(900);
    seeker.cancel();
    vi.advanceTimersByTime(SEEK_SETTLE_MS * 2);
    expect(m.seeks).toEqual([500]);
  });

  test("moving to another element drops what was queued for the old one", () => {
    const a = media(100);
    const b = media(0);
    const seeker = attached(a.el);
    seeker.seekTo(900);
    seeker.attach(b.el);
    vi.advanceTimersByTime(SEEK_SETTLE_MS * 2);
    expect(a.seeks).toEqual([]);
    expect(b.seeks).toEqual([]);
  });
});
