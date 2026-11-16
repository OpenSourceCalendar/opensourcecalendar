/**
 * Cuts see-through margins off a logo so it fills its spot on the booking page
 * (a logo saved with wide empty sides otherwise shows tiny). Returns the file unchanged
 * when it has no transparent edges (JPEG, or already tight) or anything goes wrong.
 */
export async function trimTransparent(file: File): Promise<Blob> {
  if (file.type === "image/jpeg") return file;
  try {
    const bmp = await createImageBitmap(file);
    const { width: w, height: h } = bmp;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;
    let top = h, left = w, right = -1, bottom = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] > 8) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          bottom = y;
        }
      }
    }
    if (right < 0) return file; // fully transparent: leave it to the owner
    const cw = right - left + 1;
    const ch = bottom - top + 1;
    if (cw === w && ch === h) return file;
    const out = document.createElement("canvas");
    out.width = cw;
    out.height = ch;
    out.getContext("2d")!.drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
    return blob ?? file;
  } catch {
    return file;
  }
}
