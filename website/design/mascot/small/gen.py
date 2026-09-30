"""Ask Gemini for a tiny hand-drawn-quality version of the mascot (terminal / small avatars)."""
import base64, json, os, urllib.request, concurrent.futures as cf
KEY = os.environ["GEMINI_API_KEY"]; MODEL = "gemini-3-pro-image-preview"
ref = base64.b64encode(open("small/ref-still.png", "rb").read()).decode()
BASE = ("The attached image is a pixel-art mascot: a chibi firefly hugging its glowing lantern. "
 "Redraw THE SAME character as a TINY pixel-art sprite, like a hand-made 16-bit game icon, designed pixel by pixel for its size "
 "(not a downscale): keep what makes it recognisable — dark shield-shaped head plate with an amber edge, cream face, two big dark eyes "
 "each with ONE white highlight pixel, small open smile with a pink pixel, two thin cream antennae with bright yellow-green tips, "
 "small dark wing cases on the sides, little cream hands on the big glowing yellow-green lantern with a bright pale square core. "
 "Around the lantern and the antenna tips: one ring of dim green glow pixels. Use strong 1-pixel dark outlines so shapes stay readable. "
 "STRICT FORMAT: exactly {w} pixels wide and {h} pixels tall; every sprite pixel is drawn as a perfectly uniform square block of the same size, "
 "aligned on a regular grid, no anti-aliasing, no blur, no gradients inside a pixel, no dithering noise, no grid lines. "
 "Plain flat #0b0a07 background everywhere else. Character centred, filling the grid. No text.")
JOBS = [(w, h, i) for (w, h) in ((20, 28), (24, 32)) for i in (1, 2, 3)]
def gen(job):
    w, h, i = job
    body = {"contents": [{"parts": [{"inlineData": {"mimeType": "image/png", "data": ref}}, {"text": BASE.format(w=w, h=h)}]}],
            "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "3:4"}}}
    req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={KEY}",
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=300))
    for p in r["candidates"][0]["content"]["parts"]:
        if "inlineData" in p:
            open(f"small/gen/{w}x{h}-{i}.png", "wb").write(base64.b64decode(p["inlineData"]["data"])); return f"{w}x{h}-{i} ok"
    return f"{w}x{h}-{i} NO IMAGE"
with cf.ThreadPoolExecutor(6) as ex:
    for res in ex.map(gen, JOBS): print(res, flush=True)
