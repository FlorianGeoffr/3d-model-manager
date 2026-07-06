"""The procedural test corpus (``tests/corpus.py``) really is what it
claims to be -- most importantly that ``box_3mf_bambu`` discriminates
between trimesh (which cannot follow Production-Extension ``<build><item
p:path>`` references) and lib3mf (which can): if that fixture ever loads
fine in trimesh, it has stopped exercising the lib3mf fallback path the
pipeline exists to cover (RESEARCH §1).
"""

import zipfile

import lib3mf
import numpy as np
import pytest
import trimesh

from tests.corpus import CorpusPaths

# The known truth for every mesh-bearing corpus fixture, in trimesh's native
# units (mm): 20 x 10 x 5 box = 12 triangles, 1000 mm^3 (1.0 cm^3), 700 mm^2
# (7.0 cm^2), watertight.
EXPECTED_EXTENTS_MM = (20.0, 10.0, 5.0)
EXPECTED_VOLUME_MM3 = 1000.0
EXPECTED_AREA_MM2 = 700.0


def _single_mesh(loaded: trimesh.Trimesh | trimesh.Scene) -> trimesh.Trimesh:
    """Collapse trimesh's load result (bare mesh or single-geometry scene)
    to one mesh.
    """
    if isinstance(loaded, trimesh.Scene):
        return loaded.to_mesh()
    return loaded


@pytest.mark.parametrize("fixture_name", ["box_stl", "box_obj", "box_3mf_generic"])
def test_mesh_fixtures_load_in_trimesh_with_known_truth(
    corpus: CorpusPaths, fixture_name: str
) -> None:
    mesh = _single_mesh(trimesh.load(getattr(corpus, fixture_name)))

    assert len(mesh.faces) == 12
    assert np.allclose(mesh.extents, EXPECTED_EXTENTS_MM)
    assert mesh.is_watertight
    assert mesh.volume == pytest.approx(EXPECTED_VOLUME_MM3)
    assert mesh.area == pytest.approx(EXPECTED_AREA_MM2)


def test_bambu_3mf_defeats_trimesh_but_loads_via_lib3mf(corpus: CorpusPaths) -> None:
    """The Production-Extension fixture must fail in trimesh (raise, or come
    back with no geometry -- current versions return an empty ``Scene``) AND
    parse to the full cube via lib3mf. Both halves matter: together they
    prove the corpus really discriminates the two loaders rather than being
    readable (or broken) everywhere.
    """
    try:
        loaded = trimesh.load(corpus.box_3mf_bambu)
    except BaseException:  # noqa: B036 - any load failure counts as "defeats trimesh"
        pass
    else:
        assert isinstance(loaded, trimesh.Scene)
        assert len(loaded.geometry) == 0

    wrapper = lib3mf.get_wrapper()
    model = wrapper.CreateModel()
    reader = model.QueryReader("3mf")
    reader.ReadFromFile(str(corpus.box_3mf_bambu))
    iterator = model.GetMeshObjects()
    triangle_count = 0
    while iterator.MoveNext():
        triangle_count += iterator.GetCurrentMeshObject().GetTriangleCount()

    assert triangle_count == 12


def test_sliced_gcode_3mf_zip_structure(corpus: CorpusPaths) -> None:
    with zipfile.ZipFile(corpus.sliced_gcode_3mf) as zf:
        assert zf.testzip() is None
        names = set(zf.namelist())
        assert names >= {
            "3D/3dmodel.model",
            "Metadata/slice_info.config",
            "Metadata/project_settings.config",
            "Metadata/model_settings.config",
            "Metadata/plate_1.png",
            "Metadata/plate_2.png",
            "Metadata/plate_1.gcode",
        }
        assert zf.read("Metadata/plate_1.gcode").startswith(b"; HEADER_BLOCK_START\n")


def test_step_and_iges_files_are_nontrivial(corpus: CorpusPaths) -> None:
    assert corpus.box_step.stat().st_size > 1024
    assert corpus.box_iges.stat().st_size > 1024
