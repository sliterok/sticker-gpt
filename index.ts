import * as cv from "opencv4nodejs";
import * as path from "path";

async function cropIsolatedObjects(
  inputPath: string,
  outputDir: string,
  expectedCount = 9
) {
  const img = cv.imread(inputPath, cv.IMREAD_UNCHANGED);
  if (img.channels !== 4) throw new Error("Need an RGBA PNG");

  // build & clean alpha mask → find contours
  const alpha = img.splitChannels()[3];
  const bin = alpha.threshold(1, 255, cv.THRESH_BINARY);
  const clean = bin.morphologyEx(
    cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)),
    cv.MORPH_OPEN
  );
  const contours = clean.findContours(cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  // grid‐sort & pick
  const items = contours
    .map((c) => ({ c, r: c.boundingRect() }))
    .sort((a, b) => {
      const rowA = Math.floor((a.r.y / img.rows) * 3);
      const rowB = Math.floor((b.r.y / img.rows) * 3);
      return rowA !== rowB ? rowA - rowB : a.r.x - b.r.x;
    })
    .slice(0, expectedCount);

  items.forEach(({ c, r }, i) => {
    // per‐object region
    const region = new cv.Rect(r.x, r.y, r.width, r.height);
    const crop = img.getRegion(region);

    // 1) new single‐channel mask via constructor overload
    const mask = new cv.Mat(r.height, r.width, cv.CV_8UC1, 0); // fill = 0 :contentReference[oaicite:0]{index=0}
    // draw only this contour (offset into local coords)
    const pts = c.getPoints().map((p) => new cv.Point2(p.x - r.x, p.y - r.y));
    mask.drawFillPoly([pts], new cv.Vec3(255, 255, 255));

    // 2) split & AND channels
    const [B, G, R, _A] = crop.splitChannels();
    const b2 = B.bitwiseAnd(mask);
    const g2 = G.bitwiseAnd(mask);
    const r2 = R.bitwiseAnd(mask);

    // 3) re‐merge all four mats via the Mat‐array constructor :contentReference[oaicite:1]{index=1}
    const result = new cv.Mat([b2, g2, r2, mask]);

    cv.imwrite(path.join(outputDir, `obj_${i + 1}.webp`), result);
  });
}

cropIsolatedObjects("./test2.png", "./out3").catch(console.error);
