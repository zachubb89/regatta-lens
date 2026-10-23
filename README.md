# Regatta Lens

AR move helper for **Regatta**, a sailing board game. Point a phone at the table and it draws every legal move for your boat: how far each Sail card takes you, tacks and roll tacks, wind shadows (Dirty Air), starboard right of way, laylines to the finish, turn order, and which tack the wind shift favors.

**Live site:** https://zachubb89.github.io/regatta-lens/

## How it works

Each piece wears a 15 mm sticker: a 12.5 mm black-and-white ArUco code (ids 0–23 of the 4×4 family) with a 1.25 mm white edge. The app finds them in the camera image at full resolution, refines every edge to a fraction of a pixel, solves the table plane from all the stickers it sees, then runs the game rules on the boats' positions and headings.

| Marker | Goes on | Top edge points |
| --- | --- | --- |
| 0 | Wind dial, rotating arrow hub | Upwind |
| 1 | Wind dial, fixed base | Toward the finish |
| 10–14 | Boats: Blue, Navy, Green, Dark Blue, Purple | Bow |
| 20, 21 | Finish marks A, B | Upwind |
| 22, 23 | Start marks C, C | Upwind |

Print `regatta-markers.pdf` at 100% on matte paper (two of each sticker per sheet). If you print or UV-print other sizes, set the code size (black square only) in the app's Settings, and keep at least 1 mm of white around it.

### Reading range for 15 mm stickers

The reader needs about 1.2–1.5 camera pixels per millimetre of table.

| Camera | Reads stickers across | Roughly from |
| --- | --- | --- |
| Phone photo (12 MP) | ~2 m of table | anywhere above a normal table |
| Live video (1080p) | ~70–80 cm of table | phone held ≤ 80 cm over it |

Measured on rendered test shots (`npm run test:size`): 98% read at 1.1 px/mm, 100% from 1.3 px/mm, headings within ~1° (95th percentile) even at the edge of range, sticker size within ±0.8% across dark and light meeples and lens blur. A 12 MP photo places nearby pieces within ~1 mm; a 3 MP shot within ~3–4 mm.

## Modes

- **Photo**: snap the table, tap a boat. Works everywhere, including inside Claude.
- **Live**: camera feed with the overlay on top, read at full 1080p in a background worker (a few updates a second). Needs this hosted page (phones only allow the camera on a real HTTPS site).
- **Sandbox**: no markers. Drag boats, play turns, roll 3D4 for the wind.

## Editing

`index.html` is built. Edit the files in `src/`, then rebuild:

```
npm install
npm run build   # writes index.html (this site) and dist/regatta-lens.html (Claude artifact version)
npm test        # renders a 3 MP and a 12 MP table photo and checks detection, geometry and rules
npm run test:size   # reading rate and accuracy for 15 mm stickers across camera resolutions
```

- `src/reader.js`: the small-sticker reader (candidate squares from js-aruco, sub-pixel edges, bit reading, tiling for big photos)
- `src/engine.js`: geometry and the rules (moves, dirty air, right of way, turn order, laylines)
- `src/app.js`, `src/app.css`, `src/app.html`: the interface
- `tools/gen_markers.py`: makes `regatta-markers.pdf` (needs Python with OpenCV and reportlab)
- `tools/gen_scene.py`: renders the sample table photo (true pinhole camera) used for the demo and tests
- `tools/size_sweep.py`, `tools/size_test.js`: the reading-range test

Push to `main` and GitHub Pages republishes in about a minute.

## Assumptions to check against the rules

- Cards are poker size, 63.5 × 88.9 mm. One Sail card moves one card width.
- Close-hauled is 45° off the wind; one dial tick is 20°.
- A wind shadow is one card-sized box straight downwind. A starboard boat controls one card length ahead.
- A roll tack moves one card.

All of these are editable in Settings.
