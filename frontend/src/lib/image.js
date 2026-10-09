// Resize and compress in the browser before uploading.
//
// This is what keeps the "images under 200KB" checklist item from being a
// manual chore — a 4MB phone photo or a full-resolution screenshot arrives at
// the API already small enough that 300 phones can preload ten of them.

const MAX_DIMENSION = 1800; // enough for a projector, plenty for a phone
const TARGET_BYTES = 200_000;
const QUALITY_STEPS = [0.9, 0.82, 0.72, 0.6, 0.5];

export async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));

  let blob = null;
  for (const quality of QUALITY_STEPS) {
    blob = await draw(bitmap, scale, quality);
    if (blob.size <= TARGET_BYTES) break;
  }

  // Still too big at the lowest quality — shrink the pixels instead.
  if (blob.size > TARGET_BYTES) {
    blob = await draw(bitmap, scale * 0.7, 0.72);
  }

  bitmap.close?.();
  return { blob, contentType: "image/jpeg", width: Math.round(bitmap.width * scale) };
}

function draw(bitmap, scale, quality) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const ctx = canvas.getContext("2d");
  // JPEG has no alpha: without this, transparent PNGs come out black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

export function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
