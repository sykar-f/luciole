"""One-time bootstrap: AI image -> editable 1x master layers in master/.

After this, master/*.png are the source of truth (edit them in Aseprite) and
`node build.mjs` turns them into luciole-data.js. Re-running this script
overwrites the masters, so only do it to start over from the AI image.

Outputs (all W x H, 1 image pixel = 1 sprite pixel):
  master/color.png    RGBA colours, transparent background
  master/classes.png  one flat colour per role (see CLASS_COLOURS)
  master/light.png    greyscale: how much lantern light each pixel receives
                      (0 = none/occluded ... 255 = full), 4 levels
"""
from collections import Counter, deque
import os
import numpy as np
from PIL import Image

SRC = "source/hug-lantern.png"   # the chosen AI image, really a JPEG, hence the median sampling and cleanup
NIGHT = np.array([12, 11, 5])
CLASS_COLOURS = {  # keep in sync with build.mjs
    "body": (128, 128, 128), "lantern": (198, 232, 90), "tip": (255, 160, 0),
    "eye": (48, 112, 255), "antenna": (255, 64, 160),
}
im = np.asarray(Image.open(SRC).convert("RGB")).astype(float)
S = im.shape[0]


def fit_grid(axis):
    """Pixel period and phase from the edge energy's dominant frequency."""
    d = np.abs(np.diff(im, axis=axis)).sum(axis=2).sum(axis=0 if axis == 1 else 1)
    pos = np.arange(len(d)) + 1.0  # an edge between i and i+1 sits at i+1
    best = max(((abs(z), p, z) for p in np.arange(8.0, 14.0, 0.002)
                for z in [(d * np.exp(2j * np.pi * pos / p)).sum()]), key=lambda v: v[0])
    _, p, z = best
    off = (np.angle(z) / (2 * np.pi) * p) % p
    return p, off - p if off > p / 2 else off  # grid lines at offset + k*p, offset near 0


(px, ox), (py, oy) = fit_grid(1), fit_grid(0)
NX, NY = int(round(S / px)), int(round(S / py))
print(f"grid {px:.3f}x{py:.3f} px, offset {ox:.2f},{oy:.2f} -> {NX}x{NY}")

# 1. Sample each logical pixel with the median of its inner area (JPEG edges bleed).
grid = np.zeros((NY, NX, 3))
for y in range(NY):
    for x in range(NX):
        cx, cy = ox + (x + .5) * px, oy + (y + .5) * py
        blk = im[max(int(cy - 3), 0):int(cy + 3), max(int(cx - 3), 0):int(cx + 3)].reshape(-1, 3)
        grid[y, x] = np.median(blk, axis=0) if len(blk) else NIGHT

# 2. Background = night-coloured region connected to the border (the navy outline stays).
near = np.abs(grid - NIGHT).sum(-1) < 16
isbg = np.zeros((NY, NX), bool)
q = deque((y, x) for y in range(NY) for x in range(NX) if (y in (0, NY - 1) or x in (0, NX - 1)) and near[y, x])
for p in q: isbg[p] = True
while q:
    y, x = q.popleft()
    for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
        if 0 <= ny < NY and 0 <= nx < NX and near[ny, nx] and not isbg[ny, nx]:
            isbg[ny, nx] = True; q.append((ny, nx))
# Closed pockets of night colour inside the sprite are background too.
isbg |= near & (np.abs(grid - NIGHT).sum(-1) < 8)

# 3. Palette: farthest-point init + k-means on sprite pixels, then merge near-duplicates.
fg = grid[~isbg]
C = [fg[0]]
while len(C) < 40:
    C.append(fg[np.argmax(np.min([((fg - c) ** 2).sum(1) for c in C], 0))])
C = np.array(C)
for _ in range(40):
    lab = np.argmin(((fg[:, None] - C[None]) ** 2).sum(-1), 1)
    C = np.array([fg[lab == k].mean(0) if (lab == k).any() else C[k] for k in range(len(C))])
merged = True
while merged:  # JPEG noise produces near-identical clusters; fold them together
    merged = False
    for i in range(len(C)):
        for j in range(i + 1, len(C)):
            if np.abs(C[i] - C[j]).sum() < 24:
                C = np.delete(C, j, 0); merged = True; break
        if merged: break
lab = np.full((NY, NX), -1)
lab[~isbg] = np.argmin(((grid[~isbg][:, None] - C[None]) ** 2).sum(-1), 1)

# 4. Despeckle: a lone pixel whose 4 neighbours agree on one close colour takes it.
for _ in range(2):
    out = lab.copy()
    for y in range(1, NY - 1):
        for x in range(1, NX - 1):
            if lab[y, x] < 0: continue
            nb = [lab[y - 1, x], lab[y + 1, x], lab[y, x - 1], lab[y, x + 1]]
            k, n = Counter(nb).most_common(1)[0]
            if k >= 0 and k != lab[y, x] and n >= 3 and nb.count(lab[y, x]) == 0 \
                    and np.abs(C[k] - C[lab[y, x]]).sum() < 90:
                out[y, x] = k
    lab = out
C = C.round().astype(int)
rgb = np.where(lab[..., None] >= 0, C[np.maximum(lab, 0)], 0)

# 5. Crop with no margin (the renderer pads for halo and float).
ys, xs = np.where(lab >= 0)
lab, rgb, isbg = (a[ys.min():ys.max() + 1, xs.min():xs.max() + 1] for a in (lab, rgb, isbg))
H, W = lab.shape
r, g, b = (rgb[..., i].astype(int) for i in range(3))
lum = r + g + b
opaque = lab >= 0


def components(mask):
    seen, out = np.zeros_like(mask), []
    for sy, sx in zip(*np.where(mask)):
        if seen[sy, sx]: continue
        comp, q = [], deque([(sy, sx)]); seen[sy, sx] = True
        while q:
            y, x = q.popleft(); comp.append((y, x))
            for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True; q.append((ny, nx))
        out.append(comp)
    return sorted(out, key=len, reverse=True)


# 6. Lantern: flood from the brightest lower pixel through light greens, inside a disc.
low = np.zeros((H, W), bool); low[H // 2:] = True
sy, sx = np.unravel_index(np.argmax(np.where(low & opaque, lum, 0)), (H, W))
ok = (g > r + 5) & (g > b + 12) & (lum > 80)
lantern = np.zeros((H, W), bool); lantern[sy, sx] = True
q = deque([(sy, sx)])
while q:
    y, x = q.popleft()
    for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
        if 0 <= ny < H and 0 <= nx < W and not lantern[ny, nx] and (ok[ny, nx] or lum[ny, nx] > 600) \
                and (ny - sy) ** 2 + (nx - sx) ** 2 < 24 ** 2 and ny > sy - 18:
            lantern[ny, nx] = True; q.append((ny, nx))

# 7. Antenna tips: greenish blobs in the top third, each one separately.
greenish = (g > r + 25) & (g > b + 40) & ~lantern
tipmask = np.zeros((H, W), bool)
for comp in components(greenish):
    if len(comp) >= 6 and np.mean([p[0] for p in comp]) < H * 0.3:
        for p in comp: tipmask[p] = True
# Antenna stalks: sprite pixels above the first wide row (the head).
runs = [max((len(s) for s in "".join("1" if v else "0" for v in opaque[y]).split("0")), default=0) for y in range(H)]
head_top = next(y for y in range(H) if runs[y] >= 12 and not tipmask[y].any())
antenna = opaque & ~tipmask & (np.arange(H)[:, None] < head_top)

# 8. Eyes: the two biggest enclosed dark blobs in the face band (the mouth sits lower).
face = opaque & ~lantern & ~tipmask & ~antenna
dark = face & (lum < 330)
eyes = np.zeros((H, W), bool)
cands = [c for c in components(dark) if 12 <= len(c) <= 200
         and all(0 < p[0] < H - 1 and 0 < p[1] < W - 1 for p in c)]
band = [c for c in cands if np.mean([p[0] for p in c]) < head_top + (sy - head_top) * 0.55]
band = sorted(band, key=len, reverse=True)[:2]
for comp in band:
    ys_, xs_ = zip(*comp)  # include the highlights inside the eye's bounding box
    for y in range(min(ys_) - 1, max(ys_) + 2):  # 1 px margin catches the highlight's edge
        for x in range(min(xs_) - 1, max(xs_) + 2):
            if face[y, x] and (lum[y, x] < 600 or lum[y, x] > 690): eyes[y, x] = True
print(f"eyes: {[len(c) for c in band]} px, head top y={head_top}")

# 9. Light received from the lantern: distance to its real edge, occluded by opaque
#    non-lantern pixels on the way (arms, outline), quantized to 4 levels.
edge = [(y, x) for y, x in zip(*np.where(lantern))
        if any(not (0 <= y + dy < H and 0 <= x + dx < W) or not lantern[y + dy, x + dx]
               for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)))]
light = np.zeros((H, W))
cy_, cx_ = np.mean(np.where(lantern), axis=1)
for y, x in zip(*np.where(opaque & ~lantern & ~tipmask)):
    ey, ex = min(edge, key=lambda p: (p[0] - y) ** 2 + (p[1] - x) ** 2)
    d = np.hypot(ey - y, ex - x)
    if d > 12: continue
    # march towards the lantern centre; count blocking pixels between us and the edge
    n = int(max(abs(cy_ - y), abs(cx_ - x)))
    blocked = 0
    for i in range(1, n):
        yy, xx = int(round(y + (cy_ - y) * i / n)), int(round(x + (cx_ - x) * i / n))
        if lantern[yy, xx]: break
        if opaque[yy, xx] and lum[yy, xx] < 200: blocked += 1  # dark outline/arm shadow
    vis = 1.0 if blocked <= 1 else 0.4 if blocked <= 2 else 0.0
    light[y, x] = vis * max(0.0, 1 - d / 12)
light = np.round(light * 3) / 3
light[lum < 90] *= 0.34  # outlines catch only a hint of light

# 10. Albedo: remove the green light baked into the AI image (chin, arm edges) by
#     taking the nearest non-green colour above it in the same role.
baked = opaque & ~lantern & ~tipmask & (g > r + 20) & (g > b + 30)
alb = rgb.copy()
for y, x in zip(*np.where(baked)):
    for d in range(1, 8):
        found = [(yy, xx) for yy, xx in ((y - d, x), (y - d, x - 1), (y - d, x + 1), (y, x - d), (y, x + d))
                 if 0 <= yy < H and 0 <= xx < W and opaque[yy, xx] and not baked[yy, xx]
                 and not lantern[yy, xx] and not tipmask[yy, xx] and abs(int(lum[yy, xx]) - int(lum[y, x])) < 260]
        if found: alb[y, x] = rgb[found[0]]; break
    light[y, x] = 1.0  # the AI painted full lantern light here

# 11. Write the masters.
os.makedirs("master", exist_ok=True)
rgba = np.zeros((H, W, 4), np.uint8)
rgba[..., :3] = alb; rgba[..., 3] = np.where(opaque, 255, 0)
Image.fromarray(rgba, "RGBA").save("master/color.png")
cls = np.zeros((H, W, 4), np.uint8)
for mask, name in ((opaque, "body"), (lantern, "lantern"), (tipmask, "tip"), (antenna, "antenna"), (eyes, "eye")):
    cls[mask, :3] = CLASS_COLOURS[name]; cls[mask, 3] = 255
Image.fromarray(cls, "RGBA").save("master/classes.png")
Image.fromarray((light * 255).round().astype(np.uint8), "L").save("master/light.png")
prev = np.concatenate([rgba[..., :3], cls[..., :3], np.repeat((light * 255).astype(np.uint8)[..., None], 3, -1)], 1)
Image.fromarray(prev).resize((prev.shape[1] * 5, H * 5), Image.NEAREST).save("master/preview.png")
print(f"{W}x{H}, {len({tuple(c) for c in alb[opaque]})} colours, lantern {lantern.sum()} px, "
      f"tips {tipmask.sum()} px, antenna {antenna.sum()} px, eyes {eyes.sum()} px, lit {(light > 0).sum()} px")
