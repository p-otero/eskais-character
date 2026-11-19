"""Bakes NAVER Anny (Apache-2.0 code, CC0 MakeHuman assets) into the compact binary the browser engine loads.

Build-time only: the engine never runs Python. Requirements are pinned in tooling/bake/requirements.txt.

Output (assets/anny/):
  anny.bin   little-endian blob, laid out as described by anny.json
  anny.json  layout, labels and provenance
  ../../test/fixtures/anny-reference.json  vertices computed by Anny itself, to check the TypeScript evaluator

Coordinates are converted to glTF: metres, +Y up, +Z towards the viewer (the face looks down +Z).
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import torch

import anny
from anny.models.model_data import PHENOTYPE_VARIATIONS
from anny.models.phenotype import phenotype_blendshape_weights

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assets" / "anny"
FIXTURES = ROOT / "test" / "fixtures"
SEED = 20261119
SAMPLES = 6000
BODY_RANK = 16

# Face modifiers the scan fits. Left/right pairs are tied (a stylised face is symmetric), so each entry lists the
# Anny local-change labels it drives with one weight.
FACE_MODIFIERS: dict[str, list[str]] = {
    "head-scale-horiz": ["head-scale-horiz-incr"],
    "head-scale-vert": ["head-scale-vert-incr"],
    "head-fat": ["head-fat-incr"],
    "head-age": ["head-age-incr"],
    "head-angle": ["head-angle-out"],
    "forehead-scale-vert": ["forehead-scale-vert-incr"],
    "forehead-temple": ["forehead-temple-incr"],
    "eyebrows-trans-up": ["eyebrows-trans-up"],
    "eyebrows-angle-up": ["eyebrows-angle-up"],
    "eye-scale": ["l-eye-scale-incr", "r-eye-scale-incr"],
    "eye-trans-up": ["l-eye-trans-up", "r-eye-trans-up"],
    "eye-trans-out": ["l-eye-trans-out", "r-eye-trans-out"],
    "eye-height2": ["l-eye-height2-incr", "r-eye-height2-incr"],
    "eye-corner1-up": ["l-eye-corner1-up", "r-eye-corner1-up"],
    "eye-epicanthus": ["l-eye-epicanthus-out", "r-eye-epicanthus-out"],
    "cheek-bones": ["l-cheek-bones-incr", "r-cheek-bones-incr"],
    "cheek-volume": ["l-cheek-volume-incr", "r-cheek-volume-incr"],
    "nose-scale-horiz": ["nose-scale-horiz-incr"],
    "nose-scale-vert": ["nose-scale-vert-incr"],
    "nose-scale-depth": ["nose-scale-depth-incr"],
    "nose-trans-up": ["nose-trans-up"],
    "nose-point-width": ["nose-point-width-incr"],
    "nose-nostrils-width": ["nose-nostrils-width-incr"],
    "mouth-scale-horiz": ["mouth-scale-horiz-incr"],
    "mouth-scale-vert": ["mouth-scale-vert-incr"],
    "mouth-trans-up": ["mouth-trans-up"],
    "mouth-lowerlip-height": ["mouth-lowerlip-height-incr"],
    "mouth-upperlip-height": ["mouth-upperlip-height-incr"],
    "chin-width": ["chin-width-incr"],
    "chin-height": ["chin-height-incr"],
    "chin-prominent": ["chin-prominent-incr"],
    "chin-jaw-drop": ["chin-jaw-drop-incr"],
}


def to_gltf(points: np.ndarray, front_sign: float) -> np.ndarray:
    """Anny is Z-up with the face along front_sign*Y; glTF is Y-up with the face along +Z. A proper rotation (det +1),
    so the character's left stays its left and the triangle winding is unchanged."""
    x, y, z = points[..., 0], points[..., 1], points[..., 2]
    return np.stack([-front_sign * x, z, front_sign * y], axis=-1)


def quantize(block: np.ndarray) -> tuple[np.ndarray, float]:
    scale = float(np.abs(block).max()) / 32767.0 or 1.0
    return np.round(block / scale).astype(np.int16), scale


class Blob:
    def __init__(self) -> None:
        self.parts: list[bytes] = []
        self.offset = 0
        self.layout: dict[str, dict] = {}

    def add(self, name: str, array: np.ndarray, **extra) -> None:
        # Typed-array views need their byte offset aligned to the element size.
        pad = (-self.offset) % 4
        if pad:
            self.parts.append(b"\0" * pad)
            self.offset += pad
        data = np.ascontiguousarray(array).tobytes()
        self.layout[name] = {
            "offset": self.offset,
            "dtype": str(array.dtype),
            "shape": list(array.shape),
            **extra,
        }
        self.parts.append(data)
        self.offset += len(data)

    def bytes(self) -> bytes:
        return b"".join(self.parts)


def main() -> None:
    torch.manual_seed(SEED)
    rng = np.random.default_rng(SEED)
    model = anny.Anny(local_changes="all", facial_actions="all", phenotype_blendshapes="original").to(
        dtype=torch.float64
    )
    labels = list(model.phenotype_labels)
    local_labels = list(model.local_change_labels)
    facial_labels = list(model.facial_action_labels)
    bone_labels = list(model.bone_labels)
    n_pheno = model.stacked_phenotype_blend_shapes_mask.shape[0]
    n_facial = len(facial_labels)
    blendshapes = model.blendshapes.numpy()  # (R, V, 3): phenotype rows, facial rows, local rows (incr, decr)
    bone_blend = model.bone_heads_blendshapes.numpy()
    template = model.template_vertices.numpy()
    template_bones = model.template_bone_heads.numpy()
    vertex_count = template.shape[0]
    bone_count = len(bone_labels)

    head = bone_labels.index("head")
    neck = bone_labels.index("neck01")
    head_vertices = template[:, 2] > template_bones[neck, 2]
    nose_tip_y = template[head_vertices][np.argmax(np.abs(template[head_vertices, 1] - template_bones[head, 1])), 1]
    front_sign = 1.0 if nose_tip_y > template_bones[head, 1] else -1.0

    def phenotype_weights(params: np.ndarray) -> np.ndarray:
        tensor = torch.as_tensor(params, dtype=torch.float64)
        return phenotype_blendshape_weights(
            tensor, labels, model.anchors, model.stacked_phenotype_blend_shapes_mask, extrapolate=False
        ).numpy()

    # Adults only: age 0.6..1 is about 18 to 90 years (anchors: child 1/3, young 2/3, old 1).
    lows = np.array([0.0, 0.6, 0.0, 0.0, 0.0, 0.0])
    highs = np.array([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])
    samples = lows + (highs - lows) * rng.random((SAMPLES, len(labels)))
    weights = phenotype_weights(samples)
    stacked = np.concatenate(
        [blendshapes[:n_pheno].reshape(n_pheno, -1), bone_blend[:n_pheno].reshape(n_pheno, -1)], axis=1
    )
    base = np.concatenate([template.reshape(-1), template_bones.reshape(-1)])
    shapes = base[None] + weights @ stacked
    mean = shapes.mean(axis=0)
    _, singular, vt = np.linalg.svd(shapes - mean, full_matrices=False)
    explained = np.cumsum(singular**2) / np.sum(singular**2)
    basis = vt[:BODY_RANK]  # orthonormal rows
    projection = stacked @ basis.T  # (624, K): phenotype weight -> PCA coefficient
    offset = (base - mean) @ basis.T  # (K,)
    residual = shapes - (mean + ((weights @ projection) + offset) @ basis)
    rms_error_mm = float(np.sqrt((residual**2).mean()) * 1000)
    max_error_mm = float(np.abs(residual).max() * 1000)

    def split_points(flat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return flat[: vertex_count * 3].reshape(-1, 3), flat[vertex_count * 3 :].reshape(-1, 3)

    mean_vertices, mean_bones = split_points(mean)
    basis_vertices = np.stack([to_gltf(split_points(row)[0], front_sign) for row in basis])
    basis_bones = np.stack([to_gltf(split_points(row)[1], front_sign) for row in basis])

    # Face modifiers and facial actions touch the head only; store them over the vertices any of them moves.
    face_rows = []
    face_bone_rows = []
    for anny_labels in FACE_MODIFIERS.values():
        rows = [n_pheno + n_facial + 2 * local_labels.index(label) for label in anny_labels]
        face_bone_rows.append(
            (sum(bone_blend[row] for row in rows), sum(bone_blend[row + 1] for row in rows))
        )
        incr = sum(blendshapes[n_pheno + n_facial + 2 * local_labels.index(label)] for label in anny_labels)
        decr = sum(blendshapes[n_pheno + n_facial + 2 * local_labels.index(label) + 1] for label in anny_labels)
        face_rows.append((incr, decr))
    facial_rows = [blendshapes[n_pheno + i] for i in range(n_facial)]
    moved = np.zeros(vertex_count, dtype=bool)
    for incr, decr in face_rows:
        moved |= np.abs(incr).max(axis=1) > 1e-7
        moved |= np.abs(decr).max(axis=1) > 1e-7
    for row in facial_rows:
        moved |= np.abs(row).max(axis=1) > 1e-7
    head_subset = np.nonzero(moved)[0].astype(np.uint16)

    faces = model.faces.numpy().astype(np.uint16) if hasattr(model, "faces") else None
    if faces is None:
        faces = model.get_triangular_faces().numpy().astype(np.uint16)

    vertex_bone_weights = model.vertex_bone_weights.numpy()
    vertex_bone_indices = model.vertex_bone_indices.numpy()
    order = np.argsort(-vertex_bone_weights, axis=1)[:, :4]
    top_weights = np.take_along_axis(vertex_bone_weights, order, axis=1)
    top_joints = np.take_along_axis(vertex_bone_indices, order, axis=1)
    top_weights = top_weights / top_weights.sum(axis=1, keepdims=True)
    skin_weights = np.round(top_weights * 255).astype(np.int32)
    skin_weights[:, 0] += 255 - skin_weights.sum(axis=1)  # exact sum, as glTF requires for normalized weights
    parents = model.kinematic_chain_indices.numpy()[3].astype(np.int16)

    blob = Blob()
    blob.add("meanVertices", to_gltf(mean_vertices, front_sign).astype(np.float32))
    blob.add("meanBones", to_gltf(mean_bones, front_sign).astype(np.float32))
    q, s = quantize(basis_vertices)
    blob.add("bodyBasisVertices", q, scale=s)
    blob.add("bodyBasisBones", basis_bones.astype(np.float32))
    blob.add("phenotypeProjection", projection.astype(np.float32))
    blob.add("phenotypeOffset", offset.astype(np.float32))
    blob.add("phenotypeMask", model.stacked_phenotype_blend_shapes_mask.numpy().astype(np.uint8))
    blob.add("faces", faces)
    blob.add("headSubset", head_subset)
    face_block = np.stack([np.stack([to_gltf(i[head_subset], front_sign), to_gltf(d[head_subset], front_sign)]) for i, d in face_rows])
    q, s = quantize(face_block)
    blob.add("faceModifiers", q, scale=s)
    blob.add(
        "faceModifierBones",
        np.stack([np.stack([to_gltf(i, front_sign), to_gltf(d, front_sign)]) for i, d in face_bone_rows]).astype(
            np.float32
        ),
    )
    facial_block = np.stack([to_gltf(row[head_subset], front_sign) for row in facial_rows])
    q, s = quantize(facial_block)
    blob.add("facialActions", q, scale=s)
    blob.add("skinJoints", top_joints.astype(np.uint8))
    blob.add("skinWeights", skin_weights.astype(np.uint8))
    blob.add("boneParents", parents)

    data = blob.bytes()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "anny.bin").write_bytes(data)
    manifest = {
        "format": "eskais-anny/1",
        "source": {
            "package": "anny",
            "version": anny.__version__ if hasattr(anny, "__version__") else "0.6.2",
            "repository": "https://github.com/naver/anny",
            "licence": "Apache-2.0 (code); CC0-1.0 (MakeHuman/MPFB2 and Face Units assets)",
            "topology": "anny",
            "rig": "anny",
        },
        "bake": {
            "seed": SEED,
            "samples": SAMPLES,
            "adultAgeRange": [0.6, 1.0],
            "bodyRank": BODY_RANK,
            "explainedVariance": float(explained[BODY_RANK - 1]),
            "pcaRmsErrorMm": rms_error_mm,
            "pcaMaxErrorMm": max_error_mm,
        },
        "sha256": hashlib.sha256(data).hexdigest(),
        "byteLength": len(data),
        "vertexCount": vertex_count,
        "boneCount": bone_count,
        "phenotypeLabels": labels,
        "phenotypeVariations": PHENOTYPE_VARIATIONS,
        "phenotypeAnchors": {k: model.anchors[k].numpy().tolist() for k in PHENOTYPE_VARIATIONS if k != "race"},
        "faceModifiers": list(FACE_MODIFIERS),
        "facialActions": facial_labels,
        "boneLabels": bone_labels,
        "layout": blob.layout,
    }
    (OUT / "anny.json").write_text(json.dumps(manifest, indent=2) + "\n")

    # Reference vertices from Anny itself, at random adult phenotypes plus face modifiers.
    reference_cases = []
    picks = rng.choice(vertex_count, size=64, replace=False)
    for case in range(4):
        params = lows + (highs - lows) * rng.random(len(labels))
        face_values = rng.uniform(-0.8, 0.8, len(FACE_MODIFIERS))
        local = {}
        for value, anny_labels in zip(face_values, FACE_MODIFIERS.values()):
            for label in anny_labels:
                local[label] = float(value)
        coeffs = np.zeros(blendshapes.shape[0])
        coeffs[:n_pheno] = phenotype_weights(params[None])[0]
        for label, value in local.items():
            row = n_pheno + n_facial + 2 * local_labels.index(label)
            coeffs[row if value >= 0 else row + 1] = abs(value)
        rest = model.get_rest_model(torch.as_tensor(coeffs, dtype=torch.float64)[None])
        vertices = to_gltf(rest["rest_vertices"][0].numpy(), front_sign)
        bones = to_gltf(rest["rest_bone_heads"][0].numpy(), front_sign)
        reference_cases.append(
            {
                "phenotype": dict(zip(labels, params.tolist())),
                "faceModifiers": dict(zip(FACE_MODIFIERS, face_values.tolist())),
                "vertexIndices": picks.tolist(),
                "vertices": vertices[picks].round(6).tolist(),
                "bones": {name: bones[bone_labels.index(name)].round(6).tolist() for name in ("head", "eye.L", "eye.R", "upperarm01.L", "upperleg01.R")},
            }
        )
    FIXTURES.mkdir(parents=True, exist_ok=True)
    (FIXTURES / "anny-reference.json").write_text(json.dumps({"cases": reference_cases}) + "\n")
    print(
        f"vertices={vertex_count} bones={bone_count} headSubset={len(head_subset)} bytes={len(data)} "
        f"explained={explained[BODY_RANK - 1]:.6f} pcaRms={rms_error_mm:.3f}mm pcaMax={max_error_mm:.3f}mm front={front_sign}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
