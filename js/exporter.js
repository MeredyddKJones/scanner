/* Export: multi-page PDF (jsPDF, optional invisible OCR text layer),
   per-page JPG/PNG (zipped when multi-page), OCR text (Tesseract.js).
   Every function takes pages = [{ processedBlob, width, height }]. */
"use strict";

const Exporter = (() => {

  // languages available for OCR; eng ships in vendor/, the rest download
  // on demand from the tessdata CDN (cached by the service worker)
  const OCR_LANGS = [
    ["eng", "English"],
    ["cym", "Welsh"],
    ["fra", "French"],
    ["deu", "German"],
    ["spa", "Spanish"],
    ["ita", "Italian"],
    ["nld", "Dutch"],
    ["por", "Portuguese"],
    ["pol", "Polish"],
  ];

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  async function blobToCanvas(blob) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    return c;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  async function reencode(blob, quality) {
    const canvas = await blobToCanvas(blob);
    return canvas.toDataURL("image/jpeg", quality);
  }

  // ---- OCR ----

  async function loadTesseract() {
    if (window.Tesseract) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "vendor/tesseract.min.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load Tesseract"));
      document.head.appendChild(s);
    });
  }

  function extractWords(data) {
    if (Array.isArray(data.words) && data.words.length) return data.words;
    const words = [];
    for (const b of data.blocks || [])
      for (const par of b.paragraphs || [])
        for (const line of par.lines || [])
          for (const w of line.words || []) words.push(w);
    return words;
  }

  /* Run OCR over all pages. Returns [{text, words:[{text,bbox}]}].
     onProgress(frac, label). */
  async function ocrPages(pages, lang, onProgress) {
    await loadTesseract();
    const base = new URL("vendor/", location.href).href;
    let pageIndex = 0;
    const worker = await Tesseract.createWorker(lang || "eng", 1, {
      workerPath: base + "worker.min.js",
      corePath: base + "tesseract-core-simd.wasm.js",
      langPath: (lang || "eng") === "eng"
        ? base.replace(/\/$/, "")
        : "https://tessdata.projectnaptha.com/4.0.0",
      gzip: true,
      logger: (m) => {
        if (m.status === "recognizing text") {
          onProgress?.((pageIndex + m.progress) / pages.length,
            `Reading page ${pageIndex + 1}/${pages.length}`);
        }
      },
    });
    try {
      const results = [];
      for (pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const { data } = await worker.recognize(
          pages[pageIndex].processedBlob, {}, { blocks: true, text: true });
        results.push({ text: (data.text || "").trim(), words: extractWords(data) });
      }
      return results;
    } finally {
      await worker.terminate();
    }
  }

  async function toText(pages, lang, onProgress) {
    const results = await ocrPages(pages, lang, onProgress);
    return new Blob(
      [results.map((r) => r.text).join("\n\n----- page break -----\n\n")],
      { type: "text/plain" });
  }

  // ---- PDF ----

  const PAGE_SIZES = { a4: [210, 297], letter: [215.9, 279.4] }; // mm, portrait

  /* opts: { pageSize: 'fit'|'a4'|'letter', quality: 0..1, ocr: results|null } */
  async function toPDF(pages, opts, onProgress) {
    const { jsPDF } = window.jspdf;
    const quality = opts.quality ?? 0.8;
    let pdf = null;

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const landscape = p.width > p.height;
      let pw, ph;
      if (opts.pageSize && PAGE_SIZES[opts.pageSize]) {
        const [a, b] = PAGE_SIZES[opts.pageSize];
        [pw, ph] = landscape ? [b, a] : [a, b];
      } else {
        pw = 210;
        ph = 210 * (p.height / p.width);
      }
      const orientation = pw > ph ? "landscape" : "portrait";
      if (!pdf) pdf = new jsPDF({ unit: "mm", format: [pw, ph], orientation });
      else pdf.addPage([pw, ph], orientation);

      // fit image inside page, centred, aspect preserved
      const drawW = Math.min(pw, ph * (p.width / p.height));
      const drawH = drawW * (p.height / p.width);
      const offX = (pw - drawW) / 2;
      const offY = (ph - drawH) / 2;
      const dataUrl = await reencode(p.processedBlob, quality);
      pdf.addImage(dataUrl, "JPEG", offX, offY, drawW, drawH);

      // invisible OCR text layer -> searchable, selectable PDF
      const words = opts.ocr?.[i]?.words;
      if (words?.length) {
        const mmPerPx = drawW / p.width;
        for (const w of words) {
          const text = (w.text || "").trim();
          const bb = w.bbox;
          if (!text || !bb) continue;
          const hMM = (bb.y1 - bb.y0) * mmPerPx;
          const pt = Math.max(4, Math.min(72, hMM * 2.83465 * 0.95));
          pdf.setFontSize(pt);
          pdf.text(text, offX + bb.x0 * mmPerPx, offY + bb.y1 * mmPerPx,
            { renderingMode: "invisible" });
        }
      }
      onProgress?.((i + 1) / pages.length, `Adding page ${i + 1}/${pages.length}`);
    }
    return pdf.output("blob");
  }

  // ---- images ----

  async function toImages(pages, format, quality, onProgress) {
    const blobs = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (format === "png") {
        const canvas = await blobToCanvas(p.processedBlob);
        blobs.push(await canvasToBlob(canvas, "image/png"));
      } else if (quality && Math.abs(quality - 0.9) > 0.02) {
        const canvas = await blobToCanvas(p.processedBlob);
        blobs.push(await canvasToBlob(canvas, "image/jpeg", quality));
      } else {
        blobs.push(p.processedBlob); // stored encoding is already jpeg 0.9
      }
      onProgress?.((i + 1) / pages.length, `Page ${i + 1}/${pages.length}`);
    }
    return blobs;
  }

  async function toZip(blobs, baseName, ext) {
    const entries = {};
    for (let i = 0; i < blobs.length; i++) {
      const name = `${baseName}-${String(i + 1).padStart(2, "0")}.${ext}`;
      entries[name] = new Uint8Array(await blobs[i].arrayBuffer());
    }
    // images are already compressed - store, don't deflate
    const zipped = fflate.zipSync(entries, { level: 0 });
    return new Blob([zipped], { type: "application/zip" });
  }

  // ---- delivery ----

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function filesFor(blobs, baseName, ext, mime) {
    return blobs.map((b, i) => {
      const name = blobs.length === 1
        ? `${baseName}.${ext}`
        : `${baseName}-${String(i + 1).padStart(2, "0")}.${ext}`;
      return new File([b], name, { type: mime });
    });
  }

  function canShareFiles(files) {
    return !!(navigator.canShare && navigator.canShare({ files }));
  }

  async function share(files) {
    await navigator.share({ files });
  }

  return {
    OCR_LANGS, toPDF, toImages, toText, toZip, ocrPages,
    download, filesFor, canShareFiles, share,
  };
})();
