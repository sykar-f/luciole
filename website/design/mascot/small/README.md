# The small mascot

A separate drawing for small sizes (terminal output, avatars of 32 px and less), because
automatic reductions of the 66x93 master lose the eyes and the outline.

- `gen/`: first Gemini attempts at a tiny sprite (it ignored the size: not used).
- `auto-1x.png`: the automatic 1/3 reduction, given to Gemini as the grid to repair.
- `clean/`: Gemini's pixel-artist repairs on that grid; `clean/2.png` was kept.
- `read_small.py`: reads clean/2.png back into its ~30 px grid -> `small-1x.png` (transparent background, outlines kept).
- `finalize.py`: hand fixes (cream antenna stalks) + a short two-ring glow -> `small-final.png` and `../luciole-small.js`.

To change it: edit `small-1x.png` (1 px = 1 sprite pixel) and run `python3 finalize.py`.
