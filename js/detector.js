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

  /* Find the document quad in a canvas. Returns [tl,tr,br,bl] in source
     coordinates, or null. Works on a <=480px downscale for speed. */
  function detectQuad(srcCanvas) {
    const cv = window.cv;
    const maxDim = 480;
    const scale = Math.min(1, maxDim / Math.max(srcCanvas.width, srcCanvas.height));
    const small = document.createElement("canvas");
    small.width = Math.round(srcCanvas.width * scale);
    small.height = Math.round(srcCanvas.height * scale);
    small.getContext("2d").drawImage(srcCanvas, 0, 0, small.width, small.height);

    const src = cv.imread(small);
    const gray = new cv.Mat();
    const edges = new cv.Mat();
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    let best = null;
    let bestArea = small.width * small.height * 0.12; // must cover >=12% of frame

    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

      for (const [lo, hi] of [[75, 200], [30, 120]]) {
        cv.Canny(gray, edges, lo, hi);
        cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);

        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        for (let i = 0; i < contours.size(); i++) {
          const c = contours.get(i);
          const area = cv.contourArea(c);
          if (area > bestArea) {
            const peri = cv.arcLength(c, true);
            const approx = new cv.Mat();
            cv.approxPolyDP(c, approx, 0.02 * peri, true);
            if (approx.rows === 4 && cv.isContourConvex(approx)) {
              bestArea = area;
              best = [];
              for (let j = 0; j < 4; j++) {
                best.push({
                  x: approx.data32S[j * 2] / scale,
                  y: approx.data32S[j * 2 + 1] / scale,
                });
              }
            }
            approx.delete();
          }
          c.delete();
        }
        contours.delete();
        hierarchy.delete();
        if (best) break;
      }
    } finally {
      src.delete(); gray.delete(); edges.delete(); kernel.delete();
    }
    return best ? orderCorners(best) : null;
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
    rgb.convertTo(rgb, -1, 1.06, -6); // gentle contrast
    toFree.forEach((m) => m.delete());
    channels.delete(); outVec.delete(); kernel.delete();
    return rgb;
  }

  function filterGray(rgba) {
    const cv = window.cv;
    const gray = new cv.Mat();
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
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
