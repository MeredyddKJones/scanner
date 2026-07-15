/* Export: multi-page PDF (jsPDF), per-page JPG/PNG, OCR text (Tesseract.js).
   Every function takes pages = [{ processedBlob, width, height }]. */
"use strict";

const Exporter = (() => {

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

  // ---- PDF ----

  async function toPDF(pages, onProgress) {
    const { jsPDF } = window.jspdf;
    const PAGE_W = 210; // mm; page height follows the image aspect
    let pdf = null;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const hMM = PAGE_W * (p.height / p.width);
      if (!pdf) {
        pdf = new jsPDF({
          unit: "mm",
          format: [PAGE_W, hMM],
          orientation: PAGE_W > hMM ? "landscape" : "portrait",
        });
      } else {
        pdf.addPage([PAGE_W, hMM], PAGE_W > hMM ? "landscape" : "portrait");
      }
      const dataUrl = await blobToDataURL(p.processedBlob);
      pdf.addImage(dataUrl, "JPEG", 0, 0, PAGE_W, hMM);
      onProgress?.((i + 1) / pages.length, `Adding page ${i + 1}/${pages.length}`);
    }
    return pdf.output("blob");
  }

  // ---- images ----

  async function toImages(pages, format, onProgress) {
    const mime = format === "png" ? "image/png" : "image/jpeg";
    const blobs = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (format === "jpg") {
        blobs.push(p.processedBlob); // already JPEG
      } else {
        const canvas = await blobToCanvas(p.processedBlob);
        blobs.push(await canvasToBlob(canvas, mime));
      }
      onProgress?.((i + 1) / pages.length, `Page ${i + 1}/${pages.length}`);
    }
    return blobs;
  }

  // ---- OCR ----

  async function toText(pages, onProgress) {
    if (!window.Tesseract) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "vendor/tesseract.min.js";
        s.onload = resolve;
        s.onerror = () => reject(new Error("Failed to load Tesseract"));
        document.head.appendChild(s);
      });
    }
    const base = new URL("vendor/", location.href).href;
    let pageIndex = 0;
    const worker = await Tesseract.createWorker("eng", 1, {
      workerPath: base + "worker.min.js",
      corePath: base + "tesseract-core-simd.wasm.js",
      langPath: base.replace(/\/$/, ""),
      gzip: true,
      logger: (m) => {
        if (m.status === "recognizing text") {
          onProgress?.((pageIndex + m.progress) / pages.length,
            `Reading page ${pageIndex + 1}/${pages.length}`);
        }
      },
    });
    try {
      const chunks = [];
      for (pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const { data } = await worker.recognize(pages[pageIndex].processedBlob);
        chunks.push(data.text.trim());
      }
      return new Blob([chunks.join("\n\n----- page break -----\n\n")],
        { type: "text/plain" });
    } finally {
      await worker.terminate();
    }
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

  async function downloadAll(blobs, baseName, ext) {
    if (blobs.length === 1) {
      download(blobs[0], `${baseName}.${ext}`);
      return;
    }
    for (let i = 0; i < blobs.length; i++) {
      download(blobs[i], `${baseName}-${String(i + 1).padStart(2, "0")}.${ext}`);
      // Chrome needs a beat between programmatic downloads
      await new Promise((r) => setTimeout(r, 350));
    }
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

  return { toPDF, toImages, toText, download, downloadAll, filesFor, canShareFiles, share };
})();
