"""Read a Gemini 'enlarged sprite' back into its pixel grid, snapped to the mascot palette."""
import sys, json, re
import numpy as np
from PIL import Image

PAL = [tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
       for h in json.loads(re.search(r"PALETTE = (\[.*?\]);", open("../luciole-data.js").read()).group(1))]
PAL += [(11, 10, 7), (198, 232, 90), (242, 255, 216), (99, 128, 52), (60, 80, 36)]  # night + glow ramp for halos
PAL = np.array(PAL, float)


def fit(im, axis, n):
    """Best period near size/n and its phase, from edge energy."""
    d = np.abs(np.diff(im, axis=axis)).sum(axis=2).sum(axis=0 if axis == 1 else 1)
    size = im.shape[1 - axis if axis == 0 else 1] if False else (im.shape[1] if axis == 1 else im.shape[0])
    pos = np.arange(len(d)) + 1.0
    guess = size / n
    best = max(((abs(z), p, z) for p in np.arange(guess * 0.8, guess * 1.2, 0.01)
                for z in [(d * np.exp(2j * np.pi * pos / p)).sum()]), key=lambda v: v[0])
    _, p, z = best
    off = (np.angle(z) / (2 * np.pi) * p) % p
    return p, off


def regrid(path, w, h):
    im = np.asarray(Image.open(path).convert("RGB")).astype(float)
    (px, ox), (py, oy) = fit(im, 1, w), fit(im, 0, h)
    nx, ny = int((im.shape[1] - ox) // px), int((im.shape[0] - oy) // py)
    out = np.zeros((ny, nx, 3), np.uint8)
    for y in range(ny):
        for x in range(nx):
            cx, cy = ox + (x + .5) * px, oy + (y + .5) * py
            blk = im[int(cy - px * .25):int(cy + px * .25), int(cx - px * .25):int(cx + px * .25)].reshape(-1, 3)
            c = np.median(blk, 0)
            out[y, x] = PAL[np.argmin(((PAL - c) ** 2).sum(1))]
    # crop to content (+1 px margin)
    fg = np.abs(out.astype(int) - [11, 10, 7]).sum(-1) > 20
    ys, xs = np.where(fg)
    out = out[max(ys.min() - 1, 0):ys.max() + 2, max(xs.min() - 1, 0):xs.max() + 2]
    return out, (px, py)


if __name__ == "__main__":
    for path in sys.argv[1:]:
        out, (px, py) = regrid(path, 22, 31)
        Image.fromarray(out).save(path.replace(".png", "-1x.png"))
        print(path, f"cell {px:.1f}x{py:.1f} ->", out.shape[1], "x", out.shape[0])
