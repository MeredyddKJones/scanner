# Scanner

A CamScanner-style document scanner as a PWA — no ads, no account, everything
runs on your phone. Plain JS, no build step.

**Features**

- Live camera with automatic document edge detection (OpenCV.js)
- **Auto-capture**: hold steady over a document and it snaps by itself
- **Batch mode**: shoot page after page, review later
- Full-sensor stills via `ImageCapture.takePhoto()` (falls back to video frame)
- Perspective correction + fine deskew, manually adjustable corners with a
  magnifier loupe
- Filters: Original, Magic (shadow/cast removal + glare softening + sharpen),
  Grayscale, B&W
- Multi-page documents: drag to reorder, re-edit, delete
- **Library**: every scan autosaves to IndexedDB; documents survive restarts
  and can be reopened, renamed, re-exported
- Import photos from the gallery, or **share images into the app** from any
  other app (Android share sheet, once installed)
- Export: multi-page **PDF** (optionally **searchable** via an invisible OCR
  text layer; Fit/A4/Letter page sizes; quality slider), **JPG**, **PNG**
  (zipped when multi-page), or plain **OCR text**
- OCR languages: English bundled; Welsh, French, German, Spanish, Italian,
  Dutch, Portuguese, Polish download on first use and are cached offline
- Save to Downloads or use the Android **Share** sheet (Drive, WhatsApp, email…)
- Works fully offline once installed (service worker caches everything, ~30 MB)
- In-app "Update available" banner when a new version is deployed

## Getting it on your phone

The camera API requires HTTPS, so the app must be served from a secure URL.
The easiest free option is **GitHub Pages**:

1. Create a GitHub repository and push this folder to it.
2. Repo → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. Open `https://<you>.github.io/<repo>/` in Chrome on the phone.
4. Grant camera permission, then menu (⋮) → **Add to Home screen** → Install.

After that it opens full-screen like a normal app and works offline.

### Testing on this PC

```
py -m http.server 8000
```

then open <http://localhost:8000>. (`localhost` counts as a secure context, so
the camera works with a webcam; the gallery-import button works regardless.)

To test on the phone against the PC without deploying, use USB debugging:
`adb reverse tcp:8000 tcp:8000`, then open `http://localhost:8000` on the phone.

## Updating

The service worker caches aggressively. After changing any file, bump
`VERSION` in `sw.js` so installed phones pick up the update.

## Layout

```
index.html        app shell (camera / edit / pages / library screens, export sheet)
css/style.css
js/app.js         UI state, camera, auto-capture, crop handles, library, export flow
js/db.js          IndexedDB layer (documents, kv, share-target inbox) — also used by sw.js
js/detector.js    OpenCV: edge detection, perspective warp, deskew, filters
js/exporter.js    jsPDF (+searchable text layer), image/zip export, Tesseract OCR
sw.js             offline cache + Android share-target handler (bump VERSION on changes)
manifest.json     PWA manifest (incl. share_target)
vendor/           opencv.js, jspdf, fflate, tesseract.js + core wasm + eng traineddata
icons/            app icons (regenerate with gen_icons.py)
```
