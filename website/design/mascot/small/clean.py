"""Ask Gemini to clean the 22x31 reduction at its exact resolution (pixel-artist pass)."""
import base64, json, os, urllib.request, concurrent.futures as cf
KEY = os.environ["GEMINI_API_KEY"]; MODEL = "gemini-3-pro-image-preview"
auto = base64.b64encode(open("auto-x32.png", "rb").read()).decode()
big = base64.b64encode(open("ref-still.png", "rb").read()).decode()
PROMPT = ("Image 1 is a 22 x 31 pixel sprite shown enlarged (each sprite pixel is a 32x32 block). It is an automatic reduction of the "
 "character in image 2 (a chibi pixel-art firefly hugging its glowing lantern) and it lost quality. Act as a professional pixel artist and "
 "REPAIR it AT THE SAME RESOLUTION: output exactly the same 22 x 31 grid, each pixel a perfectly uniform square block, same enlargement, "
 "same position of the character, same background #0b0a07. Fix: two clear symmetrical eyes (each a dark 2x2 or 2x3 shape with one white "
 "highlight pixel), a small readable open smile with one pink pixel, a clean 1-pixel dark outline around head, wings and lantern, a clean "
 "dark shield head plate with a thin amber edge, two thin 1-pixel antennae with round bright yellow-green tips, cream hands on the lantern, "
 "a round lantern with concentric green rings and a bright 1-2 pixel pale core. Keep the palette of image 2. No anti-aliasing, no noise, "
 "no grid lines, no text. {extra}")
EXTRA = ["", "Favour readability over detail: simplify the wings to one dark shape each.", "Keep it cute: slightly bigger eyes."]
def gen(i):
    body = {"contents": [{"parts": [{"inlineData": {"mimeType": "image/png", "data": auto}}, {"inlineData": {"mimeType": "image/png", "data": big}},
                                    {"text": PROMPT.format(extra=EXTRA[i % 3])}]}],
            "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "3:4"}}}
    req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={KEY}",
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=300))
    for p in r["candidates"][0]["content"]["parts"]:
        if "inlineData" in p:
            open(f"clean/{i}.png", "wb").write(base64.b64decode(p["inlineData"]["data"])); return f"{i} ok"
    return f"{i} NO IMAGE"
with cf.ThreadPoolExecutor(6) as ex:
    for res in ex.map(gen, range(6)): print(res, flush=True)
