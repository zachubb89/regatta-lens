# Regatta Lens

AR move helper for **Regatta**, a sailing board game. Point a phone at the table and it draws every legal move for your boat: how far each Sail card takes you, tacks and roll tacks, wind shadows (Dirty Air), starboard right of way, laylines to the finish, turn order, and which tack the wind shift favors.

**Live site:** https://zachubb89.github.io/regatta-lens/

## How it works

Each piece wears a small black-and-white ArUco marker (ids 0–23 of the 4×4 family). The app finds them in the camera image, solves the table plane from every marker it sees, then runs the game rules on the boats' positions and headings.

| Marker | Goes on | Top edge points |
| --- | --- | --- |
| 0 | Wind dial, rotating arrow hub | Upwind |
| 1 | Wind dial, fixed base | Toward the finish |
| 10–14 | Boats: Blue, Navy, Green, Dark Blue, Purple | Bow |
| 20, 21 | Finish marks A, B | Upwind |
| 22, 23 | Start marks C, C | Upwind |

Print `regatta-markers.pdf` at 100% on matte paper. Default sizes: wind and course 40 mm, boats 20 mm, marks 25 mm (change them in the app's Settings if you print other sizes).

## Modes

- **Photo**: snap the table, tap a boat. Works everywhere, including inside Claude.
- **Live**: camera feed with the overlay on top. Needs this hosted page (phones only allow the camera on a real HTTPS site).
- **Sandbox**: no markers. Drag boats, play turns, roll 3D4 for the wind.

## Editing

`index.html` is built. Edit the files in `src/`, then rebuild:

```
npm install
npm run build   # writes index.html (this site) and dist/regatta-lens.html (Claude artifact version)
npm test        # renders a synthetic table photo and checks detection + rules
```

- `src/engine.js`: geometry and the rules (moves, dirty air, right of way, turn order, laylines)
- `src/app.js`, `src/app.css`, `src/app.html`: the interface
- `tools/gen_markers.py`: makes `regatta-markers.pdf` (needs Python with OpenCV and reportlab)
- `tools/gen_scene.py`: renders the sample table photo used for the demo and tests

Push to `main` and GitHub Pages republishes in about a minute.

## Assumptions to check against the rules

- Cards are poker size, 63.5 × 88.9 mm. One Sail card moves one card width.
- Close-hauled is 45° off the wind; one dial tick is 20°.
- A wind shadow is one card-sized box straight downwind. A starboard boat controls one card length ahead.
- A roll tack moves one card.

All of these are editable in Settings.
