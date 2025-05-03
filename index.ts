import * as cv from "opencv4nodejs";
import * as path from "path";

async function cropFeatheredStickers(
  inputPath: string,
  outputDir: string,
  gridRows = 3,
  gridCols = 3,
  featherPx = 10
) {
  const img = cv.imread(inputPath, cv.IMREAD_UNCHANGED);
  if (img.channels !== 4) throw new Error("Need an RGBA PNG");

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

  // process each cell
  cells.forEach((cluster, idx) => {
    if (!cluster.length) return;
    // union‐rect
    const rects = cluster.map((c) => c.boundingRect());
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.width));
    const y1 = Math.max(...rects.map((r) => r.y + r.height));
    const w = x1 - x0,
      h = y1 - y0;
    const region = new cv.Rect(x0, y0, w, h);
    const crop = img.getRegion(region);

    // 1) build binary mask of this sticker
    const mask = new cv.Mat(h, w, cv.CV_8UC1, 0);
    cluster.forEach((c) => {
      const pts = c.getPoints().map((p) => new cv.Point2(p.x - x0, p.y - y0));
      mask.drawFillPoly([pts], new cv.Vec3(255, 255, 255));
    });

    // 2) feather the mask
    const k = featherPx * 2 + 1;
    const maskBlur = mask.gaussianBlur(new cv.Size(k, k), 0); // … after you’ve built maskBlur …

    // Normalize blurred α to [0…1]
    const maskF = maskBlur.convertTo(cv.CV_32FC1, 1 / 255);

    // Split RGBA crop
    const [B, G, R, A] = crop.splitChannels();

    // Convert color channels to float
    const Bf = B.convertTo(cv.CV_32FC1);
    const Gf = G.convertTo(cv.CV_32FC1);
    const Rf = R.convertTo(cv.CV_32FC1);

    // Element-wise multiply by maskF to fade edges
    const Bm = Bf.hMul(maskF);
    const Gm = Gf.hMul(maskF);
    const Rm = Rf.hMul(maskF);

    // Back to 8-bit
    const Bb = Bm.convertTo(cv.CV_8UC1);
    const Gb = Gm.convertTo(cv.CV_8UC1);
    const Rb = Rm.convertTo(cv.CV_8UC1);

    // Merge faded colors + blurred α
    const result = new cv.Mat([Bb, Gb, Rb, maskBlur]);

    cv.imwrite(path.join(outputDir, `sticker_${idx + 1}.webp`), result);
  });
}

cropFeatheredStickers("./test.png", "./out3").catch(console.error);
