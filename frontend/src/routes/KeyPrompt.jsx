import { useState } from "react";

/**
 * The key gate for /admin and /operator.
 *
 * It exists in this shared form because of the failure it was written for: a
 * wrong key used to render the whole page anyway. The links, the QR and the
 * six buttons all appeared, and the first sign that the key was wrong was an
 * upload failing with 401 — after the picture had been chosen, compressed and
 * sent. On the operator console there was no sign at all, because every read
 * it needs is served unauthenticated.
 *
 * So both pages now check the key before rendering anything, and both land
 * here when it is wrong. Being told immediately is the entire feature.
 */
export default function KeyPrompt({ label, error }) {
  const [value, setValue] = useState("");

  return (
    <main className="admin admin--prompt">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          // A full reload rather than in-page state: the key is read once at
          // mount on both pages, and this keeps that the only place it enters.
          window.location.search = `?k=${encodeURIComponent(value.trim())}`;
        }}
      >
        <label className="admin__stat-label" htmlFor="admin-key">
          {label}
        </label>
        <input
          id="admin-key"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoFocus
          // The operator types this on a phone, in the dark, under time
          // pressure. Never autocorrect it, never capitalise it.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <button type="submit">进入</button>
        {error && <p className="admin__prompt-error">{error}</p>}
      </form>
    </main>
  );
}
