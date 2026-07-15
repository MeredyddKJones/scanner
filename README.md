# Scanner

A CamScanner-style document scanner as a PWA — no ads, no account, everything
runs on your phone. Plain JS, no build step.

**Features**

- Live camera with automatic document edge detection (OpenCV.js)
- Perspective correction with manually adjustable corners
- Filters: Original, Magic (shadow/cast removal), Grayscale, B&W
- Multi-page documents: reorder, re-edit, delete
- Import photos from the gallery instead of the camera
- Export: multi-page **PDF**, **JPG**, **PNG**, or **OCR text** (Tesseract.js, English)
- Save to Downloads or use the Android **Share** sheet (Drive, WhatsApp, email…)
- Works fully offline once installed (service worker caches everything, ~30 MB)

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
index.html        app shell (camera / edit / pages screens, export sheet)
css/style.css
js/app.js         UI state, camera, crop handles, export flow
js/detector.js    OpenCV: edge detection, perspective warp, filters
js/exporter.js    jsPDF, image export, Tesseract OCR, share/download
sw.js             offline cache (bump VERSION on changes)
manifest.json     PWA manifest
vendor/           opencv.js, jspdf, tesseract.js + core wasm + eng traineddata
icons/            app icons (regenerate with gen_icons.py)
```
