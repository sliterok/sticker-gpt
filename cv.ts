import * as cv from "opencv4nodejs";

export async function cropFeatheredStickers(
  url: string,
  gridRows = 3,
  gridCols = 3,
  featherPx = 10
) {
  const req = await fetch(url);
  const buffer = await req.arrayBuffer();
  let img = cv.imdecode(Buffer.from(buffer), cv.IMREAD_UNCHANGED);
  if (img.channels !== 4) throw new Error("Need an RGBA image");
  // --- fallback for white-background (3-channel) images ---
  // if (img.channels === 3) {
  //   const [B, G, R] = img.splitChannels();
  //   // white → 255; invert so non-white stays opaque
  //   const gray = img.cvtColor(cv.COLOR_BGR2GRAY);
  //   const alpha = gray.threshold(254, 255, cv.THRESH_BINARY_INV);
  //   img = new cv.Mat([B, G, R, alpha]);
  // } else if (img.channels !== 4) {
  //   throw new Error(`Unsupported image format (${img.channels} channels)`);
  // }
  // --------------------------------------------------------

  // build cleaned alpha mask & find contours
  const alpha = img.splitChannels()[3];
  const bin = alpha.threshold(1, 255, cv.THRESH_BINARY);
  const clean = bin.morphologyEx(
    cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)),
    cv.MORPH_OPEN
  );
  const contours = clean.findContours(cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  // grid-cluster contours
  const cellW = Math.floor(img.cols / gridCols);
  const cellH = Math.floor(img.rows / gridRows);
  const cells: cv.Contour[][] = Array(gridRows * gridCols)
    .fill(0)
    .map(() => []);

  contours.forEach((c) => {
    const { x, y, width, height } = c.boundingRect();
    const col = Math.min(Math.floor((x + width / 2) / cellW), gridCols - 1);
    const row = Math.min(Math.floor((y + height / 2) / cellH), gridRows - 1);
    cells[row * gridCols + col].push(c);
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
