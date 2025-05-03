import * as cv from "opencv4nodejs";

export async function cropFeatheredStickers(url: string, featherPx = 10) {
  const req = await fetch(url);
  const buffer = await req.arrayBuffer();
  let img = cv.imdecode(Buffer.from(buffer), cv.IMREAD_UNCHANGED);
  // --- fallback for white-background (3-channel) images ---
  if (img.channels === 3) {
    const [B, G, R] = img.splitChannels();

    // Use flood fill to detect background from top-left corner
    // Create a mask slightly larger than the image for floodFill, initialized to 0s
    const mask = new cv.Mat(img.rows + 2, img.cols + 2, cv.CV_8UC1, 0);
    // Define color tolerance for flood fill (adjust if needed for different backgrounds)
    const loDiff = new cv.Vec3(3, 3, 3); // Lower difference tolerance
    const upDiff = new cv.Vec3(3, 3, 3); // Upper difference tolerance
    // Flags: FLOODFILL_MASK_ONLY means the function won't change the input image,
    // only the mask. The (255 << 8) part sets the fill color for the mask to 255.
    const flags = cv.FLOODFILL_MASK_ONLY | (255 << 8);

    // Flood fill from the top-left corner (0,0)
    // The function fills the mask where pixels are connected to the seed point (0,0)
    // and within the color tolerance (loDiff, upDiff) compared to the seed point.
    img.floodFill(
      new cv.Point2(0, 0), // seedPoint
      new cv.Vec3(1, 1, 1), // newVal
      mask, // mask
      loDiff, // loDiff
      upDiff, // upDiff
      flags // flags
    );

    // Crop the mask back to original image size (remove the 1px border added for floodFill)
    const croppedMask = mask.getRegion(new cv.Rect(1, 1, img.cols, img.rows));

    // Invert the mask: background (marked as 255) becomes 0 (transparent),
    // foreground (originally 0) becomes 255 (opaque).
    const alpha = croppedMask.threshold(254, 255, cv.THRESH_BINARY_INV);

    // Combine original color channels with the new alpha mask
    img = new cv.Mat([B, G, R, alpha]);
  } else if (img.channels !== 4) {
    // Handle images that are not 3-channel (BGR) or 4-channel (BGRA)
    throw new Error(`Unsupported image format (${img.channels} channels)`);
  }
  // --------------------------------------------------------

  // build cleaned alpha mask & find contours
  const alpha = img.splitChannels()[3];
  const bin = alpha.threshold(1, 255, cv.THRESH_BINARY);
  const clean = bin.morphologyEx(
    cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)),
    cv.MORPH_OPEN
  );
  const contours = clean.findContours(cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const size = contours.length > 6 ? 3 : 2;

  // grid-cluster contours
  const cellW = Math.floor(img.cols / size);
  const cellH = Math.floor(img.rows / size);
  const cells: cv.Contour[][] = Array(size ** 2)
    .fill(0)
    .map(() => []);

  contours.forEach((c) => {
    const { x, y, width, height } = c.boundingRect();
    const col = Math.min(Math.floor((x + width / 2) / cellW), size - 1);
    const row = Math.min(Math.floor((y + height / 2) / cellH), size - 1);
    cells[row * size + col].push(c);
  });

  const results: Buffer[] = [];
  cells.forEach((cluster, idx) => {
    if (!cluster.length) return;
    // union-rect
    const rects = cluster.map((c) => c.boundingRect());
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.width));
    const y1 = Math.max(...rects.map((r) => r.y + r.height));
    const w = x1 - x0,
      h = y1 - y0;
    const region = new cv.Rect(x0, y0, w, h);
    const crop = img.getRegion(region);

    // 1) build binary mask from the crop's own alpha channel (preserves holes!)
    const channels = crop.splitChannels();
    const alphaCrop = channels[3];
    const maskBin = alphaCrop.threshold(1, 255, cv.THRESH_BINARY);

    // optional: clean up tiny speckles
    const cleanMask = maskBin.morphologyEx(
      cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)),
      cv.MORPH_OPEN
    );

    // 2) feather it
    const k = featherPx * 2 + 1;
    const maskBlur = cleanMask.gaussianBlur(new cv.Size(k, k), 0);

    // normalized float mask for color multiplication
    const maskF = maskBlur.convertTo(cv.CV_32FC1, 1 / 255);

    // 3) apply to each color channel
    const [B2, G2, R2] = channels;
    const Bf = B2.convertTo(cv.CV_32FC1).hMul(maskF).convertTo(cv.CV_8UC1);
    const Gf = G2.convertTo(cv.CV_32FC1).hMul(maskF).convertTo(cv.CV_8UC1);
    const Rf = R2.convertTo(cv.CV_32FC1).hMul(maskF).convertTo(cv.CV_8UC1);

    // 4) merge your faded colors + the blurred alpha
    const result = new cv.Mat([Bf, Gf, Rf, maskBlur]);
    results.push(cv.imencode(".webp", result));
  });

  return results;
}
