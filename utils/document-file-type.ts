const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif"];

export function isPdfFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pdf");
}

export function isImageFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}
