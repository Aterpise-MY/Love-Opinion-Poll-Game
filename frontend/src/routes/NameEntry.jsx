import { useRef, useState } from "react";

import { NAME_MAX, checkName } from "../lib/name.js";

// Every word the phone says about a name, here and in the lobby, in one place
// so that it can be read through and reworded in one sitting. The limit is
// written from NAME_MAX, so a message can never quote a different number from
// the one the rule enforces.
export const NAME_TEXT = {
  // The field itself, the same whichever way the form was reached.
  label: "名字",
  placeholder: `名字或昵称，最多 ${NAME_MAX} 个字`,

  // Asked on the way in. The name goes up on the projector with each vote.
  join: {
    title: "怎么称呼你？",
    hint: "投票时大屏幕会显示你的名字，之后还能改",
    submit: "加入",
  },

  // Changing it, which any time offers except under an unanswered question.
  rename: {
    open: "改名字",
    title: "想改成什么？",
    hint: "随时都能改，下一次投票就用新名字",
    submit: "改好了",
    cancel: "不改了",
  },

  // One per code checkName can return.
  errors: {
    EMPTY: "先写个名字",
    TOO_LONG: `名字太长了，最多 ${NAME_MAX} 个字`,
    LINE_BREAK: "名字里不能换行",
  },

  // The lobby's first line, on either side of the name.
  greeting: { before: "", after: "，准备好了" },
};

/**
 * The name form: asked once before the lobby, and offered again whenever the
 * phone is not in the middle of a question, for anyone who wants to change
 * what they typed.
 *
 * The field is left entirely to the browser while it is being typed in. A
 * Chinese keyboard composes a character over several keystrokes, with the
 * letters typed so far sitting in the field in the meantime — so anything that
 * reads the field early, counts it, or writes a corrected value back into it
 * lands in the middle of a character. Three things follow:
 *
 *   - it is uncontrolled: React is never the one that sets its value;
 *   - it has no maxLength, which counts UTF-16 units, refuses the pinyin for
 *     the last character, and can cut an emoji in half;
 *   - the name is checked once, on submit, from what the field holds then.
 *
 * @param {object} props
 * @param {string|null} props.current  the name being changed, or null when
 *   this is the first time of asking.
 * @param {(name: string) => void} props.onSubmit  given the trimmed name.
 * @param {() => void} [props.onCancel]  leave the name as it was.
 */
export default function NameEntry({ current = null, onSubmit, onCancel }) {
  const field = useRef(null);
  const [error, setError] = useState(null);

  const renaming = current !== null;
  const text = renaming ? NAME_TEXT.rename : NAME_TEXT.join;
  function submit(event) {
    event.preventDefault();
    const checked = checkName(field.current.value);
    if (!checked.ok) {
      setError(checked.code);
      return;
    }
    onSubmit(checked.name);
  }

  return (
    // The lobby's own layout, one step earlier in the same conversation: the
    // white bubble asks, and the field is where the answer goes.
    <form className="phone__center phone__chat phone__name" noValidate onSubmit={submit}>
      <p className="bubble phone__chat-in">
        <strong>{text.title}</strong>
        {text.hint}
      </p>

      <input
        ref={field}
        className="phone__name-input"
        type="text"
        name="name"
        defaultValue={current ?? ""}
        placeholder={NAME_TEXT.placeholder}
        aria-label={NAME_TEXT.label}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? "phone-name-error" : undefined}
        // A name is the one word a keyboard should never think it knows
        // better than the person typing it.
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        // The complaint was about what the field held then. It no longer does.
        onChange={() => setError(null)}
      />

      {error && (
        <p id="phone-name-error" className="phone__notice" role="alert">
          {NAME_TEXT.errors[error]}
        </p>
      )}

      <button type="submit" className="tile tile--press phone__name-submit">
        {text.submit}
      </button>

      {renaming && (
        <button type="button" className="phone__rename" onClick={onCancel}>
          {text.cancel}
        </button>
      )}
    </form>
  );
}
