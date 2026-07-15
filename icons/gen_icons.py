"""Generate PWA icons: a document with a scan line on a dark rounded tile."""
from PIL import Image, ImageDraw


def make(size, maskable=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size

    # background tile
    radius = 0 if maskable else int(s * 0.22)
    d.rounded_rectangle([0, 0, s, s], radius=radius, fill=(16, 20, 24, 255))

    # content scale: maskable icons need a wider safe margin
    m = 0.30 if maskable else 0.22          # margin around the document
    doc_l, doc_r = s * m, s * (1 - m)
    doc_t, doc_b = s * (m - 0.02), s * (1 - m + 0.02)

    # document sheet
    d.rounded_rectangle([doc_l, doc_t, doc_r, doc_b], radius=int(s * 0.03),
                        fill=(232, 237, 242, 255))

    # text lines
    line_w = int(s * 0.035)
    for i, frac in enumerate([0.30, 0.42, 0.54, 0.66]):
        y = doc_t + (doc_b - doc_t) * frac
        x2 = doc_r - s * 0.06 if i != 1 else doc_r - s * 0.16
        d.line([doc_l + s * 0.06, y, x2, y], fill=(138, 151, 164, 255), width=line_w)

    # accent scan line across the middle
    y = (doc_t + doc_b) / 2 - s * 0.01
    glow_h = int(s * 0.10)
    d.rectangle([doc_l - s * 0.05, y - glow_h / 2, doc_r + s * 0.05, y + glow_h / 2],
                fill=(51, 181, 160, 70))
    d.rectangle([doc_l - s * 0.05, y - line_w / 2, doc_r + s * 0.05, y + line_w / 2],
                fill=(51, 181, 160, 255))

    return img


make(192).save("icon-192.png")
make(512).save("icon-512.png")
make(512, maskable=True).save("icon-maskable-512.png")
print("icons written")
