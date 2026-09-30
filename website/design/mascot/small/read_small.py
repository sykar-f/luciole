"""clean/2.png (Gemini's cleanup on a ~30 px grid) -> small-1x.png, RGBA with a transparent background."""
from collections import deque
import numpy as np
from PIL import Image
import regrid

im = np.asarray(Image.open("clean/2.png").convert("RGB")).astype(float)
(px, ox), (py, oy) = regrid.fit(im, 1, 25), regrid.fit(im, 0, 35)
nx, ny = int(round((im.shape[1] - ox) / px)), int(round((im.shape[0] - oy) / py))
cells = np.zeros((ny, nx, 3))
for y in range(ny):
    for x in range(nx):
        cx, cy = ox + (x + .5) * px, oy + (y + .5) * py
        blk = im[max(int(cy - 6), 0):int(cy + 6), max(int(cx - 6), 0):int(cx + 6)].reshape(-1, 3)
        cells[y, x] = np.median(blk, 0) if len(blk) else [11, 10, 7]
# Merge only near-identical colours; dark tones need a tighter threshold (outline vs night).
flat = cells.reshape(-1, 3)
groups = []
for c in flat:
    lim = 10 if c.sum() < 120 else 30
    for g in groups:
        if np.abs(g[0] - c).sum() < lim: g[1].append(c); break
    else: groups.append([c, [c]])
centers = np.array([np.mean(g[1], 0) for g in groups])
lab = np.argmin(((flat[:, None] - centers[None]) ** 2).sum(-1), 1)
rgb = centers[lab].reshape(ny, nx, 3).round().astype(int)
# Background: night-coloured cells connected to the border.
night = np.abs(rgb - [11, 10, 7]).sum(-1) < 12
bg = np.zeros_like(night); q = deque((y, x) for y in range(ny) for x in range(nx) if (y in (0, ny - 1) or x in (0, nx - 1)) and night[y, x])
for p in q: bg[p] = True
while q:
    y, x = q.popleft()
    for n in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
        if 0 <= n[0] < ny and 0 <= n[1] < nx and night[n] and not bg[n]: bg[n] = True; q.append(n)
ys, xs = np.where(~bg)
y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
out = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
out[..., :3] = rgb[y0:y1, x0:x1]; out[..., 3] = np.where(bg[y0:y1, x0:x1], 0, 255)
Image.fromarray(out, "RGBA").save("small-1x.png")
A = ".abcdefghijklmnopqrstuvwxyz0123456789"
keys = {}
for y in range(out.shape[0]):
    row = ""
    for x in range(out.shape[1]):
        if out[y, x, 3] == 0: row += "."; continue
        c = tuple(out[y, x, :3]); keys.setdefault(c, A[len(keys) + 1]); row += keys[c]
    print(f"{y:2d} {row}")
for c, k in keys.items(): print(k, "#%02x%02x%02x" % c, end="  ")
print("\n", out.shape[1], "x", out.shape[0])
