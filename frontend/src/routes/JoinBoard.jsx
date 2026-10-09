import { useEffect, useState } from "react";
import QRCode from "qrcode";

import { useCountdown, useTicker } from "../lib/hooks.js";
import { Deco } from "../lib/ui.jsx";

/**
 * The "scan to join" panel, shared by both projectors.
 *
 * /screen shows it during LOBBY and then gives the whole surface over to the
 * question. /screen2 shows it and nothing else, for the whole event. They are
 * the same component on purpose: two projectors showing the same room the same
 * QR at two different sizes, drifting apart because someone edited one of them,
 * is the kind of fault nobody notices until it is on a wall.
 */
export function joinUrl() {
  // ?url= lets the QR point at the short domain even while the screen runs off
  // some other address.
  const override = new URLSearchParams(window.location.search).get("url");
  return override || `${window.location.origin}/`;
}

export function Qr({ size = 480, className = "" }) {
  const [src, setSrc] = useState(null);
  const url = joinUrl();

  useEffect(() => {
    QRCode.toDataURL(url, { width: size, margin: 1, errorCorrectionLevel: "M" })
      .then(setSrc)
      .catch(() => setSrc(null));
  }, [url, size]);

  return (
    <div className={`qr ${className}`}>
      {src && <img src={src} alt="扫码加入投票" width={size} height={size} />}
      <span className="qr__url">{url.replace(/^https?:\/\//, "")}</span>
    </div>
  );
}

// m:ss, the face the room reads. Deliberately not the operator console's
// `clock` helper: that one lives in Operator.jsx and says 超时 at zero, which is
// a word for the person running the show, not for three hundred people deciding
// whether they still have time to scan. This one just holds at 0:00.
const face = (ms) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

// Matches the countdown on /screen's question, so the same colour means the
// same thing in both places: you are nearly out of time.
const URGENT_MS = 30_000;

/**
 * @param {object} props
 * @param {number|null} props.joined  null while /state has not answered yet —
 *   the count is then left out rather than shown as a confident 0.
 * @param {number|null} [props.endsAt]  the join clock's server-side deadline, or
 *   null for "no clock". Passed in rather than read from state here, which is
 *   the whole mechanism keeping this off /screen2: that route renders the same
 *   component and simply does not pass it. See #47.
 * @param {number} [props.offset]  server-clock offset from useGameState.
 * @param {boolean} [props.noPhones]  offline mode: the room is not using its
 *   phones, so there is nothing to scan and nobody to count. What is left is
 *   the poster — the ribbon and the title, centred — and nothing else.
 */
export function JoinBoard({ joined, endsAt = null, offset = 0, noPhones = false }) {
  // Hooks cannot be skipped, so both of these always run; only the display of
  // them waits for a real number. useCountdown(null) returns null and idles.
  const count = useTicker(joined ?? 0);
  const remaining = useCountdown(endsAt, offset);

  if (noPhones) {
    return (
      <section className="lobby lobby--poster">
        <Deco of="poster" />
        <div className="lobby__main">
          <div>
            <span className="ribbon lobby__ribbon">感情讲座</span>
            <h1 className="lobby__title">
              这样<span className="hl">恋爱</span>
              <br />
              <em>可不可以</em>
            </h1>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="lobby">
      {/* Behind everything, and kept to the left column and the edges by its
          own rules in styles.css — never over the QR, which a camera has to
          read from the back of the room. */}
      <Deco of="lobby" />
      <div className="lobby__main">
        <div>
          {/* The series ribbon, the way the poster wears it above its title. */}
          <span className="ribbon lobby__ribbon">感情讲座</span>
          {/* Broken 4+4 on purpose. Eight glyphs at this title's size do not fit
              on one line beside the QR, and left to the browser the break lands
              wherever the column happens to run out.
              One word, one colour: the key word on line one is pink, line two
              is yellow, and everything else is white. */}
          <h1 className="lobby__title">
            这样<span className="hl">恋爱</span>
            <br />
            <em>可不可以</em>
          </h1>
          <p className="lobby__sub">扫码加入，用手机投票</p>
          {/* "0 人已加入" before the first poll lands reads as "nobody came".
            An empty slot for one second reads as nothing at all. */}
          {joined != null && (
            <p className="lobby__joined">
              <span className="lobby__count num">{count}</span> 人已加入
            </p>
          )}
        </div>

        {/* Stacked under the title block and centred across the column, rather
            than left-aligned as a fourth header line — the deadline is the
            room's, not the title's. It sits in this column so it rises into
            the empty middle of the screen; as a row under the QR it was always
            stranded at the bottom edge, because the QR is tall.

            Absent, not zeroed, when the operator has not started it: a stopped
            clock and a clock reading 0:00 mean opposite things to a room, and
            only one of them should ever be on a wall. With it absent this
            column collapses to the title block, so the stopped lobby is the
            layout it has always been. Reaching 0:00 closes nothing — the doors
            shut when the operator presses 开始本题. */}
        {remaining != null && (
          <p className={`lobby__clock ${remaining <= URGENT_MS ? "is-urgent" : ""}`}>
            <span className="lobby__clock-face num">{face(remaining)}</span>
            <span className="lobby__clock-label">后开始</span>
          </p>
        )}
      </div>
      <Qr className="lobby__qr" size={720} />
    </section>
  );
}
