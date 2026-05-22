import heic2any from "heic2any";

const MAX_HEIC_SIZE = 15 * 1024 * 1024; // 15MB

export async function loadImageForBrowser(url: string): Promise<string> {
  // Fast path: normal images
  if (!isHeic(url)) return url;

  const res = await fetch(url);
  const blob = await res.blob();

  if (blob.size > MAX_HEIC_SIZE) {
    throw new Error("HEIC too large for client-side conversion");
  }

  const converted = await heic2any({
    blob,
    toType: "image/jpeg",
    quality: 0.85,
  });

  return URL.createObjectURL(converted as Blob);
}

function isHeic(url: string) {
  return /\.(heic|heif)$/i.test(url);
}
