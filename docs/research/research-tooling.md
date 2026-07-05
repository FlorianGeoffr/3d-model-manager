All research complete. Here are the findings.

---

# Python 3D Tooling Research — parsing, conversion, metadata, headless thumbnails (as of 2026-07)

## 0. Recommended stack (TL;DR)

| Concern | Package | Version (mid-2026) | License | Install |
|---|---|---|---|---|
| Mesh load/analyze/convert (STL, OBJ, PLY, GLB, generic 3MF) | `trimesh` | 4.12.2 (2026-05-01) | MIT | pip |
| STEP → GLB | `cascadio` | 0.0.17 (2025-10-21) | MIT | pip (wheels, Linux 25.7 MB) |
| IGES → mesh (and STEP fallback) | `cadquery-ocp` (raw OCCT 7.9 bindings) | 7.9.3.1.1 (2026-05-28) | Apache-2.0 | pip (wheels 46–68 MB) |
| Robust 3MF parsing incl. Production Extension | `lib3mf` | 2.5.0 (2026-02-23) | BSD | pip |
| STL fast path / mass properties | `numpy-stl` | 4.0.0 (2026-06-17) | BSD-3-Clause | pip |
| Headless thumbnail rendering | `f3d` | 3.5.0 (2026-04-05) | BSD-3-Clause | pip (Linux wheel ~47 MB) + `libosmesa` |
| Bambu `.gcode.3mf` metadata/thumbnails | stdlib `zipfile` + `xml.etree` / `json` | — | — | none |

Everything is pip-installable — **no conda needed anywhere**, which keeps the Docker image a normal `python:3.12-slim` + ~300–400 MB of wheels instead of a >1 GB conda environment.

---

## 1. Mesh formats: trimesh, lib3mf, numpy-stl

**trimesh 4.12.2** (MIT, Python ≥3.8; [PyPI](https://pypi.org/project/trimesh/), [docs](https://trimesh.org/)) is the workhorse. Minimal install is numpy-only; STL/PLY/OBJ/GLTF/GLB load with no extras; **3MF requires the `lxml` soft dependency** — install `trimesh[easy]` or add `lxml` + `networkx` + `pillow` + `scipy` explicitly. All the geometry metadata you want is first-class API:

- `len(mesh.faces)` (triangle count), `mesh.bounds` / `mesh.extents` (AABB dims), `mesh.volume`, `mesh.area`, `mesh.is_watertight`, `mesh.euler_number`, `mesh.center_mass`, `mesh.moment_inertia`, `mesh.convex_hull`. `mesh.volume` is only meaningful when `is_watertight` is true — store both.
- Multi-object files load as a `trimesh.Scene`; use `scene.to_geometry()`/`dump(concatenate=True)` before computing whole-model stats.

**trimesh's 3MF reader is fine for "generic" 3MF but only partially supports the 3MF Production Extension** that Bambu Studio/OrcaSlicer write **by default**. Reading [`trimesh/exchange/threemf.py`](https://github.com/mikedh/trimesh/blob/main/trimesh/exchange/threemf.py): it anchors on `3d/3dmodel.model` (case-insensitive), parses with `lxml.etree.iterparse` (memory-efficient), follows `p:path`-style attributes on **components** (`k.endswith("path")`) into other `.model` files in the archive, but **build `<item>` elements are resolved by `objectid` only — no path attribute handling**. Bambu project files put geometry in `3D/Objects/*.model` referenced via the Production Extension ([Bambu wiki confirms Production Extension is their default](https://wiki.bambulab.com/en/software/bambu-studio/3mf-compatibility); [BambuStudio#3316](https://github.com/bambulab/BambuStudio/issues/3316)), so treat trimesh 3MF loading of Bambu files as best-effort and test with real files; the same gap bit Manyfold ([manyfold#2438](https://github.com/manyfold3d/manyfold/issues/2438)).

**lib3mf 2.5.0** (BSD, official 3MF Consortium bindings; [PyPI](https://pypi.org/project/lib3mf/), [3MFConsortium/lib3mf_python](https://github.com/3MFConsortium/lib3mf_python)) is the reference implementation — reading, writing, validation, and the consortium extensions (including Production). Use it as the authoritative 3MF fallback: iterate mesh objects, pull vertices/triangles into numpy, hand to trimesh for stats/GLB export. API is C-style/verbose but reliable. A community alternative `py-lib3mf` (Apache-2.0, latest release 2026-05, used by the build123d ecosystem) exists ([PyPI](https://pypi.org/project/py-lib3mf/)) but the official package is fine.

**numpy-stl 4.0.0** (BSD-3-Clause, Python ≥3.10; [PyPI](https://pypi.org/project/numpy-stl/)) — very fast binary/ASCII STL read with auto-detection, `get_mass_properties()` → volume, COG, inertia tensor. Worth having for a cheap STL-only fast path, but trimesh alone covers STL well; consider it optional.

**Practical parsing strategy:** trimesh for STL/OBJ/generic-3MF → lib3mf fallback when trimesh's 3MF result is empty/wrong → for Bambu `.gcode.3mf`, don't mesh-parse at all (see §3 — sliced exports contain essentially **no real geometry**, just metadata + gcode, per [radagast.ca's 3MF notes](https://radagast.ca/linux/3mf-file-format.html)).

## 2. STEP/IGES → mesh/GLB

Options ranked by pain:

1. **`cascadio`** (MIT, by trimesh's author mikedh; [PyPI](https://pypi.org/project/cascadio/), [GitHub](https://github.com/trimesh/cascadio)) — a minimal pybind11 wrapper around OpenCASCADE that does exactly one thing: **STEP → GLB** (with linear/angular deflection params). Wheels for Py3.8–3.14; Linux wheel 25.7 MB. trimesh integrates it: `trimesh.load("part.step")` works when cascadio is installed ([trimesh.exchange.cascade docs](https://trimesh.org/trimesh.exchange.cascade.html)). **This is the least painful STEP path** — but **IGES is not yet supported** (listed as future work on the README).
2. **`cadquery-ocp` 7.9.3.1.1** (Apache-2.0; [PyPI](https://pypi.org/project/cadquery-ocp/)) — full OCCT 7.9 bindings as **plain pip wheels** (46–68 MB compressed; roughly 300–400 MB installed) for linux x86-64/aarch64, Py3.10–3.14. Use raw OCP for IGES: `IGESControl_Reader` → `BRepMesh_IncrementalMesh` tessellation → extract triangles → trimesh → GLB. You can pull in `cadquery` or `build123d` on top, but for pure import/tessellate you don't need them.
3. **`pythonocc-core`** — still **conda-forge only, no PyPI wheels** ([INSTALL.md](https://github.com/tpaviot/pythonocc-core/blob/master/INSTALL.md), [conda-forge](https://anaconda.org/conda-forge/pythonocc-core)); LGPL-3.0. Choosing it forces micromamba/conda into the image and typically >1 GB. **Avoid.**

**Recommendation:** `cascadio` for STEP → GLB (one function call, small wheel, same author as trimesh). Add `cadquery-ocp` **only** if you commit to IGES support; otherwise mark IGES "stored + downloadable, no preview" in v1 — IGES is a 1990s format and OCCT's IGES healing is the slowest, flakiest part of this whole pipeline. All of this is pip-only, so Docker impact is: +25 MB (cascadio) or +~400 MB (OCP) on top of slim Python — no conda, no OCCT source builds (OCCT from source is a 1–2 h, multi-GB build you do not want in CI).

## 3. Bambu/PrusaSlicer 3MF specifics

A `.3mf` is a ZIP. Bambu Studio **project** file ([Printago's format writeup](https://printago.io/blog/3mf-file-format), [DeepWiki on BambuStudio 3MF handling](https://deepwiki.com/bambulab/BambuStudio/2.3-3mf-project-file-handling)):

```
[Content_Types].xml
_rels/.rels
3D/3dmodel.model              # + 3D/Objects/*.model (Production Extension)
Metadata/project_settings.config   # JSON — full slicer config
Metadata/model_settings.config     # XML — plates, objects, thumbnail paths
Metadata/custom_gcode_per_layer.xml
Metadata/plate_N.png, plate_N_no_light.png, top_plate_N.png, pick_plate_N.png
```

A **sliced `.gcode.3mf`** adds per plate N: `Metadata/plate_N.gcode`, `Metadata/plate_N.json`, and `Metadata/slice_info.config`. Note: sliced exports keep only stub geometry ([radagast.ca](https://radagast.ca/linux/3mf-file-format.html)), and thumbnails are **blank when sliced headlessly** via Bambu Studio CLI.

**Extractable by plain `zipfile` + `ElementTree`/`json` (no third-party lib needed):**
- `slice_info.config` (XML, sliced files only): `<plate>` → `<metadata key="index|prediction|weight|support_used|printer_model_id|nozzle_diameters" value=.../>` — `prediction` is print time in **seconds**, `weight` in grams; plus `<filament id="1" type="PLA" color="#RRGGBB" used_m="4.823" used_g="14.21"/>` (`used_m` in meters, ids 1-indexed); header has `X-BBL-Client-Version`.
- `project_settings.config` (JSON): `printer_model` (e.g. "Bambu Lab A1 mini"), `printer_variant` (nozzle "0.4"), `filament_type[]`, `filament_colour[]`, `enable_support`, etc.
- `model_settings.config` (XML): per-plate `plater_id`, `gcode_file`, `thumbnail_file`/`top_file`/`pick_file` paths — use these instead of hardcoding PNG names.
- Ready-made PNGs: `Metadata/plate_N.png` (lit render) — **use these directly as thumbnails for uploaded sliced files; zero rendering needed.**

**G-code header** (inside `plate_N.gcode`; [bambu-gcode-reference](https://github.com/rjduran/bambu-gcode-reference)): `; HEADER_BLOCK_START` … `; model printing time: …; total estimated time: …`, `; total layer number:`, `; total filament length [mm]`, `; total filament volume [cm^3]`, `; total filament weight [g]`, `; max_z_height:`, followed by `; CONFIG_BLOCK_START` with ~400 `key = value` comment lines (`printer_model`, `nozzle_temperature`, `filament_type`, …). Filament weight lives here and in `slice_info.config`, not in the shorter header of older versions.

**PrusaSlicer** project 3MFs are core-spec (no Production Extension) with slicer config in `Metadata/Slic3r_PE.config` (INI-style) and per-object settings in `Metadata/Slic3r_PE_model.config`; plain PrusaSlicer `.gcode` embeds `; thumbnail begin WxH …` base64-PNG blocks and `; filament used [g]`/`; estimated printing time` footer comments. (Lower confidence — not independently re-verified this session; trivial to confirm against one exported file.)

## 4. Headless thumbnail rendering (no GPU, Docker)

| Tool | Verdict |
|---|---|
| **f3d** ([PyPI](https://pypi.org/project/f3d/), [plugins](https://f3d.app/docs/user/PLUGINS/)) | **Recommended.** BSD-3, v3.5.0, wheels Py3.10–3.14. Reads STL/OBJ/PLY/GLTF natively, **STEP/IGES via bundled `occt` plugin**, 3MF via `assimp` plugin. Wheels ship all plugins **except `usd`/`vdb`** and raytracing ([limitations doc](https://f3d.app/docs/next/user/LIMITATIONS_AND_TROUBLESHOOTING/)). True headless: `Engine.createOSMesa()` = software rendering, no GPU, no X, no GLX ([classes doc](https://github.com/f3d-app/f3d/blob/master/doc/libf3d/02-CLASSES.md)); Linux offscreen-without-GLX added in 3.3.0 ([changelog](https://f3d.app/CHANGELOG/)). SSAA + ambient occlusion → genuinely good-looking thumbnails. |
| pyrender | **Avoid.** Last release 0.1.45 (~2021), effectively unmaintained, broken with numpy ≥2 ([mmatl/pyrender#288](https://github.com/mmatl/pyrender/issues/288)); OSMesa path requires a custom-built Mesa. |
| `trimesh` `scene.save_image()` | **Avoid for servers.** pyglet-based, wants a real/virtual display; long history of blank/garbled output under xvfb ([trimesh#943](https://github.com/mikedh/trimesh/issues/943), [#1312](https://github.com/mikedh/trimesh/issues/1312)). |
| stl-thumb ([GitHub](https://github.com/unlimitedbacon/stl-thumb)) | Nice Rust CLI (STL/OBJ/3MF), but dormant (~v0.5.0), no STEP, needs an OpenGL context anyway. Redundant next to f3d. |

**Recommended worker pipeline** (verified against the upstream [`offscreen_thumbnail.py` example](https://github.com/f3d-app/f3d/blob/master/examples/libf3d/python/offscreen-thumbnail/offscreen_thumbnail.py)):

```python
import f3d
f3d.Engine.autoload_plugins()                 # loads native + occt + assimp...
eng = f3d.Engine.create(True)                 # offscreen; or Engine.create_osmesa()
eng.options.update({"ui.axis": False, "render.grid.enable": False,
                    "render.effect.antialiasing.mode": "ssaa",
                    "render.effect.ambient_occlusion": True})
eng.scene.add(path)                           # STL/OBJ/STEP/IGES/3MF/GLB...
eng.window.size = 512, 512
eng.window.render_to_image(False).save(out_png)   # True → transparent bg
```

Dockerfile: `python:3.12-slim` + `pip install f3d` + `apt-get install libosmesa6 libgl1-mesa-dri` (llvmpipe/OSMesa software GL). **One caveat:** f3d's 3MF path goes through assimp, which cannot follow Production-Extension model references ([assimp#5811](https://github.com/assimp/assimp/issues/5811)) — so for Bambu 3MFs, extract the embedded `plate_N.png` (sliced/project files) or convert via lib3mf→GLB first, then render the GLB with f3d. That three-branch rule (embedded PNG → lib3mf→GLB → f3d direct) covers every format consistently with one renderer.

## 5. GLB as the universal viewer format

**Convert everything to GLB once at ingest; serve GLB to the browser.** Rationale:

- three.js `GLTFLoader` is the fastest, best-maintained loader (binary, zero parsing of text, KTX2/Draco/Meshopt optional). `STLLoader`/`OBJLoader` exist but re-parse raw geometry client-side on every view; there is **no STEP loader in stock three.js** (browser-side STEP needs the `occt-import-js` WASM route à la Online3DViewer — heavy, slow on big parts), and `ThreeMFLoader` only recently got Production-Extension fixes (Manyfold had to ship a loader upgrade to render Bambu files — [manyfold#3584](https://github.com/manyfold3d/manyfold/pull/3584)). Converting server-side gives one code path and lets you keep originals byte-identical for download (your content-hash tracking requires never mutating originals anyway).
- `trimesh.Scene.export(file_type="glb")` is high-fidelity for this use case: preserves scene graph/instancing, vertex normals/colors, indexed vertices; trimesh itself recommends GLB as "a fast modern option" ([PyPI](https://pypi.org/project/trimesh/)). Print models have no materials worth preserving, so fidelity loss is a non-issue.
- Size: binary STL is a flat 50 bytes/triangle; indexed GLB (float32 positions + normals + uint32 indices, V≈T/2) lands around 20–25 bytes/triangle — **roughly half of STL**, before optional Draco. 3MF (zipped XML) can be smaller on disk than GLB, but decompresses/parses far slower in the browser.
- Two caveats: (a) glTF's convention is meters/Y-up while print files are mm/Z-up — bake a mm→m or consistent scale+rotation into the GLB at conversion or normalize the camera in the viewer, and keep the *true* dimensions in DB metadata from trimesh, not from the GLB; (b) generate GLB per **revision** at ingest (STEP tessellation via cascadio takes seconds on complex parts — Celery job, cached next to the thumbnail).

### Key sources
- https://pypi.org/project/trimesh/ · https://trimesh.org/ · https://github.com/mikedh/trimesh/blob/main/trimesh/exchange/threemf.py
- https://pypi.org/project/lib3mf/ · https://github.com/3MFConsortium/lib3mf_python · https://pypi.org/project/py-lib3mf/ · https://pypi.org/project/numpy-stl/
- https://pypi.org/project/cascadio/ · https://github.com/trimesh/cascadio · https://trimesh.org/trimesh.exchange.cascade.html · https://pypi.org/project/cadquery-ocp/ · https://github.com/tpaviot/pythonocc-core/blob/master/INSTALL.md
- https://printago.io/blog/3mf-file-format · https://radagast.ca/linux/3mf-file-format.html · https://wiki.bambulab.com/en/software/bambu-studio/3mf-compatibility · https://github.com/rjduran/bambu-gcode-reference · https://deepwiki.com/bambulab/BambuStudio/2.3-3mf-project-file-handling
- https://pypi.org/project/f3d/ · https://f3d.app/docs/user/PLUGINS/ · https://f3d.app/docs/next/user/LIMITATIONS_AND_TROUBLESHOOTING/ · https://f3d.app/CHANGELOG/ · https://github.com/f3d-app/f3d/blob/master/doc/libf3d/02-CLASSES.md · https://github.com/f3d-app/f3d/blob/master/examples/libf3d/python/offscreen-thumbnail/offscreen_thumbnail.py
- https://github.com/mmatl/pyrender/issues/288 · https://github.com/mikedh/trimesh/issues/943 · https://github.com/unlimitedbacon/stl-thumb
- https://github.com/assimp/assimp/issues/5811 · https://github.com/manyfold3d/manyfold/issues/2438 · https://github.com/manyfold3d/manyfold/pull/3584