/* App glue: camera, page state, edit screen, pages grid, export sheet. */
"use strict";

(() => {
  const $ = (sel) => document.querySelector(sel);

  // ---------- state ----------
  const pages = []; // {id, originalBlob, corners, filter, rotation, processedBlob, thumbUrl, width, height}
  let nextId = 1;
  let currentPage = null;
  let editOriginal = null;   // decoded original canvas while editing
  let cropMode = false;
  let cropCorners = null;    // displayed-space corners while dragging
  let stream = null;
  let torchOn = false;
  let detectTimer = null;
  let cvOk = null;           // null = loading, true/false once known

  // ---------- tiny helpers ----------
  function canvasToBlob(canvas, type, q) {
    return new Promise((res) => canvas.toBlob(res, type, q));
  }
  async function blobToCanvas(blob) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    return c;
  }
  function makeThumb(canvas) {
    const w = 300, h = Math.round(canvas.height * (w / canvas.width));
    const t = document.createElement("canvas");
    t.width = w; t.height = h;
    t.getContext("2d").drawImage(canvas, 0, 0, w, h);
    return t.toDataURL("image/jpeg", 0.7);
  }

  let toastTimer = null;
  function toast(msg, ms = 2200) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
  }

  // ---------- screens ----------
  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) =>
      s.classList.toggle("active", s.id === id));
    if (id === "screen-camera") startCamera();
    else stopCamera();
    if (id === "screen-pages") renderPages();
  }

  // ---------- OpenCV status ----------
  Detector.ready().then(
    () => { cvOk = true; $("#cv-status").classList.add("hidden"); },
    () => {
      cvOk = false;
      $("#cv-status").textContent = "auto-detect unavailable";
      toast("Edge detection failed to load — using plain crop");
    },
  );

  // ---------- camera ----------
  const video = $("#video");
  const overlay = $("#overlay");

  async function startCamera() {
    if (stream) return;
    const msg = $("#cam-message");
    msg.classList.add("hidden");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 4096 },
          height: { ideal: 4096 },
        },
        audio: false,
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      const caps = stream.getVideoTracks()[0].getCapabilities?.();
      $("#btn-torch").classList.toggle("hidden", !caps || !caps.torch);
      startDetectLoop();
    } catch (err) {
      stream = null;
      msg.textContent =
        "Camera unavailable (" + (err.name || err.message) + "). " +
        "You can still import photos from the gallery with the button below-left.";
      msg.classList.remove("hidden");
    }
  }

  function stopCamera() {
    clearInterval(detectTimer);
    detectTimer = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
    torchOn = false;
    $("#btn-torch").classList.remove("on");
  }

  function startDetectLoop() {
    clearInterval(detectTimer);
    const small = document.createElement("canvas");
    detectTimer = setInterval(() => {
      if (!stream || cvOk !== true || !video.videoWidth) return;
      const k = 480 / Math.max(video.videoWidth, video.videoHeight);
      small.width = Math.round(video.videoWidth * k);
      small.height = Math.round(video.videoHeight * k);
      small.getContext("2d").drawImage(video, 0, 0, small.width, small.height);
      let quad = null;
      try { quad = Detector.detectQuad(small); } catch { /* skip frame */ }
      drawOverlay(quad, k);
    }, 220);
  }

  function drawOverlay(quad, k) {
    const stage = $("#cam-stage");
    const dpr = window.devicePixelRatio || 1;
    const cw = stage.clientWidth, ch = stage.clientHeight;
    if (overlay.width !== cw * dpr) { overlay.width = cw * dpr; overlay.height = ch * dpr; }
    const ctx = overlay.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!quad) return;
    // video is object-fit: cover — map video coords to displayed coords
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(cw / vw, ch / vh);
    const dx = (cw - vw * s) / 2, dy = (ch - vh * s) / 2;
    ctx.beginPath();
    quad.forEach((p, i) => {
      const x = (p.x / k) * s + dx, y = (p.y / k) * s + dy;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = "rgba(51,181,160,.15)";
    ctx.strokeStyle = "#33b5a0";
    ctx.lineWidth = 2.5;
    ctx.fill();
    ctx.stroke();
  }

  $("#btn-torch").addEventListener("click", async () => {
    if (!stream) return;
    torchOn = !torchOn;
    try {
      await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] });
      $("#btn-torch").classList.toggle("on", torchOn);
    } catch { torchOn = false; }
  });

  // ---------- page creation ----------
  async function reprocess(page, origCanvas) {
    const src = origCanvas || await blobToCanvas(page.originalBlob);
    let out;
    try {
      out = await Detector.processPage(src, page.corners, page.filter, page.rotation);
    } catch {
      out = fallbackProcess(src, page.rotation); // no OpenCV: plain rotate only
    }
    page.width = out.width;
    page.height = out.height;
    page.processedBlob = await canvasToBlob(out, "image/jpeg", 0.9);
    page.thumbUrl = makeThumb(out);
    return out;
  }

  function fallbackProcess(src, rotation) {
    const q = (rotation || 0) % 4;
    const c = document.createElement("canvas");
    if (q % 2) { c.width = src.height; c.height = src.width; }
    else { c.width = src.width; c.height = src.height; }
    const ctx = c.getContext("2d");
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(q * Math.PI / 2);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }

  async function createPage(srcCanvas) {
    const page = {
      id: nextId++,
      originalBlob: await canvasToBlob(srcCanvas, "image/jpeg", 0.92),
      corners: null,
      filter: "enhanced",
      rotation: 0,
      processedBlob: null,
      thumbUrl: "",
      width: srcCanvas.width,
      height: srcCanvas.height,
    };
    if (cvOk !== false) {
      try {
        await Detector.ready();
        page.corners = Detector.detectQuad(srcCanvas);
      } catch { /* leave null -> near-full-frame crop */ }
    }
    pages.push(page);
    return page;
  }

  $("#btn-shutter").addEventListener("click", async () => {
    if (!stream || !video.videoWidth) { toast("Camera not ready"); return; }
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    stopCamera();
    showSpinner(true);
    showScreenBare("screen-edit");
    const page = await createPage(c);
    await openEdit(page, c);
  });

  // like showScreen but without camera side-effects (already handled)
  function showScreenBare(id) {
    document.querySelectorAll(".screen").forEach((s) =>
      s.classList.toggle("active", s.id === id));
  }

  $("#btn-import").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length) return;
    stopCamera();
    if (files.length === 1) {
      showSpinner(true);
      showScreenBare("screen-edit");
      const c = await fileToCanvas(files[0]);
      const page = await createPage(c);
      await openEdit(page, c);
      return;
    }
    for (let i = 0; i < files.length; i++) {
      toast(`Importing ${i + 1}/${files.length}…`, 4000);
      const c = await fileToCanvas(files[i]);
      const page = await createPage(c);
      await reprocess(page, c);
    }
    updateBadge();
    showScreen("screen-pages");
  });

  async function fileToCanvas(file) {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    return c;
  }

  // ---------- edit screen ----------
  const editCanvas = $("#edit-canvas");

  function showSpinner(on) {
    $("#edit-spinner").classList.toggle("hidden", !on);
  }

  async function openEdit(page, origCanvas) {
    currentPage = page;
    editOriginal = origCanvas || await blobToCanvas(page.originalBlob);
    exitCropMode(false);
    $("#edit-title").textContent = "Page " + (pages.indexOf(page) + 1);
    document.querySelectorAll("#filter-row .chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.filter === page.filter));
    showScreenBare("screen-edit");
    await refreshEdit();
  }

  async function refreshEdit() {
    showSpinner(true);
    const out = await reprocess(currentPage, editOriginal);
    editCanvas.width = out.width;
    editCanvas.height = out.height;
    editCanvas.getContext("2d").drawImage(out, 0, 0);
    showSpinner(false);
    updateBadge();
  }

  $("#filter-row").addEventListener("click", async (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || !currentPage || cropMode) return;
    currentPage.filter = chip.dataset.filter;
    document.querySelectorAll("#filter-row .chip").forEach((c) =>
      c.classList.toggle("active", c === chip));
    await refreshEdit();
  });

  $("#btn-rotate").addEventListener("click", async () => {
    if (!currentPage || cropMode) return;
    currentPage.rotation = (currentPage.rotation + 1) % 4;
    await refreshEdit();
  });

  function closeEdit() {
    editOriginal = null;
    currentPage = null;
    showScreen("screen-pages");
  }
  $("#btn-done").addEventListener("click", closeEdit);
  $("#edit-back").addEventListener("click", () => {
    if (cropMode) { exitCropMode(false); redrawProcessed(); return; }
    closeEdit();
  });

  async function redrawProcessed() {
    if (!currentPage) return;
    const out = await blobToCanvas(currentPage.processedBlob);
    editCanvas.width = out.width;
    editCanvas.height = out.height;
    editCanvas.getContext("2d").drawImage(out, 0, 0);
  }

  $("#edit-delete").addEventListener("click", () => {
    if (!currentPage) return;
    pages.splice(pages.indexOf(currentPage), 1);
    updateBadge();
    editOriginal = null;
    currentPage = null;
    showScreen(pages.length ? "screen-pages" : "screen-camera");
  });

  // ---- crop (corner adjust) mode ----
  const cornerLayer = $("#corner-layer");
  const handles = [...document.querySelectorAll(".handle")];

  $("#btn-corners").addEventListener("click", async () => {
    if (!currentPage) return;
    if (cropMode) {
      // Apply: displayed coords -> original image coords
      const rect = canvasDisplayRect();
      currentPage.corners = Detector.orderCorners(cropCorners.map((p) => ({
        x: (p.x - rect.left) / rect.width * editOriginal.width,
        y: (p.y - rect.top) / rect.height * editOriginal.height,
      })));
      exitCropMode(false);
      await refreshEdit();
    } else {
      enterCropMode();
    }
  });

  function canvasDisplayRect() {
    const stage = $("#edit-stage").getBoundingClientRect();
    const c = editCanvas.getBoundingClientRect();
    return {
      left: c.left - stage.left,
      top: c.top - stage.top,
      width: c.width,
      height: c.height,
    };
  }

  function enterCropMode() {
    cropMode = true;
    // show the *original* so the user can re-place corners
    editCanvas.width = editOriginal.width;
    editCanvas.height = editOriginal.height;
    editCanvas.getContext("2d").drawImage(editOriginal, 0, 0);

    const rect = canvasDisplayRect();
    const src = currentPage.corners ||
      Detector.defaultCorners(editOriginal.width, editOriginal.height);
    cropCorners = src.map((p) => ({
      x: rect.left + p.x / editOriginal.width * rect.width,
      y: rect.top + p.y / editOriginal.height * rect.height,
    }));
    cornerLayer.classList.remove("hidden");
    $("#filter-row").style.visibility = "hidden";
    $("#btn-rotate").style.visibility = "hidden";
    $("#btn-done").style.visibility = "hidden";
    $("#btn-corners").classList.add("active");
    $("#btn-corners").querySelector("span").textContent = "Apply";
    layoutHandles();
  }

  function exitCropMode() {
    cropMode = false;
    cropCorners = null;
    cornerLayer.classList.add("hidden");
    $("#filter-row").style.visibility = "";
    $("#btn-rotate").style.visibility = "";
    $("#btn-done").style.visibility = "";
    $("#btn-corners").classList.remove("active");
    $("#btn-corners").querySelector("span").textContent = "Crop";
  }

  function layoutHandles() {
    if (!cropCorners) return;
    handles.forEach((h, i) => {
      h.style.left = cropCorners[i].x + "px";
      h.style.top = cropCorners[i].y + "px";
    });
    const svg = $("#corner-lines");
    svg.innerHTML = "";
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("points", cropCorners.map((p) => `${p.x},${p.y}`).join(" "));
    svg.appendChild(poly);
  }

  handles.forEach((h) => {
    h.addEventListener("pointerdown", (e) => {
      if (!cropMode) return;
      h.setPointerCapture(e.pointerId);
      const i = +h.dataset.i;
      const stage = $("#edit-stage").getBoundingClientRect();
      const move = (ev) => {
        const rect = canvasDisplayRect();
        cropCorners[i] = {
          x: Math.min(rect.left + rect.width, Math.max(rect.left, ev.clientX - stage.left)),
          y: Math.min(rect.top + rect.height, Math.max(rect.top, ev.clientY - stage.top)),
        };
        layoutHandles();
      };
      const up = () => {
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
        h.removeEventListener("pointercancel", up);
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
      e.preventDefault();
    });
  });

  // ---------- pages screen ----------
  function updateBadge() {
    const badge = $("#btn-pages");
    $("#badge-count").textContent = pages.length;
    badge.classList.toggle("has-pages", pages.length > 0);
    const last = pages[pages.length - 1];
    if (last?.thumbUrl) $("#badge-thumb").src = last.thumbUrl;
    else $("#badge-thumb").removeAttribute("src");
    $("#btn-export").disabled = pages.length === 0;
  }

  function renderPages() {
    const grid = $("#page-grid");
    grid.innerHTML = "";
    $("#pages-title").textContent = `Pages (${pages.length})`;
    $("#pages-empty").classList.toggle("hidden", pages.length > 0);
    $("#btn-export").disabled = pages.length === 0;
    pages.forEach((page, i) => {
      const tile = document.createElement("div");
      tile.className = "page-tile";
      tile.innerHTML = `
        <img src="${page.thumbUrl}" alt="Page ${i + 1}">
        <div class="tile-bar">
          <button class="tile-btn" data-act="left" title="Move earlier">←</button>
          <span class="num">${i + 1}</span>
          <button class="tile-btn" data-act="right" title="Move later">→</button>
          <button class="tile-btn del" data-act="del" title="Delete">✕</button>
        </div>`;
      tile.querySelector("img").addEventListener("click", () => openEdit(page));
      tile.querySelector('[data-act="left"]').addEventListener("click", () => {
        if (i > 0) { [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]]; renderPages(); }
      });
      tile.querySelector('[data-act="right"]').addEventListener("click", () => {
        if (i < pages.length - 1) { [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]]; renderPages(); }
      });
      tile.querySelector('[data-act="del"]').addEventListener("click", () => {
        pages.splice(i, 1);
        updateBadge();
        renderPages();
      });
      grid.appendChild(tile);
    });
  }

  $("#btn-pages").addEventListener("click", () => showScreen("screen-pages"));
  $("#pages-back").addEventListener("click", () => showScreen("screen-camera"));
  $("#btn-add").addEventListener("click", () => showScreen("screen-camera"));
  $("#pages-clear").addEventListener("click", () => {
    if (!pages.length) return;
    if (confirm(`Delete all ${pages.length} pages?`)) {
      pages.length = 0;
      updateBadge();
      renderPages();
    }
  });

  // ---------- export ----------
  let exportFormat = "pdf";
  let exporting = false;

  function openSheet() {
    if (!pages.length) { toast("No pages to export"); return; }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    $("#export-name").value =
      `scan-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    $("#sheet-backdrop").classList.remove("hidden");
    $("#sheet-export").classList.remove("hidden");
    $("#export-progress").classList.add("hidden");
    updateShareVisibility();
  }
  function closeSheet() {
    if (exporting) return;
    $("#sheet-backdrop").classList.add("hidden");
    $("#sheet-export").classList.add("hidden");
  }
  $("#btn-export").addEventListener("click", openSheet);
  $("#sheet-backdrop").addEventListener("click", closeSheet);

  $("#format-row").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    exportFormat = chip.dataset.format;
    document.querySelectorAll("#format-row .chip").forEach((c) =>
      c.classList.toggle("active", c === chip));
    updateShareVisibility();
  });

  function updateShareVisibility() {
    const dummy = new File(["x"], "x.pdf", { type: "application/pdf" });
    $("#btn-share").classList.toggle("hidden", !Exporter.canShareFiles([dummy]));
  }

  function setProgress(frac, label) {
    $("#export-progress").classList.remove("hidden");
    $("#progress-fill").style.width = Math.round(frac * 100) + "%";
    $("#progress-label").textContent = label || "";
  }

  const FORMAT_INFO = {
    pdf: { ext: "pdf", mime: "application/pdf" },
    jpg: { ext: "jpg", mime: "image/jpeg" },
    png: { ext: "png", mime: "image/png" },
    txt: { ext: "txt", mime: "text/plain" },
  };

  async function runExport(deliver) {
    if (exporting || !pages.length) return;
    exporting = true;
    $("#btn-save").disabled = true;
    $("#btn-share").disabled = true;
    const name = ($("#export-name").value.trim() || "scan")
      .replace(/[\\/:*?"<>|]/g, "-");
    const info = FORMAT_INFO[exportFormat];
    try {
      let blobs;
      if (exportFormat === "pdf") {
        blobs = [await Exporter.toPDF(pages, setProgress)];
      } else if (exportFormat === "txt") {
        setProgress(0, "Starting OCR (first run loads the language model)…");
        blobs = [await Exporter.toText(pages, setProgress)];
      } else {
        blobs = await Exporter.toImages(pages, exportFormat, setProgress);
      }
      setProgress(1, "Done");
      await deliver(blobs, name, info);
      closeSheetAfterExport();
    } catch (err) {
      console.error(err);
      toast("Export failed: " + (err.message || err.name || "unknown error"), 4000);
    } finally {
      exporting = false;
      $("#btn-save").disabled = false;
      $("#btn-share").disabled = false;
    }
  }

  function closeSheetAfterExport() {
    $("#sheet-backdrop").classList.add("hidden");
    $("#sheet-export").classList.add("hidden");
  }

  $("#btn-save").addEventListener("click", () =>
    runExport(async (blobs, name, info) => {
      await Exporter.downloadAll(blobs, name, info.ext);
      toast(blobs.length > 1 ? `${blobs.length} files saved` : "Saved");
    }));

  $("#btn-share").addEventListener("click", () =>
    runExport(async (blobs, name, info) => {
      const files = Exporter.filesFor(blobs, name, info.ext, info.mime);
      if (Exporter.canShareFiles(files)) await Exporter.share(files);
      else { await Exporter.downloadAll(blobs, name, info.ext); toast("Sharing unsupported — saved instead"); }
    }));

  // ---------- lifecycle ----------
  document.addEventListener("visibilitychange", () => {
    const onCamera = $("#screen-camera").classList.contains("active");
    if (document.hidden) stopCamera();
    else if (onCamera) startCamera();
  });

  window.addEventListener("resize", () => { if (cropMode) layoutHandles(); });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  updateBadge();
  showScreen("screen-camera");
})();
