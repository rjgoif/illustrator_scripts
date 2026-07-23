# illustrator_scripts
some useful scripts for use in Adobe Illustrator


# vessel_taper.jsx

An Adobe Illustrator (ExtendScript) tool that turns simple centerline paths into anatomically-tapered, smoothly-branching vessel illustrations — the kind of vascular tree diagram you'd see in an anatomy textbook — with automatic diameter tapering, junction smoothing, and optional soft directional highlights.

You draw the "skeleton" (single-line centerlines with a couple of diameters tagged by name); the script does the rest: computing every other branch's diameter, building the tapered outlines, merging them into one clean shape, and rounding the sharp notches where vessels meet.

## What it does

1. **Diameter tapering from just a couple of numbers.** Tag your terminal (leaf) branches and your trunk with a diameter each. Every other branch's diameter is computed automatically using [Murray's Law](https://en.wikipedia.org/wiki/Murray%27s_law) (`r_parent³ = Σ r_daughter³`), the standard model for how vessel diameters relate at a bifurcation, balancing flow resistance against the metabolic cost of blood volume (Murray CD, *PNAS*, 1926).
2. **Continuous taper**, interpolated smoothly by arc length along each segment — no stepped/blocky diameter changes.
3. **Draw the trunk as one continuous path.** Branches don't need to land on an existing anchor point — the script detects where a branch's endpoint touches the trunk's *curve* (even mid-curve) and splits it there automatically, using proper Bezier subdivision so the trunk's shape isn't distorted.
4. **Junction smoothing.** After tapering and merging every vessel into one shape, the script detects the sharp notches left where vessels cross and rounds them with a tangent-arc fillet — the same geometry Illustrator's own Round Corners / Live Corner widget uses. Fillets are added as **separate patch shapes** on top of the base outline, so you can review, delete, or merge each one individually rather than being stuck with whatever the algorithm produced.
5. **Directional highlights for a simple 3D "tube" look.** A single highlight band per vessel tree, merged into one continuous shape and clipped so it can't bleed past the vessel's own edge, then left **pre-selected** when the script finishes so you can apply Illustrator's own Gaussian Blur to all of them in one action. (Scripted/automatic blur via `applyEffect` proved unreliable across Illustrator versions — see [Known limitations](#known-limitations) — so this last step is a deliberate one-click manual finish rather than a silent no-op.) Highlights live on their own layer for easy toggling/deletion.
6. **Cleanup pass** for the small sliver artifacts Illustrator's own Pathfinder boolean operations are known to leave behind at intersections.

<img width="950" height="478" alt="image" src="https://github.com/user-attachments/assets/2de8ec0c-7b06-45cc-8371-f5f93afe51b2" />

## Requirements

- Adobe Illustrator with ExtendScript support (developed/tested against Illustrator 23 / CC 2019; should work on most modern versions since it only uses long-standing DOM APIs).

## Installation

**Run once, no install:**
`File > Scripts > Other Script...` → select `vessel_taper.jsx`.

**Install permanently** (adds it to the Scripts menu):
Copy `vessel_taper.jsx` into Illustrator's Scripts folder, then restart Illustrator.

- Windows: `C:\Program Files\Adobe\Adobe Illustrator [version]\Presets\en_US\Scripts\`
- Mac: `/Applications/Adobe Illustrator [version]/Presets.localized/en_US/Scripts/`

## How to use it

### 1. Draw your centerlines

Draw plain open paths for each vessel. A trunk can be a single continuous path — branches just need to visually touch it somewhere along its length; you don't need to pre-split anything or snap to an existing anchor point.

### 2. Name your paths

Double-click a path's row in the **Layers panel** to rename it (select the path on canvas first to jump to its row).

| Path | Name it | Example |
| --- | --- | --- |
| Terminal/leaf branch | a plain number (diameter at its free end) | `6` |
| Root/trunk | starts with `root` (diameter at its free end) | `root40` |
| Everything else | leave unnamed — computed automatically | *(blank)* |

Every truly dangling endpoint in your selection must be tagged this way, and exactly one path must be tagged as root. If you leave something untagged, the script tells you exactly which named path the loose end belongs to.

### 3. Select and run

Select **all** centerline paths belonging to one connected tree (no loops), then run the script. It will:

- Split the trunk wherever a branch actually touches it
- Compute every un-tagged diameter via Murray's Law
- Build and merge the tapered vessel shapes
- Add rounded fillet patches at sharp junctions
- Build the highlight layer and leave the highlight shapes selected (see below)
- Hide (not delete) your original centerlines

### 4. Finish the highlights (one manual step)

If `DO_ADD_HIGHLIGHTS` is on, the script leaves every highlight shape **already selected** when it finishes. Apply Illustrator's own blur to all of them at once:

`Effect > Blur > Gaussian Blur...` → enter a radius (the value of `HIGHLIGHT_BLUR_RADIUS`, default **4pt**, is shown again in the script's final summary dialog as a reminder) → OK.

This is a deliberate manual step, not an oversight — see [Known limitations](#known-limitations).

## Configuration

All settings are constants near the top of the script (inside the `CONFIG` block):

| Variable | Default | Purpose |
| --- | --- | --- |
| `SNAP_TOL` | 1.5 | Tolerance (pt) for merging coincident endpoints into one node |
| `CURVE_TOL` | 1.5 | Tolerance (pt) for detecting a branch touching a trunk's curve |
| `SAMPLES_PER_BEZIER` | 14  | Sampling density per curve segment for tapering |
| `ATTEMPT_PATHFINDER_UNITE` | true | Auto-merge vessel/highlight pieces via Pathfinder |
| `MERGE_TOL` | 0.75 | Collapses near-duplicate points left by the boolean union |
| `DO_ROUND_CORNERS` | true | Enable junction fillet patches |
| `FILLET_RADIUS` | 8   | Fillet radius (pt) at sharp junction corners |
| `CORNER_ANGLE_THRESHOLD_DEG` | 25  | Only corners sharper than this get filleted |
| `DO_ADD_HIGHLIGHTS` | true | Enable the highlight layer |
| `LIGHT_ANGLE_DEG` | -45 | Light source direction (highlight slides across the tube as it curves) |
| `HIGHLIGHT_WIDTH_FACTOR` | 0.30 | Highlight half-width, as a fraction of local vessel radius |
| `HIGHLIGHT_OFFSET_FACTOR` | 0.35 | How far the highlight shifts toward the lit side |
| `HIGHLIGHT_LIGHTEN_AMOUNT` | 0.6 | 0 = base fill color, 1 = white |
| `HIGHLIGHT_BLUR_RADIUS` | 4   | Target blur radius (pt) — shown in the final dialog as a reminder for the manual Gaussian Blur step; 0 skips leaving highlights selected |

## Known limitations

- Your selection must form a single tree — no loops/anastomoses.
- If `FILLET_RADIUS` is large relative to a thin vessel, or two corners sit very close together, the script safely **skips** filleting that corner rather than risk broken geometry. Lower `FILLET_RADIUS` if this happens a lot.
- Pathfinder's `Live Pathfinder Add` / `expandStyle` menu commands can be version/locale-sensitive. The script checks whether the union actually reduced the shape count and warns you if it looks like it silently no-opped — if so, select the result and run **Pathfinder > Unite** manually.
- Fillet patches are geometrically correct against the vessel's *current* outline but are generated per shape post-union; extremely dense junction clusters may leave a corner or two unfilleted (see above).
- **Scripted Gaussian Blur is not applied automatically.** `PageItem.applyEffect()` for live raster effects (Gaussian Blur included) is known to be unreliable across Illustrator versions — on Illustrator 23 (CC 2019) it silently no-ops (no thrown error, no effect registered in the Appearance panel) rather than failing loudly. Instead of guessing at version-specific XML syntax, the script builds and clips the highlights correctly, then leaves them pre-selected so you can apply `Effect > Blur > Gaussian Blur` yourself in one action across all of them. If you're on a newer Illustrator version and want to try re-enabling scripted blur, the relevant code was in the highlight-building block in Phase G before this was disabled — search the git history / previous versions of this file.

## Credits

The corner-fillet math (tangent-arc handle length between two edges/circles) adapts the approach used in Hiroyuki Sato's [**Metaball (Arc)**](https://github.com/shspage) script (MIT License, © 2005–2013 Hiroyuki Sato), specifically the `getHandleLengthBase` circular-arc-to-Bezier conversion.

## License

MIT (matches the license of the referenced Metaball (Arc) script this project builds on). Feel free to adapt, extend, or fold into your own toolset.
