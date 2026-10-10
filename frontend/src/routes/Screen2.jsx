import { JoinBoard } from "./JoinBoard.jsx";
import { useQuestions } from "../lib/content.js";
import { useGameState } from "../lib/hooks.js";
import VoteBubbles from "./VoteBubbles.jsx";

// Slower than /screen's 1s. This board has exactly one moving part — the join
// count — and nothing on it is time-critical, so there is no reason for a
// second projector to add a request per second per room to the same tasks that
// are serving three hundred phones.
const POLL_MS = 3000;

/**
 * The second projector: the join board, and only ever the join board.
 *
 * /screen hands its whole surface to the question once the operator presses
 * Start, which is correct — a question competing with a QR code for a wall is
 * a question nobody reads. But it also means that from the first Start onward
 * there is nowhere left for a latecomer to scan, and people arrive late to
 * every event ever held.
 *
 * So this route deliberately ignores `phase` entirely. It shows the same QR at
 * the same size from setup until the room empties, on a side screen or a
 * second monitor, while /screen runs the show. No phase, no countdown, no
 * results — if it ever changed, someone would be looking at it at the moment
 * it did. The one exception is the strip of vote bubbles along the bottom,
 * which appears while a question is open and is gone when it closes.
 *
 * Offline mode is the one thing it does follow, because then the QR is a
 * promise the room cannot use: the board becomes the same poster without a
 * code. The host can only switch that in a lobby, so it never changes under a
 * question.
 */
export default function Screen2() {
  const { state, offline } = useGameState(POLL_MS);
  const [questions] = useQuestions(state?.contentVersion);

  return (
    <main className="screen">
      {/* Same dot as /screen, same reasoning: the operator needs to know this
          board has gone stale, the audience does not. */}
      {offline && <div className="screen__offline" title="与服务器失去连接" />}
      {/* The one thing this board does react to: in offline mode there is no
          code to scan, so it is the same poster without one. Still nothing
          here follows the phase. */}
      <JoinBoard joined={state ? state.joined : null} noPhones={Boolean(state?.offline)} />
      <VoteBubbles state={state} questions={questions} />
    </main>
  );
}
