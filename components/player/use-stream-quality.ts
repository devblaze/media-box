"use client";

import { useCallback, useRef, useState } from "react";
import { cachedLinkKbps, rememberLinkKbps } from "@/lib/bandwidth";
import {
  DEFAULT_TRANSCODE_QUALITY,
  canStepUpTo,
  higherQuality,
  linkCanCarry,
  lowerQuality,
  qualityForLinkKbps,
  qualityTotalKbps,
  transcodeQuality,
  type TranscodeQuality,
} from "@/lib/transcode-quality";
import { AUTO_QUALITY, loadQualityPref, saveQualityPref } from "./preferences";

/** Quiet period after any automatic rung change before auto may step back up. */
const AUTO_STEP_UP_COOLDOWN_MS = 90_000;

export type StreamQuality = ReturnType<typeof useStreamQuality>;

/**
 * Connection-aware stream sizing, shared across every title of a sitting: the
 * link to the server doesn't change when the episode does.
 *
 * Each changing call returns whether the rung in force moved, because a new rung
 * means a new transcode session and the caller must say where it picks up.
 */
export function useStreamQuality() {
  // How fast this browser can pull bytes from THIS server, in kbps. Seeded from a
  // recent measurement in this tab, so the second title of a sitting decides
  // instantly; null until one lands, which means "assume nothing".
  const [linkKbps, setLinkKbps] = useState<number | null>(() => cachedLinkKbps());
  // "auto" (follow the link speed) or a rung id the viewer picked by hand.
  const [pref, setPref] = useState<string>(loadQualityPref);
  // The rung "auto" has committed to. Deliberately a decision rather than a
  // reading off the live measurement: a number that wanders across a threshold
  // twice a minute would restart the stream twice a minute. Seeded from the
  // cached reading so the first stream is already the right size, rather than
  // started at the top and replaced a few seconds in.
  const [autoQuality, setAutoQuality] = useState<TranscodeQuality>(() => {
    const kbps = cachedLinkKbps();
    return kbps != null ? qualityForLinkKbps(kbps) : DEFAULT_TRANSCODE_QUALITY;
  });
  // Mirrors for the callbacks, which must stay stable: rebuilding them on every
  // rung change would restart the link probe along with them.
  const autoRef = useRef(autoQuality);
  const prefRef = useRef(pref);
  const lastAutoChangeRef = useRef(0);

  const commitAuto = useCallback((next: TranscodeQuality) => {
    autoRef.current = next;
    lastAutoChangeRef.current = Date.now();
    setAutoQuality(next);
  }, []);

  const isAuto = pref === AUTO_QUALITY;
  const active = isAuto ? autoQuality : transcodeQuality(pref);

  /**
   * A fresh reading of the connection, from the initial probe or from the
   * segments a transcode is delivering. This is where "auto" adjusts: down the
   * moment the current rung stops fitting, and back up once there is comfortable
   * headroom and it has been a while since the last move. Going up is harder than
   * staying (a wider margin, one rung at a time, never inside the cooldown),
   * because every move costs a new session and a moment of rebuffering.
   */
  const measure = useCallback(
    (kbps: number): boolean => {
      setLinkKbps(kbps);
      rememberLinkKbps(kbps);
      const current = autoRef.current;
      let next: TranscodeQuality | null = null;
      if (!linkCanCarry(qualityTotalKbps(current), kbps)) {
        const fitting = qualityForLinkKbps(kbps);
        if (fitting.id !== current.id) next = fitting;
      } else if (Date.now() - lastAutoChangeRef.current >= AUTO_STEP_UP_COOLDOWN_MS) {
        const up = higherQuality(current.id);
        if (up && canStepUpTo(up, kbps)) next = up;
      }
      if (!next) return false;
      commitAuto(next);
      return prefRef.current === AUTO_QUALITY;
    },
    [commitAuto]
  );

  /** Drop a rung because playback keeps stalling. False when there's nothing left
   *  to give up: the bottom of the ladder, or a rung the viewer pinned by hand. */
  const stepDown = useCallback((): boolean => {
    if (prefRef.current !== AUTO_QUALITY) return false;
    const next = lowerQuality(autoRef.current.id);
    if (!next) return false;
    commitAuto(next);
    return true;
  }, [commitAuto]);

  /** Pin a rung by hand, or hand the choice back to "auto". */
  const choose = useCallback(
    (id: string) => {
      prefRef.current = id;
      setPref(id);
      saveQualityPref(id);
      // Re-decide from the latest reading rather than resuming whatever rung auto
      // was last on, which may be minutes and a network ago.
      if (id === AUTO_QUALITY) commitAuto(qualityForLinkKbps(linkKbps));
    },
    [linkKbps, commitAuto]
  );

  return { linkKbps, pref, isAuto, autoQuality, active, measure, stepDown, choose };
}
