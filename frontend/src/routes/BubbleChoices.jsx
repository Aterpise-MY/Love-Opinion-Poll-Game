import { bubbleSize, spansRow, tailSide } from "../lib/bubbles.js";

// The answer buttons on the phone, drawn as chat bubbles in their option
// colours. One component for voting and for the voted state, so the bubble the
// player pressed stays put and gets marked rather than the whole block
// vanishing and the page jumping up under their thumb.
//
// `onVote` is Phone's own vote(); nothing here knows how a vote travels, what
// it says when it fails, or what the phone remembers afterwards.
export default function BubbleChoices({ options, myChoice, disabled, onVote }) {
  const size = bubbleSize(options.length);
  return (
    <div className={`quiz__choices quiz__choices--${size}`}>
      {options.map((option, index) => {
        const mine = myChoice === option.key;
        return (
          <button
            key={option.key}
            type="button"
            className={[
              "bubble",
              `bubble--${tailSide(index, options.length)}`,
              `key--${option.key}`,
              "choice",
              option.image ? "choice--pictured" : "",
              spansRow(index, options.length) ? "choice--wide" : "",
              mine ? "is-mine" : "",
              myChoice && !mine ? "is-passed" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onVote(option.key)}
            disabled={disabled}
            aria-pressed={mine}
          >
            {/* The picture comes to the phone even though the clips do not: it
                is already compressed to a couple of hundred KB, and a button
                that means "the third photograph" cannot be pressed by someone
                who cannot see the photograph. */}
            {option.image && <img className="choice__image" src={option.image} alt="" />}
            {option.icon && <span className="choice__icon glyph">{option.icon}</span>}
            <span className="choice__label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
