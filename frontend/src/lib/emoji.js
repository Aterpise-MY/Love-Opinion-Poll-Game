// The icons offered on the setup page, so writing an option does not mean
// stopping to find the OS emoji keyboard. The field stays a text input — anyone
// who wants an emoji that is not here can still type or paste it, and the server
// truncates whatever arrives to two graphemes.
//
// The app itself ships no emoji: the design language has none, and everything
// it puts on screen by default is a text glyph or a pixel icon. This palette is
// the one place they are on offer, because which icon an option carries is the
// host's decision — and the first row leads with the two text glyphs the
// default pair uses, so going back to them is one click.
//
// Kept short on purpose. This is a palette to pick from between two questions,
// not an emoji browser: every row past the fold is a row nobody scrolls to.

export const EMOJI_GROUPS = [
  { name: "判断", emoji: ["♥", "✕", "✅", "❌", "👍", "👎", "❓", "❗"] },
  { name: "情绪", emoji: ["😀", "😂", "🥰", "😱", "🤔", "😴", "😭", "😎"] },
  { name: "强调", emoji: ["🔥", "💯", "⭐", "🎉", "❤️", "⚡", "💡", "🏆"] },
  { name: "序号", emoji: ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "🅰️", "🅱️"] },
  { name: "杂项", emoji: ["🐱", "🐶", "🍜", "☕", "🎵", "🎬", "📷", "🌏"] },
];

// What a newly added option starts with. The first two options are the pair the
// game ships with (♥ 可以 / ✕ 不可以), so an option added after them is the
// third thing on screen and reads best as a number — and a numbered option is
// never wrong in the way a guessed picture is. Plain digits rather than keycap
// emoji, for the same reason the default pair is not emoji: they are drawn in
// the app's own pixel face, the same on every handset.
const SEEDS = ["♥", "✕", "3", "4", "5", "6"];

export const seedIcon = (position) => SEEDS[position] ?? "";
