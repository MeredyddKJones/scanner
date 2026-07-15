/* App glue: camera, document/page state + IndexedDB persistence, library,
   edit screen, pages grid, export sheet. */
"use strict";

(() => {
  const $ = (sel) => document.querySelector(sel);

  // ---------- state ----------
  let doc = null;    // {id, name, created, updated} — active document
  const pages = []; // [{id, originalBlob, corners, filter, rotation, processedBlob, thumbUrl, width, height}]
  let nextId = 1;
  let currentPage = null;
  let editOriginal = null;   // decoded original canvas while editing
  let cropMode = false;
  let cropCorners = null;    // displayed-space corners while dragging
  let stream = null;
  let torchOn = false;
  let detectTimer = null;
  let cvOk = null;           // null = loading, true/false once known
  let capturing = false;
  let autoOn = localStorage.getItem("autoCapture") === "1";
  let batchOn = localStorage.getItem("batchMode") === "1";

  // ---------- tiny helpers ----------
  function canvasToBlob(canvas, type, q) {
    return new Promise((res) => canvas.toBlob(res, type, q));
  }
  async function bitmapFrom(blobOrFile) {
    try {
      return await createImageBitmap(blobOrFile, { imageOrientation: "from-image" });
    } catch {
      return await createImageBitmap(blobOrFile);
    }
  }
  async function blobToCanvas(blob) {
    const bmp = await bitmapFrom(blob);
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

  // ---------- persistence ----------
  function defaultDocName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `Scan ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function ensureDoc() {
    if (doc) return;
    doc = {
      id: (crypto.randomUUID ? crypto.randomUUID() : "d" + Date.now() + Math.random()),
      name: defaultDocName(),
      created: Date.now(),
      updated: Date.now(),
    };
    DB.kvSet("activeDocId", doc.id).catch(() => {});
  }

  function pageRecord(p) {
    return {
      corners: p.corners, filter: p.filter, rotation: p.rotation,
      originalBlob: p.originalBlob, processedBlob: p.processedBlob,
      thumbUrl: p.thumbUrl, width: p.width, height: p.height,
    };
  }

  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 700);
  }
  async function persistNow() {
    clearTimeout(persistTimer);
    if (!doc) return;
    if (!pages.length) {
      // an emptied document disappears from the library
      await DB.delDoc(doc.id).catch(() => {});
      await DB.kvDel("activeDocId").catch(() => {});
      doc = null;
      return;
    }
    doc.updated = Date.now();
    await DB.putDoc({ ...doc, pages: pages.map(pageRecord) }).catch(() => {});
  }

  function loadDoc(record) {
    doc = { id: record.id, name: record.name, created: record.created, updated: record.updated };
    pages.length = 0;
    for (const p of record.pages || []) pages.push({ id: nextId++, ...p });
    DB.kvSet("activeDocId", doc.id).catch(() => {});
    updateBadge();
  }

  async function startNewDoc() {
    await persistNow();
    doc = null;
    pages.length = 0;
    await DB.kvDel("activeDocId").catch(() => {});
    updateBadge();
  }

  // ---------- screens ----------
  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) =>
      s.classList.toggle("active", s.id === id));
    if (id === "screen-camera") startCamera();
    else stopCamera();
    if (id === "screen-pages") renderPages();
    if (id === "screen-library") renderLibrary();
  }
  // like showScreen but without camera side-effects (already handled)
  function showScreenBare(id) {
    document.querySelectorAll(".screen").forEach((s) =>
      s.classList.toggle("active", s.id === id));
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

  // ---- live detection + auto-capture ----
  const AUTO_NEED = 5;        // stable ticks (~1.1 s) before auto-capture
  const AUTO_TOL = 9;         // max corner drift in detect-canvas px
  let stableCount = 0;
  let lastQuad = null;
  let autoCooldownUntil = 0;

  function quadStable(a, b) {
    if (!a || !b) return false;
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y) > AUTO_TOL) return false;
    }
    return true;
  }

  function startDetectLoop() {
    clearInterval(detectTimer);
    stableCount = 0;
    lastQuad = null;
    const small = document.createElement("canvas");
    detectTimer = setInterval(() => {
      if (!stream || cvOk !== true || !video.videoWidth || capturing) return;
      const k = 480 / Math.max(video.videoWidth, video.videoHeight);
      small.width = Math.round(video.videoWidth * k);
      small.height = Math.round(video.videoHeight * k);
      small.getContext("2d").drawImage(video, 0, 0, small.width, small.height);
      let quad = null;
      try { quad = Detector.detectQuad(small); } catch { /* skip frame */ }

      let progress = 0;
      if (autoOn && quad && Date.now() > autoCooldownUntil) {
        stableCount = quadStable(quad, lastQuad) ? stableCount + 1 : 0;
        progress = Math.min(1, stableCount / AUTO_NEED);
        if (stableCount >= AUTO_NEED) {
          stableCount = 0;
          autoCooldownUntil = Date.now() + 2500;
          capture();
        }
      } else {
        stableCount = 0;
      }
      lastQuad = quad;
      drawOverlay(quad, k, progress);
    }, 220);
  }

  function drawOverlay(quad, k, progress) {
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
    const mapped = quad.map((p) => ({ x: (p.x / k) * s + dx, y: (p.y / k) * s + dy }));
    ctx.beginPath();
    mapped.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = "rgba(51,181,160,.15)";
    ctx.strokeStyle = "#33b5a0";
    ctx.lineWidth = 2.5;
    ctx.fill();
    ctx.stroke();
    if (progress > 0.15) {
      const cx = mapped.reduce((a, p) => a + p.x, 0) / 4;
      const cy = mapped.reduce((a, p) => a + p.y, 0) / 4;
      ctx.beginPath();
      ctx.arc(cx, cy, 26, -Math.PI / 2, -Math.PI / 2 + progress * 2 * Math.PI);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.stroke();
    }
  }

  $("#btn-torch").addEventListener("click", async () => {
    if (!stream) return;
    torchOn = !torchOn;
    try {
      await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] });
      $("#btn-torch").classList.toggle("on", torchOn);
    } catch { torchOn = false; }
  });

  function syncToggles() {
    $("#btn-auto").classList.toggle("on", autoOn);
    $("#btn-batch").classList.toggle("on", batchOn);
  }
  $("#btn-auto").addEventListener("click", () => {
    autoOn = !autoOn;
    localStorage.setItem("autoCapture", autoOn ? "1" : "0");
    stableCount = 0;
    syncToggles();
    toast(autoOn ? "Auto-capture on: hold steady over a document" : "Auto-capture off");
  });
  $("#btn-batch").addEventListener("click", () => {
    batchOn = !batchOn;
    localStorage.setItem("batchMode", batchOn ? "1" : "0");
    syncToggles();
    toast(batchOn ? "Batch mode: pages queue up, review later" : "Batch mode off");
  });

  // ---------- capture ----------

  /* Full-sensor still via ImageCapture when available (sharper than the
     video stream), falling back to a video frame. */
  async function captureFrame() {
    const track = stream?.getVideoTracks()[0];
    if (window.ImageCapture && track) {
      try {
        const ic = new ImageCapture(track);
        const blob = await Promise.race([
          ic.takePhoto(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3500)),
        ]);
        const bmp = await bitmapFrom(blob);
        const c = document.createElement("canvas");
        c.width = bmp.width; c.height = bmp.height;
        c.getContext("2d").drawImage(bmp, 0, 0);
        bmp.close();
        return c;
      } catch { /* fall through to video frame */ }
    }
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    return c;
  }

  async function createPage(srcCanvas) {
    ensureDoc();
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

  async function capture() {
    if (capturing || !stream || !video.videoWidth) return;
    capturing = true;
    const flash = $("#flash");
    flash.classList.remove("go");
    void flash.offsetWidth; // restart animation
    flash.classList.add("go");
    try {
      const c = await captureFrame();
      if (batchOn) {
        const page = await createPage(c);
        await reprocess(page, c);
        updateBadge();
        persist();
        toast(`Page ${pages.length} added`);
      } else {
        stopCamera();
        showSpinner(true);
        showScreenBare("screen-edit");
        const page = await createPage(c);
        await openEdit(page, c);
        persist();
      }
    } finally {
      capturing = false;
    }
  }

  $("#btn-shutter").addEventListener("click", () => {
    if (!stream || !video.videoWidth) { toast("Camera not ready"); return; }
    capture();
  });

  // ---------- import (gallery + Android share sheet) ----------
  $("#btn-import").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    importFiles(files);
  });

  async function importFiles(files) {
    if (!files.length) return;
    stopCamera();
    if (files.length === 1) {
      showSpinner(true);
      showScreenBare("screen-edit");
      const c = await blobToCanvas(files[0]);
      const page = await createPage(c);
      await openEdit(page, c);
      persist();
      return;
    }
    for (let i = 0; i < files.length; i++) {
      toast(`Importing ${i + 1}/${files.length}…`, 4000);
      const c = await blobToCanvas(files[i]);
      const page = await createPage(c);
      await reprocess(page, c);
    }
    persist();
    updateBadge();
    showScreen("screen-pages");
  }

  // ---------- processing ----------
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

  // ---------- edit screen ----------
  const editCanvas = $("#edit-canvas");

  function showSpinner(on) {
    $("#edit-spinner").classList.toggle("hidden", !on);
  }

  async function openEdit(page, origCanvas) {
    currentPage = page;
    editOriginal = origCanvas || await blobToCanvas(page.originalBlob);
    exitCropMode();
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
    persist();
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
    if (cropMode) { exitCropMode(); redrawProcessed(); return; }
    closeEdit();
  });

  async function redrawProcessed() {
    if (!currentPage?.processedBlob) return;
    const out = await blobToCanvas(currentPage.processedBlob);
    editCanvas.width = out.width;
    editCanvas.height = out.height;
    editCanvas.getContext("2d").drawImage(out, 0, 0);
  }

  $("#edit-delete").addEventListener("click", () => {
    if (!currentPage) return;
    pages.splice(pages.indexOf(currentPage), 1);
    persist();
    updateBadge();
    editOriginal = null;
    currentPage = null;
    showScreen(pages.length ? "screen-pages" : "screen-camera");
  });

  // ---- crop (corner adjust) mode with loupe ----
  const cornerLayer = $("#corner-layer");
  const handles = [...document.querySelectorAll(".handle")];
  const loupe = $("#loupe");
  const loupeCanvas = $("#loupe-canvas");

  $("#btn-corners").addEventListener("click", async () => {
    if (!currentPage) return;
    if (cropMode) {
      // Apply: displayed coords -> original image coords
      const rect = canvasDisplayRect();
      currentPage.corners = Detector.orderCorners(cropCorners.map((p) => ({
        x: (p.x - rect.left) / rect.width * editOriginal.width,
        y: (p.y - rect.top) / rect.height * editOriginal.height,
      })));
      exitCropMode();
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
    loupe.classList.add("hidden");
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

  /* Magnifier bubble above the finger while dragging a corner. */
  function updateLoupe(clientX, clientY, corner) {
    const rect = canvasDisplayRect();
    const imgX = (corner.x - rect.left) / rect.width * editOriginal.width;
    const imgY = (corner.y - rect.top) / rect.height * editOriginal.height;
    const ZOOM = 2.4;
    const srcHalf = (60 / ZOOM) * (editOriginal.width / rect.width);
    const ctx = loupeCanvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 120, 120);
    ctx.drawImage(editOriginal,
      imgX - srcHalf, imgY - srcHalf, srcHalf * 2, srcHalf * 2,
      0, 0, 120, 120);
    ctx.strokeStyle = "#33b5a0";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(60, 38); ctx.lineTo(60, 82);
    ctx.moveTo(38, 60); ctx.lineTo(82, 60);
    ctx.stroke();
    let lx = clientX - 60, ly = clientY - 160;
    lx = Math.max(8, Math.min(window.innerWidth - 128, lx));
    if (ly < 8) ly = clientY + 40; // finger near top: show below instead
    loupe.style.left = lx + "px";
    loupe.style.top = ly + "px";
    loupe.classList.remove("hidden");
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
        updateLoupe(ev.clientX, ev.clientY, cropCorners[i]);
      };
      const up = () => {
        loupe.classList.add("hidden");
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
        h.removeEventListener("pointercancel", up);
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
      updateLoupe(e.clientX, e.clientY, cropCorners[i]);
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
    $("#pages-title").textContent = doc ? doc.name : "Pages";
    $("#pages-empty").classList.toggle("hidden", pages.length > 0);
    $("#btn-export").disabled = pages.length === 0;
    pages.forEach((page, i) => {
      const tile = document.createElement("div");
      tile.className = "page-tile";
      tile.dataset.index = i;
      tile.innerHTML = `
        <img src="${page.thumbUrl}" alt="Page ${i + 1}">
        <div class="tile-bar">
          <button class="tile-btn grip" title="Drag to reorder">⠿</button>
          <span class="num">${i + 1}</span>
          <button class="tile-btn del" title="Delete">✕</button>
        </div>`;
      tile.querySelector("img").addEventListener("click", () => openEdit(page));
      tile.querySelector(".del").addEventListener("click", () => {
        pages.splice(i, 1);
        persist();
        updateBadge();
        renderPages();
      });
      attachDrag(tile.querySelector(".grip"), tile, i);
      grid.appendChild(tile);
    });
  }

  /* Drag-to-reorder: grab the ⠿ handle, a ghost follows the finger,
     drop on another tile to move the page there. */
  function attachDrag(grip, tile, fromIndex) {
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      tile.classList.add("dragging");
      const ghost = document.createElement("img");
      ghost.id = "drag-ghost";
      ghost.src = tile.querySelector("img").src;
      document.body.appendChild(ghost);
      let target = null;

      const move = (ev) => {
        ghost.style.left = ev.clientX + "px";
        ghost.style.top = ev.clientY + "px";
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const over = el?.closest(".page-tile");
        if (target && target !== over) target.classList.remove("drop-target");
        target = (over && over !== tile) ? over : null;
        if (target) target.classList.add("drop-target");
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        ghost.remove();
        tile.classList.remove("dragging");
        if (target) {
          const toIndex = +target.dataset.index;
          const [moved] = pages.splice(fromIndex, 1);
          pages.splice(toIndex, 0, moved);
          persist();
          updateBadge();
        }
        renderPages();
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
      move(e);
    });
  }

  $("#btn-pages").addEventListener("click", () => showScreen("screen-pages"));
  $("#pages-back").addEventListener("click", () => showScreen("screen-camera"));
  $("#btn-add").addEventListener("click", () => showScreen("screen-camera"));
  $("#pages-clear").addEventListener("click", async () => {
    if (!pages.length) return;
    if (confirm(`Delete all ${pages.length} pages?`)) {
      pages.length = 0;
      await persistNow(); // removes the emptied doc from the library
      updateBadge();
      renderPages();
    }
  });

  $("#pages-title").addEventListener("click", () => {
    if (!doc) return;
    const name = prompt("Document name:", doc.name);
    if (name?.trim()) {
      doc.name = name.trim();
      $("#pages-title").textContent = doc.name;
      persist();
    }
  });

  // ---------- library ----------
  async function renderLibrary() {
    await persistNow();
    const list = $("#doc-list");
    list.innerHTML = "";
    let docs = [];
    try { docs = await DB.allDocs(); } catch { /* show empty */ }
    docs.sort((a, b) => b.updated - a.updated);
    $("#library-empty").classList.toggle("hidden", docs.length > 0);
    for (const d of docs) {
      const item = document.createElement("div");
      item.className = "doc-item";
      const date = new Date(d.updated).toLocaleDateString(undefined,
        { day: "numeric", month: "short", year: "numeric" });
      item.innerHTML = `
        <img alt="">
        <div class="doc-info">
          <div class="doc-name"></div>
          <div class="doc-meta">${d.pages.length} page${d.pages.length === 1 ? "" : "s"} · ${date}</div>
        </div>
        <button class="icon-btn" title="Rename">
          <svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19l-4 1zM14 7l3 3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>
        </button>
        <button class="icon-btn danger" title="Delete">
          <svg viewBox="0 0 24 24"><path d="M6 7h12M9 7V5h6v2m-8 0l1 13h8l1-13" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>
        </button>`;
      item.querySelector(".doc-name").textContent = d.name;
      const thumb = d.pages[0]?.thumbUrl;
      if (thumb) item.querySelector("img").src = thumb;
      item.querySelector(".doc-info").addEventListener("click", () => openDoc(d.id));
      item.querySelector("img").addEventListener("click", () => openDoc(d.id));
      item.querySelector('[title="Rename"]').addEventListener("click", async () => {
        const name = prompt("Document name:", d.name);
        if (name?.trim()) {
          d.name = name.trim();
          if (doc?.id === d.id) doc.name = d.name;
          await DB.putDoc(d);
          renderLibrary();
        }
      });
      item.querySelector('[title="Delete"]').addEventListener("click", async () => {
        if (!confirm(`Delete "${d.name}"?`)) return;
        await DB.delDoc(d.id);
        if (doc?.id === d.id) {
          doc = null;
          pages.length = 0;
          await DB.kvDel("activeDocId").catch(() => {});
          updateBadge();
        }
        renderLibrary();
      });
      list.appendChild(item);
    }
  }

  async function openDoc(id) {
    const record = await DB.getDoc(id);
    if (!record) { toast("Document not found"); renderLibrary(); return; }
    loadDoc(record);
    showScreen("screen-pages");
  }

  $("#btn-library").addEventListener("click", () => showScreen("screen-library"));
  $("#pages-library").addEventListener("click", () => showScreen("screen-library"));
  $("#library-back").addEventListener("click", () => showScreen("screen-camera"));
  $("#btn-new-scan").addEventListener("click", async () => {
    await startNewDoc();
    showScreen("screen-camera");
  });

  // ---------- export ----------
  let exportFormat = "pdf";
  let exportPageSize = "fit";
  let exporting = false;

  // populate OCR language selector
  {
    const sel = $("#ocr-lang");
    for (const [code, label] of Exporter.OCR_LANGS) {
      const o = document.createElement("option");
      o.value = code;
      o.textContent = label + (code === "eng" ? "" : " (downloads on first use)");
      sel.appendChild(o);
    }
    sel.value = localStorage.getItem("ocrLang") || "eng";
    sel.addEventListener("change", () => localStorage.setItem("ocrLang", sel.value));
  }

  function syncExportOptions() {
    const f = exportFormat;
    const searchable = $("#chk-searchable").checked;
    $("#opt-pagesize").classList.toggle("hidden", f !== "pdf");
    $("#opt-quality").classList.toggle("hidden", f !== "pdf" && f !== "jpg");
    $("#opt-searchable").classList.toggle("hidden", f !== "pdf");
    $("#opt-lang").classList.toggle("hidden",
      !(f === "txt" || (f === "pdf" && searchable)));
  }

  function openSheet() {
    if (!pages.length) { toast("No pages to export"); return; }
    $("#export-name").value = (doc?.name || "scan").replace(/[\\/:*?"<>|]/g, "-");
    $("#sheet-backdrop").classList.remove("hidden");
    $("#sheet-export").classList.remove("hidden");
    $("#export-progress").classList.add("hidden");
    syncExportOptions();
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
    syncExportOptions();
    updateShareVisibility();
  });
  $("#pagesize-row").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    exportPageSize = chip.dataset.size;
    document.querySelectorAll("#pagesize-row .chip").forEach((c) =>
      c.classList.toggle("active", c === chip));
  });
  $("#chk-searchable").addEventListener("change", syncExportOptions);
  $("#quality-slider").addEventListener("input", () => {
    $("#quality-label").textContent = $("#quality-slider").value;
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

  async function buildExport() {
    const quality = (+$("#quality-slider").value) / 100;
    const lang = $("#ocr-lang").value;
    if (exportFormat === "pdf") {
      let ocr = null;
      if ($("#chk-searchable").checked) {
        setProgress(0, "Starting OCR (first run loads the language model)…");
        ocr = await Exporter.ocrPages(pages, lang,
          (f, l) => setProgress(f * 0.8, l));
      }
      const blob = await Exporter.toPDF(pages,
        { pageSize: exportPageSize, quality, ocr },
        (f, l) => setProgress(ocr ? 0.8 + f * 0.2 : f, l));
      return [blob];
    }
    if (exportFormat === "txt") {
      setProgress(0, "Starting OCR (first run loads the language model)…");
      return [await Exporter.toText(pages, lang, setProgress)];
    }
    return Exporter.toImages(pages, exportFormat, quality, setProgress);
  }

  async function runExport(deliver) {
    if (exporting || !pages.length) return;
    exporting = true;
    $("#btn-save").disabled = true;
    $("#btn-share").disabled = true;
    const name = ($("#export-name").value.trim() || "scan")
      .replace(/[\\/:*?"<>|]/g, "-");
    const info = FORMAT_INFO[exportFormat];
    try {
      const blobs = await buildExport();
      setProgress(1, "Done");
      await deliver(blobs, name, info);
      $("#sheet-backdrop").classList.add("hidden");
      $("#sheet-export").classList.add("hidden");
    } catch (err) {
      console.error(err);
      toast("Export failed: " + (err.message || err.name || "unknown error"), 4000);
    } finally {
      exporting = false;
      $("#btn-save").disabled = false;
      $("#btn-share").disabled = false;
    }
  }

  $("#btn-save").addEventListener("click", () =>
    runExport(async (blobs, name, info) => {
      if (blobs.length > 1) {
        setProgress(1, "Zipping…");
        Exporter.download(await Exporter.toZip(blobs, name, info.ext), `${name}.zip`);
        toast(`Saved ${name}.zip (${blobs.length} pages)`);
      } else {
        Exporter.download(blobs[0], `${name}.${info.ext}`);
        toast("Saved");
      }
    }));

  $("#btn-share").addEventListener("click", () =>
    runExport(async (blobs, name, info) => {
      let files;
      if (blobs.length > 1) {
        files = [new File([await Exporter.toZip(blobs, name, info.ext)],
          `${name}.zip`, { type: "application/zip" })];
      } else {
        files = Exporter.filesFor(blobs, name, info.ext, info.mime);
      }
      if (Exporter.canShareFiles(files)) await Exporter.share(files);
      else {
        for (const f of files) Exporter.download(f, f.name);
        toast("Sharing unsupported — saved instead");
      }
    }));

  // ---------- service worker + update banner ----------
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      const offerUpdate = () => {
        $("#update-bar").classList.remove("hidden");
        $("#btn-update").onclick = () => reg.waiting?.postMessage("SKIP_WAITING");
      };
      // an update may already be sitting in "waiting" from a previous visit
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate();
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        nw?.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) offerUpdate();
        });
      });
    }).catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }

  // ---------- lifecycle ----------
  document.addEventListener("visibilitychange", () => {
    const onCamera = $("#screen-camera").classList.contains("active");
    if (document.hidden) { persistNow(); stopCamera(); }
    else if (onCamera) startCamera();
  });
  window.addEventListener("pagehide", () => { persistNow(); });
  window.addEventListener("resize", () => { if (cropMode) layoutHandles(); });

  // ---------- boot ----------
  (async () => {
    syncToggles();

    // restore the document that was open last time
    try {
      const activeId = await DB.kvGet("activeDocId");
      if (activeId) {
        const record = await DB.getDoc(activeId);
        if (record) {
          loadDoc(record);
          toast(`Resumed "${record.name}"`);
        } else {
          await DB.kvDel("activeDocId").catch(() => {});
        }
      }
    } catch { /* fresh start */ }

    // files shared into the app via the Android share sheet
    if (new URLSearchParams(location.search).has("shared")) {
      history.replaceState(null, "", location.pathname);
      try {
        const files = await DB.takeIncoming();
        if (files.length) {
          await importFiles(files);
          return; // importFiles already navigated
        }
      } catch { /* nothing shared after all */ }
    }

    updateBadge();
    showScreen("screen-camera");
  })();
})();
