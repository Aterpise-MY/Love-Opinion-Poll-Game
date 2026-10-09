// Mirrors backend/media.js so the setup page can reject a file before spending
// a minute uploading it on venue wifi. The server validates independently —
// this is only there to fail fast and say something useful.

const AUDIO_TYPES = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
};

export const KINDS = {
  image: {
    types: {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    },
    maxBytes: 1_500_000,
  },
  audio: {
    types: AUDIO_TYPES,
    maxBytes: 6_000_000,
  },
  video: {
    types: {
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "video/webm": "webm",
    },
    maxBytes: 40_000_000,
  },
};
