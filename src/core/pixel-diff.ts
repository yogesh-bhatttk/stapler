export function pixelDiff(img1: ImageData, img2: ImageData, sensitivity: number): ImageData {
  if (img1.width !== img2.width || img1.height !== img2.height) {
    throw new Error('Cannot compare images with different dimensions.');
  }
  const width = img1.width;
  const height = img1.height;
  const out = new ImageData(width, height);
  const data1 = img1.data;
  const data2 = img2.data;
  const outData = out.data;

  // sensitivity is 0 to 100. Higher means more sensitive (lower threshold).
  // max diff for RGB is 255*3 = 765.
  // if sensitivity = 0, threshold = 765 (everything matches)
  // if sensitivity = 100, threshold = 0 (exact match)
  const threshold = ((100 - sensitivity) / 100) * 765;

  for (let i = 0; i < data1.length; i += 4) {
    const r1 = data1[i];
    const g1 = data1[i + 1];
    const b1 = data1[i + 2];
    const a1 = data1[i + 3];

    const r2 = data2[i];
    const g2 = data2[i + 1];
    const b2 = data2[i + 2];
    const a2 = data2[i + 3];

    // Simple absolute difference
    const diff = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) + Math.abs(a1 - a2);

    if (diff > threshold) {
      // Differing pixel: Color it red
      outData[i] = 255;
      outData[i + 1] = 0;
      outData[i + 2] = 0;
      outData[i + 3] = 255;
    } else {
      // Matching pixel: Make it transparent or faded (we can just show the original image)
      // We'll leave it transparent so we can overlay it on top of image 2
      outData[i] = 0;
      outData[i + 1] = 0;
      outData[i + 2] = 0;
      outData[i + 3] = 0;
    }
  }

  return out;
}
