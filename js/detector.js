/* Document detection & processing on top of OpenCV.js.
   OpenCV (11 MB) is injected lazily; everything queues on Detector.ready(). */
"use strict";

const Detector = (() => {
  let readyPromise = null;

  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/opencv.js";
      script.async = true;
      script.onerror = () => reject(new Error("Failed to load OpenCV"));
      document.head.appendChild(script);

      const started = Date.now();
      (function poll() {
        const cv = window.cv;
        if (cv && typeof cv.then === "function") {
          // newer builds expose a thenable Module
          cv.then((mod) => { window.cv = mod; resolve(); });
        } else if (cv && cv.Mat) {
          resolve();
        } else if (Date.now() - started > 90000) {
          reject(new Error("OpenCV load timed out"));
        } else {
          setTimeout(poll, 100);
        }
      })();
    });
    return readyPromise;
  }

  // ---- geometry helpers ----

  function orderCorners(pts) {
    // returns [tl, tr, br, bl]
    const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
    return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function defaultCorners(w, h) {
    const mx = w * 0.04, my = h * 0.04;
    return [
      { x: mx, y: my }, { x: w - mx, y: my },
      { x: w - mx, y: h - my }, { x: mx, y: h - my },
    ];
  }

  // ---- detection ----

  function pointInQuad(pt, quad) {
    // ray casting
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = quad[i], b = quad[j];
      if ((a.y > pt.y) !== (b.y > pt.y) &&
          pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  }

  function quadArea(q) {
    // shoelace on an ordered quad
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  /* Plausibility score for "this quad is a rectangle seen in perspective".
     0 = reject. Constraints: opposite sides reasonably balanced, corner
     angles near 90 deg, quad actually matching the hull it was fitted to. */
  function quadScore(q, hullArea) {
    const sides = [];
    for (let i = 0; i < 4; i++) sides.push(dist(q[i], q[(i + 1) % 4]));
    if (Math.min(...sides) < 1) return 0;
    // opposite sides: a tilted rectangle foreshortens one edge, but not
    // beyond ~2:1 at any usable angle
    const r1 = Math.min(sides[0], sides[2]) / Math.max(sides[0], sides[2]);
    const r2 = Math.min(sides[1], sides[3]) / Math.max(sides[1], sides[3]);
    if (r1 < 0.45 || r2 < 0.45) return 0;
    // corner angles within 90 +/- 50 deg
    for (let i = 0; i < 4; i++) {
      const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
      const v1 = { x: p.x - c.x, y: p.y - c.y };
      const v2 = { x: n.x - c.x, y: n.y - c.y };
      const cos = (v1.x * v2.x + v1.y * v2.y) /
        (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
      const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      if (ang < 40 || ang > 140) return 0;
    }
    // the fitted quad must actually match the shape it came from
    const area = quadArea(q);
    const fit = area / hullArea;
    if (fit < 0.75 || fit > 1.3) return 0;
    // bigger and more rectangular wins
    return area * (0.5 + 0.5 * Math.min(r1, r2));
  }

  /* Fit a quad to one contour: convex hull first (skips envelope flaps and
     other concavities), then approxPolyDP at increasing tolerance so rounded
     corners still collapse to 4 points. Returns {quad, hullArea} or null. */
  function quadFromContour(c) {
    const cv = window.cv;
    const hull = new cv.Mat();
    const approx = new cv.Mat();
    let quad = null;
    let hullArea = 0;
    try {
      cv.convexHull(c, hull, false, true);
      hullArea = cv.contourArea(hull);
      const peri = cv.arcLength(hull, true);
      for (const eps of [0.02, 0.035, 0.05]) {
        cv.approxPolyDP(hull, approx, eps * peri, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          quad = [];
          for (let j = 0; j < 4; j++) {
            quad.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          }
          break;
        }
      }
    } finally {
      hull.delete(); approx.delete();
    }
    return quad ? { quad, hullArea } : null;
  }

  /* Find the document quad in a canvas. Returns [tl,tr,br,bl] in source
     coordinates, or null. Works on a <=480px downscale for speed.
     `near` ({x,y} in source coords) is a user tap: quads containing that
     point win over anything bigger elsewhere in the frame. */
  function detectQuad(srcCanvas, near) {
    const cv = window.cv;
    const maxDim = 480;
    const scale = Math.min(1, maxDim / Math.max(srcCanvas.width, srcCanvas.height));
    const small = document.createElement("canvas");
    small.width = Math.round(srcCanvas.width * scale);
    small.height = Math.round(srcCanvas.height * scale);
    small.getContext("2d").drawImage(srcCanvas, 0, 0, small.width, small.height);
    const nearPt = near ? { x: near.x * scale, y: near.y * scale } : null;

    const frameArea = small.width * small.height;
    const minArea = frameArea * 0.06;
    const maxArea = frameArea * 0.98; // reject the frame border itself

    const src = cv.imread(small);
    const gray = new cv.Mat();
    const edges = new cv.Mat();
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    const candidates = [];

    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

      // progressively lower thresholds catch low-contrast subjects
      // (white envelope on a pale table)
      for (const [lo, hi] of [[75, 200], [30, 120], [15, 60]]) {
        cv.Canny(gray, edges, lo, hi);
        cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);

        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        for (let i = 0; i < contours.size(); i++) {
          const c = contours.get(i);
          const area = cv.contourArea(c);
          if (area > minArea && area < maxArea) {
            const fitted = quadFromContour(c);
            // snaky merged-noise contours have low solidity: skip before
            // they produce a sloppy hull-quad
            if (fitted && area / fitted.hullArea > 0.7) {
              const q = orderCorners(fitted.quad);
              const score = quadScore(q, fitted.hullArea);
              if (score > 0) candidates.push({ quad: q, area: quadArea(q), score });
            }
          }
          c.delete();
        }
        contours.delete();
        hierarchy.delete();
        if (candidates.length) break;
      }
    } finally {
      src.delete(); gray.delete(); edges.delete(); kernel.delete();
    }

    if (!candidates.length) return null;
    const scaled = (c) => c.quad.map((p) => ({ x: p.x / scale, y: p.y / scale }));

    if (nearPt) {
      // a tap is a lock on that spot — never jump to a different item
      const containing = candidates.filter((c) => pointInQuad(nearPt, c.quad));
      if (containing.length) {
        // tightest quad around the tap — "this specific thing", not the
        // table edge that happens to contain it too
        return scaled(containing.reduce((a, b) => (b.area < a.area ? b : a)));
      }
      // nothing contains the finger: allow the nearest quad if it is
      // genuinely close (detection wobble), otherwise report nothing
      let best = null, bestD = Infinity;
      for (const c of candidates) {
        const cx = c.quad.reduce((s, p) => s + p.x, 0) / 4;
        const cy = c.quad.reduce((s, p) => s + p.y, 0) / 4;
        const d = Math.hypot(cx - nearPt.x, cy - nearPt.y);
        if (d < bestD) { bestD = d; best = c; }
      }
      const limit = 0.3 * Math.hypot(small.width, small.height);
      return best && bestD < limit ? scaled(best) : null;
    }

    return scaled(candidates.reduce((a, b) => (b.score > a.score ? b : a)));
  }

  // ---- processing ----

  const MAX_OUTPUT = 2200; // px, long side of the processed page

  function warp(srcMat, corners) {
    const cv = window.cv;
    const [tl, tr, br, bl] = corners;
    let w = Math.max(dist(tl, tr), dist(bl, br));
    let h = Math.max(dist(tl, bl), dist(tr, br));
    const s = Math.min(1, MAX_OUTPUT / Math.max(w, h));
    w = Math.max(8, Math.round(w * s));
    h = Math.max(8, Math.round(h * s));

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2,
      [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2,
      [0, 0, w, 0, w, h, 0, h]);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    const out = new cv.Mat();
    cv.warpPerspective(srcMat, out, M, new cv.Size(w, h),
      cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    srcTri.delete(); dstTri.delete(); M.delete();
    return out;
  }

  /* Measure residual tilt (deg) of the text lines after the perspective warp.
     Median angle of long near-horizontal Hough lines; 0 if inconclusive. */
  function deskewAngle(mat) {
    const cv = window.cv;
    const scale = Math.min(1, 900 / mat.cols);
    const small = new cv.Mat();
    if (scale < 1) {
      cv.resize(mat, small, new cv.Size(Math.round(mat.cols * scale), Math.round(mat.rows * scale)));
    } else {
      mat.copyTo(small);
    }
    const gray = new cv.Mat();
    const lines = new cv.Mat();
    let angle = 0;
    try {
      cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
      cv.Canny(gray, gray, 60, 180);
      cv.HoughLinesP(gray, lines, 1, Math.PI / 180, 80, small.cols * 0.25, 10);
      const angles = [];
      for (let i = 0; i < lines.rows; i++) {
        const x1 = lines.data32S[i * 4], y1 = lines.data32S[i * 4 + 1];
        const x2 = lines.data32S[i * 4 + 2], y2 = lines.data32S[i * 4 + 3];
        let a = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        if (a > 90) a -= 180;
        if (a < -90) a += 180;
        if (Math.abs(a) <= 6) angles.push(a);
      }
      if (angles.length >= 3) {
        angles.sort((a, b) => a - b);
        const med = angles[Math.floor(angles.length / 2)];
        if (Math.abs(med) >= 0.3) angle = med;
      }
    } finally {
      small.delete(); gray.delete(); lines.delete();
    }
    return angle;
  }

  function rotateFine(mat, angle) {
    const cv = window.cv;
    const M = cv.getRotationMatrix2D(new cv.Point(mat.cols / 2, mat.rows / 2), angle, 1);
    const out = new cv.Mat();
    cv.warpAffine(mat, out, M, new cv.Size(mat.cols, mat.rows),
      cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    M.delete();
    return out;
  }

  /* Mild unsharp mask, in place. */
  function sharpen(mat, amount) {
    const cv = window.cv;
    const blur = new cv.Mat();
    cv.GaussianBlur(mat, blur, new cv.Size(0, 0), 1.2);
    cv.addWeighted(mat, 1 + amount, blur, -amount, 0, mat);
    blur.delete();
  }

  /* Local-contrast recovery around glare/highlights: CLAHE on the L channel.
     Can't restore fully blown-out pixels, but softens glare boundaries. */
  function claheL(rgb) {
    const cv = window.cv;
    let lab, ch, L, a, b, merged, clahe;
    try {
      lab = new cv.Mat();
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
      ch = new cv.MatVector();
      cv.split(lab, ch);
      L = ch.get(0); a = ch.get(1); b = ch.get(2);
      clahe = new cv.CLAHE(1.8, new cv.Size(8, 8));
      clahe.apply(L, L);
      merged = new cv.MatVector();
      merged.push_back(L); merged.push_back(a); merged.push_back(b);
      cv.merge(merged, lab);
      cv.cvtColor(lab, rgb, cv.COLOR_Lab2RGB);
    } catch { /* CLAHE missing from this cv build — skip */
    } finally {
      for (const m of [lab, ch, L, a, b, merged, clahe]) m?.delete?.();
    }
  }

  /* "Magic" filter: estimate the paper background per channel
     (dilate + median blur) and divide it out — removes shadows and
     grey paper cast, keeps ink and colour. */
  function filterEnhanced(rgba) {
    const cv = window.cv;
    const rgb = new cv.Mat();
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    const channels = new cv.MatVector();
    cv.split(rgb, channels);
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
    const outVec = new cv.MatVector();
    const toFree = [];
    for (let i = 0; i < 3; i++) {
      const ch = channels.get(i);
      const bg = new cv.Mat();
      cv.dilate(ch, bg, kernel);
      cv.medianBlur(bg, bg, 21);
      const flat = new cv.Mat();
      cv.divide(ch, bg, flat, 255);
      outVec.push_back(flat);
      toFree.push(ch, bg, flat);
    }
    cv.merge(outVec, rgb);
    toFree.forEach((m) => m.delete());
    channels.delete(); outVec.delete(); kernel.delete();
    claheL(rgb);                       // glare-edge / local contrast recovery
    sharpen(rgb, 0.45);
    rgb.convertTo(rgb, -1, 1.03, -3);  // gentle global contrast
    return rgb;
  }

  function filterGray(rgba) {
    const cv = window.cv;
    const gray = new cv.Mat();
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    sharpen(gray, 0.3);
    return gray;
  }

  function filterBW(rgba) {
    const cv = window.cv;
    const gray = filterGray(rgba);
    let block = Math.max(15, Math.round(gray.cols / 40));
    if (block % 2 === 0) block += 1;
    const bw = new cv.Mat();
    cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY, block, 10);
    gray.delete();
    return bw;
  }

  /* Full pipeline: source canvas + corners + filter + rotation -> canvas. */
  async function processPage(srcCanvas, corners, filter, rotation) {
    await ready();
    const cv = window.cv;
    const src = cv.imread(srcCanvas);
    let mat;
    try {
      mat = warp(src, corners || defaultCorners(srcCanvas.width, srcCanvas.height));
    } finally {
      src.delete();
    }

    // fine deskew: straighten residual 0.3-6 degree tilt of the text lines
    try {
      const ang = deskewAngle(mat);
      if (ang) {
        const straight = rotateFine(mat, ang);
        mat.delete();
        mat = straight;
      }
    } catch { /* keep unrotated */ }

    let filtered = mat;
    if (filter === "enhanced") filtered = filterEnhanced(mat);
    else if (filter === "gray") filtered = filterGray(mat);
    else if (filter === "bw") filtered = filterBW(mat);
    if (filtered !== mat) mat.delete();

    const flat = document.createElement("canvas");
    cv.imshow(flat, filtered);
    filtered.delete();

    if (!rotation) return flat;

    // rotate in 90-degree steps with plain 2D canvas
    const rot = document.createElement("canvas");
    const quarter = rotation % 4;
    if (quarter % 2) { rot.width = flat.height; rot.height = flat.width; }
    else { rot.width = flat.width; rot.height = flat.height; }
    const ctx = rot.getContext("2d");
    ctx.translate(rot.width / 2, rot.height / 2);
    ctx.rotate(quarter * Math.PI / 2);
    ctx.drawImage(flat, -flat.width / 2, -flat.height / 2);
    return rot;
  }

  return { ready, detectQuad, processPage, defaultCorners, orderCorners };
})();
