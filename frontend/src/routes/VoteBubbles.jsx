import { useEffect, useRef, useState } from "react";

import { optionsOf } from "../lib/choices.js";
import { STAGGER_MS, advance, describe, show, unexpired } from "../lib/voteBubbles.js";

/**
 * A strip of chat bubbles on the projector, one for each vote as it comes in:
 * "小明 选了「可以」", in the colour of the option chosen.
 *
 * Both /screen and /screen2 draw it. It is a flex item of its own, in the
 * column between the ballot and the countdown on /screen, so it takes its
 * height from the stage instead of lying over the question or the live tally.
 * It is there for the whole of VOTING, empty or not, so the layout does not
 * jump when the first vote lands.
 *
 * What is new is decided in lib/voteBubbles.js. This only runs the clock:
 * a poll can bring several votes at once, so they wait in a queue and go up
 * one per STAGGER_MS, and each comes down after SHOW_MS. A single timer does
 * both, so there is nothing to clean up per bubble.
 *
 * The name is somebody else's text, so it is only ever a React text node.
 */
export default function VoteBubbles({ state, questions }) {
  const lastId = useRef(null);
  const queue = useRef([]);
  const [visible, setVisible] = useState([]);

  const voting = state?.phase === "VOTING";

  useEffect(() => {
    if (!state) return;
    const next = advance(lastId.current, state);
    lastId.current = next.lastId;
    if (!voting) {
      // Whatever was still waiting is about a question that has closed.
      queue.current = [];
      setVisible((now) => (now.length > 0 ? [] : now));
      return;
    }
    queue.current.push(...next.fresh);
  }, [state, voting]);

  // Read when a bubble goes up, not when its vote arrives: the questions may
  // still be on their way, and an option list that has not loaded yet would
  // fall back to the default pair and name the wrong answer.
  const questionsRef = useRef(questions);
  questionsRef.current = questions;

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      // Taken here and not inside the updater below, which React may run twice.
      const entry = queue.current.shift();
      const waiting = entry && describe(entry, optionsOf(questionsRef.current[entry.qIndex]));
      setVisible((current) => {
        const wall = unexpired(current, now);
        if (waiting) return show(wall, { ...waiting, shownAt: now });
        return wall.length === current.length ? current : wall;
      });
    }, STAGGER_MS);
    return () => clearInterval(timer);
  }, []);

  if (!voting) return null;

  return (
    <div className="vote-bubbles" aria-live="off">
      {visible.map((bubble) => (
        <p key={bubble.id} className={`bubble vote-bubble key--${bubble.key}`}>
          <span className="vote-bubble__who">{bubble.who}</span>
          <span className="vote-bubble__what"> 选了「{bubble.label}」</span>
        </p>
      ))}
    </div>
  );
}
