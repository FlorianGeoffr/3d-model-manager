# Real-corpus hook

Drop real Bambu Studio `.3mf` / `.gcode.3mf` exports here; tests auto-discover them.

`tests/test_real_corpus.py` globs this directory at collection time:

- `*.3mf` (excluding `*.gcode.3mf`): a project export, parsed via lib3mf and
  asserted to yield at least one triangle.
- `*.gcode.3mf`: a sliced export, parsed via `app.pipeline.slicedmeta.parse_gcode_3mf`
  and asserted to have at least one plate with a non-null print time.

Files committed here are real, potentially large binary exports -- this
directory is otherwise empty (nothing checked in yet) and the primary test
corpus stays the synthetic, deterministic one in `tests/corpus.py`.
