import { useCallback, useEffect, useRef, useState } from "react";

import { getState } from "./api.js";

/**
 * Poll /state on an interval and keep a one-time clock offset.
 *
 * The offset is measured once, from the first response, and corrected for half
 * the round trip. Every countdown on every device is then computed against the
 * server's clock, not the device's — which is the whole point of `phaseEndsAt`.
 */
const STALE_AFTER_MS = 6000;

export function useGameState(pollMs, adminKey) {
  const [state, setState] = useState(null);
  const [offline, setOffline] = useState(false);
  const [stale, setStale] = useState(false);
  const offsetRef = useRef(null);

  useEffect(() => {
    let stopped = false;
    let timer;
    // Requests now have a timeout, so they overlap. Without a sequence number
    // an older /state can land after a newer one and rewind the projector
    // mid-reveal. Only the newest response issued is ever applied.
    let issued = 0;
    let applied = 0;
    let lastOkAt = Date.now();

    const schedule = () => {
      if (stopped) return;
      // ±12.5% jitter. Every client starts polling when the QR goes up, and
      // any global pause re-aligns them; jitter disperses the herd by design
      // rather than by luck.
      timer = setTimeout(tick, pollMs * (0.875 + Math.random() * 0.25));
    };

    const tick = async () => {
      const seq = ++issued;
      try {
        const sentAt = Date.now();
        const next = await getState(adminKey);
        const receivedAt = Date.now();
        if (stopped || seq <= applied) return;
        applied = seq;

        if (offsetRef.current === null) {
          offsetRef.current = next.serverNow - (sentAt + receivedAt) / 2;
        }
        lastOkAt = receivedAt;
        setState(next);
        setOffline(false);
        setStale(false);
      } catch {
        if (stopped) return;
        setOffline(true);
        setStale(Date.now() - lastOkAt > STALE_AFTER_MS);
      } finally {
        schedule();
      }
    };

    // Coming back from a locked screen or a backgrounded tab, the first thing
    // rendered would otherwise be the previous question's countdown.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || stopped) return;
      clearTimeout(timer);
      tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pollMs, adminKey]);

  return { state, setState, offline, stale, offset: offsetRef.current ?? 0 };
}

const FRAME_MS = 50; // ~20fps: smooth enough for a projected progress bar

/** Milliseconds left on the current phase, or null when nothing is running. */
export function useCountdown(phaseEndsAt, offset) {
  const remainingNow = useCallback(
    () => (phaseEndsAt == null ? null : Math.max(0, phaseEndsAt - (Date.now() + offset))),
    [phaseEndsAt, offset],
  );
  const [remaining, setRemaining] = useState(remainingNow);

  useEffect(() => {
    if (phaseEndsAt == null) {
      setRemaining(null);
      return undefined;
    }

    let raf;
    let lastPaint = 0;
    const loop = (now) => {
      if (now - lastPaint >= FRAME_MS) {
        lastPaint = now;
        setRemaining(remainingNow());
      }
      raf = requestAnimationFrame(loop);
    };
    setRemaining(remainingNow());
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phaseEndsAt, remainingNow]);

  return remaining;
}

/**
 * Ease a number up from zero to `target`, restarting whenever `restartKey`
 * changes. Used for the reveal bars and the counting percentages.
 */
export function useRampUp(target, { duration = 900, restartKey = 0 } = {}) {
  const [value, setValue] = useState(0);
  const targetRef = useRef(target);
  const settled = useRef(false);

  // The target is read through a ref and is NOT an effect dependency. It used
  // to be one, and every /state poll re-ran the effect, reset `start`, and
  // sent the bar back to zero — so the projector showed 5% for a 67% result.
  // The animation must restart only when restartKey says so.
  useEffect(() => {
    targetRef.current = target;
    if (settled.current) setValue(target);
  }, [target]);

  useEffect(() => {
    settled.current = false;

    // requestAnimationFrame does not fire at all in a hidden tab — not
    // throttled, stopped. If the projector window is occluded, on another
    // desktop, or behind a screensaver when the reveal lands, the bars would
    // stay at their initial 0% and the room would be shown "0% / 0%".
    // Correctness outranks the animation: snap straight to the real number.
    const snapIfHidden = () => {
      if (document.visibilityState !== "hidden") return false;
      settled.current = true;
      setValue(targetRef.current);
      return true;
    };

    document.addEventListener("visibilitychange", snapIfHidden);
    if (snapIfHidden()) {
      return () => document.removeEventListener("visibilitychange", snapIfHidden);
    }

    let raf;
    let start = null;

    const step = (now) => {
      if (start === null) start = now;
      const t = Math.min(1, (now - start) / duration);
      if (t >= 1) {
        // Land exactly on the value, never a rounding artefact away from it.
        settled.current = true;
        setValue(targetRef.current);
        return;
      }
      // easeOutCubic — fast off the line, settles gently
      setValue(targetRef.current * (1 - Math.pow(1 - t, 3)));
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => {
      document.removeEventListener("visibilitychange", snapIfHidden);
      cancelAnimationFrame(raf);
    };
  }, [duration, restartKey]);

  return value;
}

/** Chase a moving target, so the join counter ticks up instead of jumping. */
export function useTicker(target) {
  const [value, setValue] = useState(target);
  const valueRef = useRef(target);

  useEffect(() => {
    let raf;
    const step = () => {
      const diff = target - valueRef.current;
      if (Math.abs(diff) < 0.5) {
        valueRef.current = target;
        setValue(target);
        return;
      }
      valueRef.current += Math.sign(diff) * Math.max(1, Math.abs(diff) * 0.12);
      setValue(valueRef.current);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return Math.round(value);
}
