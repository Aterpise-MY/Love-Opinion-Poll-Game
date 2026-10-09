// Everything personal lives here and nowhere else. The server never learns who
// voted for what beyond an opaque id; what this phone chose is remembered only
// on this phone, which is where the reveal and the final recap read it from.

// Prefixed for this app rather than the bare `poll:` the game it was cloned
// from uses. Cookies are scoped by host and not by port, and `read` below falls
// back to the cookie — so two apps on one laptop sharing a prefix would adopt
// each other's voter id and each other's remembered choices.
const VOTER_KEY = "lovepoll:voterId";
const EPOCH_KEY = "lovepoll:epoch";
const CHOICES_KEY = "lovepoll:choices";
const JOINED_KEY = "lovepoll:joined";
// What the person typed on the way in. It belongs to the person and not to a
// run of the game, so it is kept the way the voter id is: a RESET leaves it
// alone and only the device wipe drops it.
//
// No request carries it in a body or a URL. As a cookie it does travel with
// every request to this host, like the keys above — the server reads none of
// them.
const NAME_KEY = "lovepoll:name";

function randomId() {
  // crypto.randomUUID needs a secure context. Rehearsing over the venue wifi
  // means http://192.168.x.x, which is not one — so keep a fallback.
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  (globalThis.crypto ?? { getRandomValues: fillWithMath }).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fillWithMath(bytes) {
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

// WeChat's in-app WebView is where most of this audience will open the page,
// and it evicts localStorage under storage pressure and some cleanup policies.
// Losing the voterId means becoming a new person: dedup breaks, the final
// recap forgets what you chose, and an already-voted phone renders tappable
// cards again. So every value is mirrored into a cookie and read from whichever
// survives.
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

function readCookie(key) {
  const prefix = `${encodeURIComponent(key)}=`;
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
  }
  return null;
}

function writeCookie(key, raw) {
  const secure = location.protocol === "https:" ? "; secure" : "";
  document.cookie =
    `${encodeURIComponent(key)}=${encodeURIComponent(raw)}` +
    `; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax${secure}`;
}

function clearCookie(key) {
  document.cookie = `${encodeURIComponent(key)}=; path=/; max-age=0`;
}

/** Read from localStorage, fall back to the cookie, then re-mirror both. */
function read(key, fallback) {
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch {
    raw = null;
  }
  if (raw === null) raw = readCookie(key);
  if (raw === null) return fallback;

  try {
    const value = JSON.parse(raw);
    write(key, value); // heal whichever side was missing
    return value;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  const raw = JSON.stringify(value);
  try {
    localStorage.setItem(key, raw);
  } catch {
    // Private mode, storage full — the cookie below still carries it.
  }
  try {
    writeCookie(key, raw);
  } catch {
    // Nothing more to try; dedup degrades but the app keeps working.
  }
}

export function getVoterId() {
  const existing = read(VOTER_KEY, null);
  if (typeof existing === "string" && existing) return existing;

  const id = randomId();
  write(VOTER_KEY, id);
  return id;
}

export const getChoices = () => read(CHOICES_KEY, {});

export function setChoice(qIndex, choice) {
  const choices = { ...getChoices(), [qIndex]: choice };
  write(CHOICES_KEY, choices);
  return choices;
}

export const hasJoined = () => read(JOINED_KEY, false);
export const markJoined = () => write(JOINED_KEY, true);

/**
 * The remembered name, or null. Whatever text is stored comes back as it is:
 * whether it is still a usable name is name.js's question, asked by the page.
 */
export function getName() {
  const name = read(NAME_KEY, null);
  return typeof name === "string" ? name : null;
}

export const saveName = (name) => write(NAME_KEY, name);

/**
 * Forget everything about the current run, keeping the device identity.
 *
 * Wiping the server is only half of a RESET: without this a phone keeps the
 * questions it answered last round, renders "already voted" from question two
 * onwards, and never shows the buttons again — the person is locked out for
 * the rest of the show.
 *
 * @returns true when this was a new round and local answers were dropped.
 */
export function syncEpoch(epoch) {
  if (!epoch) return false; // the game has never been reset
  if (read(EPOCH_KEY, null) === epoch) return false;

  for (const key of [CHOICES_KEY, JOINED_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // nothing to do
    }
    try {
      clearCookie(key);
    } catch {
      // nothing to do
    }
  }
  write(EPOCH_KEY, epoch);
  return true;
}

/** Wipe this device's identity. Used by /?reset=1 to clear rehearsal phones. */
export function clearAll() {
  for (const key of [VOTER_KEY, NAME_KEY, CHOICES_KEY, JOINED_KEY, EPOCH_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // nothing to do
    }
    try {
      clearCookie(key);
    } catch {
      // nothing to do
    }
  }
}
