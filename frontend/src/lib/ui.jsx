// The small pieces of the design language that more than one page draws: the
// pixel icons, the typing dots, the room's split written out, and the poster
// decorations. Everything here is presentation only — no state, no fetching —
// and the look of each piece lives in styles.css under the class it wears.

// One path each, on a 24-unit grid in 2-unit pixels, filled with currentColor
// so an icon takes the colour of the text it sits in. The first four are the
// ones the design language itself uses, from pixelarticons. `sound` and `play`
// are not in that set: they were drawn for this app on the same grid, because
// the projector needs to say "audio" and "press play" without an emoji.
const ICONS = {
  heart:
    "M9 2H5v2H3v2H1v6h2v2h2v2h2v2h2v2h2v2h2v-2h2v-2h2v-2h2v-2h2v-2h2V6h-2V4h-2V2h-4v2h-2v2h-2V4H9V2zm0 2v2h2v2h2V6h2V4h4v2h2v6h-2v2h-2v2h-2v2h-2v2h-2v-2H9v-2H7v-2H5v-2H3V6h2V4h4z",
  check:
    "M18 6h2v2h-2V6zm-2 4V8h2v2h-2zm-2 2v-2h2v2h-2zm-2 2h2v-2h-2v2zm-2 2h2v-2h-2v2zm-2 0v2h2v-2H8zm-2-2h2v2H6v-2zm0 0H4v-2h2v2z",
  lightbulb:
    "M8 2h8v2H8V2ZM6 6V4h2v2H6Zm0 6H4V6h2v6Zm2 2H6v-2h2v2Zm8 0v4H8v-4h2v2h4v-2h2Zm2-2v2h-2v-2h2Zm0-6h2v6h-2V6Zm0 0V4h-2v2h2Zm-2 14H8v2h8v-2Z",
  message: "M20 2H2v20h2V4h16v12H6v2H4v2h2v-2h16V2h-2z",
  sound:
    "M3 9h4v6H3zM7 7h2v10H7zM9 5h2v14H9zM11 3h2v18h-2zM15 10h2v4h-2zM17 6h2v2h-2zM17 16h2v2h-2zM19 8h2v8h-2z",
  play: "M7 4h2v16H7zM9 6h2v12H9zM11 8h2v8h-2zM13 10h2v4h-2zM15 11h2v2h-2z",
};

/**
 * A pixel icon, sized by the font-size of whatever it is inside.
 *
 * Inline SVG rather than a mask over a background, which is how the design
 * language's own Icon component does it: a mask needs the SVG as a separate
 * request, and the phones in the room have enough of those already.
 */
export function PixelIcon({ name, className = "" }) {
  return (
    <svg
      className={`px-icon ${className}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICONS[name]} fill="currentColor" />
    </svg>
  );
}

/**
 * Three typing dots, as squares.
 *
 * Elements rather than the three bullet characters the design language types,
 * so each one can blink on its own beat and none of them depends on a font
 * having the glyph.
 */
export function TypingDots() {
  return (
    <span className="dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * The design language's switch: a pill with a knob that slides.
 *
 * A real button with role="switch", so it is reachable by keyboard and says
 * what it is and which way it is set. It never keeps the answer itself:
 * `checked` is whatever the caller says is true, and pressing it only asks —
 * onChange gets the state it would like to be in. The one switch in the app
 * shows a setting that lives on the server, and a switch that flipped on the
 * click and was put back by the next poll would have lied for a second.
 */
export function Switch({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

/**
 * How the room split, written out for the options a question still offers:
 * a swatch, the label and its percentage for each, in the cards' own order.
 *
 * Every number comes from sharesOf, like every other percentage in the app.
 * Each option is one unbreakable piece, so where a long line wraps it wraps
 * between options and never between a label and its number.
 */
export function Shares({ options, shares }) {
  return (
    <span className="shares">
      {options.flatMap((option, i) => [
        // A real space between two options: each one is unbreakable, so this
        // is the only place the line is allowed to wrap.
        i > 0 ? " " : null,
        <span key={option.key} className={`shares__item key--${option.key}`}>
          <i className="shares__swatch" />
          {option.label} <b className="num">{shares?.[option.key] ?? 0}%</b>
        </span>,
      ])}
    </span>
  );
}

/**
 * The poster's loose furniture: a few + sparkles, a pixel heart, a pair of
 * chat bubbles. Purely decoration, hidden from assistive technology, and only
 * ever placed on the two screens nobody is reading under a countdown — the
 * lobby and the rules. Where each piece sits is in styles.css, per screen, so
 * that nothing can land on the QR code.
 */
export function Deco({ of }) {
  return (
    <div className={`deco deco--${of}`} aria-hidden="true">
      <span className="spark deco__spark-1">+</span>
      <span className="spark deco__spark-2">+</span>
      <span className="spark spark--pink deco__spark-3">+</span>
      <span className="spark spark--pink deco__spark-4">+</span>
      <PixelIcon name="heart" className="deco__heart" />
      <span className="bubble deco__typing">
        <TypingDots />
      </span>
      <span className="bubble bubble--pink bubble--right deco__love">
        <PixelIcon name="heart" />
      </span>
    </div>
  );
}

/**
 * One calm screen for a phone that has nothing to do: a white bubble with a
 * line to read and a line under it, and a pink one answering with a heart.
 * The phone's lobby types instead — something is about to happen there.
 */
export function ChatNote({ title, children, typing = false }) {
  return (
    <section className="phone__center phone__chat">
      <p className="bubble phone__chat-in">
        <strong>{title}</strong>
        {children}
      </p>
      <span className="bubble bubble--pink bubble--right phone__chat-out">
        {typing ? <TypingDots /> : <PixelIcon name="heart" />}
      </span>
    </section>
  );
}
