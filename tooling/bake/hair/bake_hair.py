"""Bakes CC0 MakeHuman hair into the compact, texture-free asset the engine fits to any Anny shape.

Build-time only. Downloads the two pinned CC0 asset packs (SHA-256 checked) into .cache/hair-packs (outside git),
fits each chosen style to the MakeHuman base mesh with MakeHuman's own proxy method (.mhclo), and turns its
alpha-textured hair cards into opaque geometry: faces whose texture is mostly transparent are dropped, partly covered
cards are narrowed towards their opaque side, and the texture's brightness becomes a per-vertex shade. No image is
written to the repo.

MakeHuman hair often hangs off hair-helper vertices that Anny's topology drops, so every hair vertex is re-bound to the
nearest triangle of Anny's head: barycentric weights plus an offset scaled by the head's size, as MakeHuman does. The
bake checks that binding against Anny's full topology (which keeps the helpers) on varied shapes.

Output: assets/hair/hair.bin and assets/hair/hair.json. Usage (bake venv): python tooling/bake/hair/bake_hair.py
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import torch
from PIL import Image

import anny

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "assets" / "hair"
CACHE = ROOT / ".cache" / "hair-packs"
CHECKED = "2026-11-20"

PACKS = {
    "hair01": {
        "url": "https://files.makehumancommunity.org/asset_packs/hair01/hair01_cc0.zip",
        "file": "hair01_cc0.zip",
        "sha256": "49445d69848a313ec41a9970f6a0fe4bcf925c9f1c6ef40a76f119c2e07940c9",
        "bytes": 227775853,
        "name": 'MakeHuman asset pack "Hair 01"',
    },
    "system": {
        "url": "https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip",
        "file": "makehuman_system_assets_cc0.zip",
        "sha256": "b542127a8e25547c7c29c19f2d1d2adb9a664c80396ecd694095dbc8028a0107",
        "bytes": 280737770,
        "name": "MakeHuman system assets",
    },
}

# id, label, length class, shape, pack, folder under hair/, author (from the pack's metadata or file header).
STYLES = [
    ("crop", "Short crop", "short", "straight", "system", "short02", "MakeHuman team (Data Collection AB)"),
    ("side-part", "Side part", "short", "straight", "system", "short03", "MakeHuman team (Data Collection AB)"),
    ("afro", "Short afro", "short", "afro", "system", "afro01", "MakeHuman team (Data Collection AB)"),
    ("bob", "Bob", "medium", "straight", "system", "bob02", "MakeHuman team (Data Collection AB)"),
    ("fringe-bob", "Bob with fringe", "medium", "straight", "hair01", "littleright_bobcut_hair", "Littleright"),
    ("long", "Long straight", "long", "straight", "system", "long01", "MakeHuman team (Data Collection AB)"),
    ("ponytail", "Ponytail", "long", "updo", "system", "ponytail01", "MakeHuman team (Data Collection AB)"),
    ("braid", "Braid", "long", "braid", "system", "braid01", "MakeHuman team (Data Collection AB)"),
]

# Offsets in steps of 0.25 mm: far below what shows, and small integers compress well.
OFFSET_STEP = 0.00025
COVERAGE_KEEP = 0.3
ALPHA_OPAQUE = 0.5
GRID = np.array([(s, t) for s in np.linspace(0.08, 0.92, 7) for t in np.linspace(0.08, 0.92, 7)])


def delta(array: np.ndarray) -> np.ndarray:
    """Each value minus the previous one (per column, wrapping in 16 bits): neighbouring hair vertices and triangle
    indices differ little, so the deltas are small and compress well. The loader sums them back."""
    flat = array.reshape(len(array), -1).astype(np.int64)
    out = np.diff(flat, axis=0, prepend=np.zeros((1, flat.shape[1]), dtype=np.int64))
    return (out & 0xFFFF).astype(np.uint16).view(array.dtype).reshape(array.shape)


def byte_planes(array: np.ndarray) -> np.ndarray:
    """16-bit values stored as all low bytes, then all high bytes: the high bytes are nearly constant, so gzip and
    brotli shrink them to almost nothing. Same shape and dtype; the loader interleaves them back."""
    raw = np.ascontiguousarray(array).view(np.uint8).reshape(-1, 2)
    return np.concatenate([raw[:, 0], raw[:, 1]]).view(array.dtype).reshape(array.shape)


def to_gltf(points: np.ndarray) -> np.ndarray:
    """Anny's frame (Z up, face along -Y) to the engine's glTF frame, as tooling/bake/bake_anny.py does."""
    return np.stack([points[..., 0], points[..., 2], -points[..., 1]], axis=-1)


def fetch_pack(key: str) -> zipfile.ZipFile:
    pack = PACKS[key]
    path = CACHE / pack["file"]
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        print(f"downloading {pack['url']}", file=sys.stderr)
        with urllib.request.urlopen(pack["url"]) as response:  # noqa: S310 - pinned https URL, hash-checked below
            path.write_bytes(response.read())
    data = path.read_bytes()
    if len(data) != pack["bytes"] or hashlib.sha256(data).hexdigest() != pack["sha256"]:
        raise SystemExit(f"{path.name} does not match its pinned size and SHA-256")
    return zipfile.ZipFile(io.BytesIO(data))


def read_member(archive: zipfile.ZipFile, folder: str, suffix: str) -> tuple[str, bytes]:
    names = [n for n in archive.namelist() if n.startswith(f"hair/{folder}/") and n.endswith(suffix)]
    if not names:
        raise SystemExit(f"hair/{folder}: no *{suffix}")
    return names[0], archive.read(names[0])


def parse_mhclo(text: str):
    scales: dict[str, tuple[int, int, float]] = {}
    refs, weights, offsets = [], [], []
    in_verts = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if parts[0] in ("x_scale", "y_scale", "z_scale"):
            scales[parts[0][0]] = (int(parts[1]), int(parts[2]), float(parts[3]))
            continue
        if parts[0] == "verts":
            in_verts = True
            continue
        if parts[0] in ("delete_verts", "weights"):
            in_verts = False
            continue
        if not in_verts or not all(p.lstrip("-").replace(".", "", 1).isdigit() for p in parts):
            continue
        if len(parts) == 1:
            refs.append([int(parts[0])] * 3)
            weights.append([1.0, 0.0, 0.0])
            offsets.append([0.0, 0.0, 0.0])
        elif len(parts) >= 9:
            refs.append([int(p) for p in parts[0:3]])
            weights.append([float(p) for p in parts[3:6]])
            offsets.append([float(p) for p in parts[6:9]])
    licence = [line.strip("# ").strip() for line in text.splitlines() if "cc0" in line.lower()][:1]
    return scales, np.array(refs), np.array(weights), np.array(offsets), licence


def parse_obj(text: str):
    uvs, faces, count = [], [], 0
    for line in text.splitlines():
        if line.startswith("v "):
            count += 1
        elif line.startswith("vt "):
            uvs.append([float(x) for x in line.split()[1:3]])
        elif line.startswith("f "):
            corners = [c.split("/") for c in line.split()[1:]]
            faces.append([(int(c[0]) - 1, int(c[1]) - 1 if len(c) > 1 and c[1] else -1) for c in corners])
    return count, np.array(uvs) if uvs else np.zeros((0, 2)), faces


def mhclo_fit(refs, weights, offsets, scales, hm_vertices_m: np.ndarray) -> np.ndarray:
    """MakeHuman's proxy fit on hm08 vertices (metres, glTF axes): weighted refs + offset scaled by the head's size.
    hm08 is decimetres with Y up and Z forward, so the only change from MakeHuman's units is a factor of ten."""
    scale = np.array(
        [abs(hm_vertices_m[a, k] - hm_vertices_m[b, k]) * 10 / den for k, (a, b, den) in enumerate(scales[x] for x in "xyz")]
    )
    return np.einsum("vk,vkd->vd", weights, hm_vertices_m[refs]) + offsets * 0.1 * scale


def closest_on_triangles(points: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray):
    """Closest point on any of the triangles for each point: (triangle index, barycentric (u, v, w), distance)."""
    best_tri = np.zeros(len(points), dtype=np.int64)
    best_bary = np.zeros((len(points), 3))
    best_dist = np.full(len(points), np.inf)
    ab, ac = b - a, c - a
    d00 = (ab * ab).sum(1)
    d01 = (ab * ac).sum(1)
    d11 = (ac * ac).sum(1)
    denom = d00 * d11 - d01 * d01
    for i, p in enumerate(points):
        ap = p - a
        d20 = (ap * ab).sum(1)
        d21 = (ap * ac).sum(1)
        v = (d11 * d20 - d01 * d21) / denom
        w = (d00 * d21 - d01 * d20) / denom
        v = np.clip(v, 0, 1)
        w = np.clip(w, 0, 1)
        over = v + w > 1
        v[over], w[over] = v[over] / (v[over] + w[over]), w[over] / (v[over] + w[over])
        u = 1 - v - w
        q = a * u[:, None] + b * v[:, None] + c * w[:, None]
        dist = np.linalg.norm(q - p, axis=1)
        k = int(np.argmin(dist))
        best_tri[i], best_bary[i], best_dist[i] = k, (u[k], v[k], w[k]), dist[k]
    return best_tri, best_bary, best_dist


def sample_texture(image: np.ndarray, uv: np.ndarray) -> np.ndarray:
    h, w = image.shape[:2]
    x = np.clip((uv[:, 0] % 1.0) * (w - 1), 0, w - 1).astype(int)
    y = np.clip((1.0 - (uv[:, 1] % 1.0)) * (h - 1), 0, h - 1).astype(int)
    return image[y, x]


def cards_to_geometry(faces, uvs, image, positions):
    """Drops mostly transparent faces, narrows partly covered quads, and returns triangles plus per-vertex shade."""
    vertex_count = len(positions)
    kept, shade_sum, shade_count = [], np.zeros(vertex_count), np.zeros(vertex_count)
    pull = {}
    for face in faces:
        corners = [c[0] for c in face]
        if image is None or any(c[1] < 0 for c in face):
            kept.append(corners)
            continue
        uv = uvs[[c[1] for c in face]]
        quad = uv if len(uv) == 4 else np.vstack([uv, uv[-1:]])
        s, t = GRID[:, :1], GRID[:, 1:]
        sample_uv = (1 - s) * (1 - t) * quad[0] + s * (1 - t) * quad[1] + s * t * quad[2] + (1 - s) * t * quad[3]
        texels = sample_texture(image, sample_uv)
        opaque = texels[:, 3] > ALPHA_OPAQUE
        coverage = float(opaque.mean())
        if coverage < COVERAGE_KEEP:
            continue
        kept.append(corners)
        luminance = float((texels[opaque, :3] @ np.array([0.2126, 0.7152, 0.0722])).mean())
        for c in corners:
            shade_sum[c] += luminance
            shade_count[c] += 1
        if len(corners) == 4 and coverage < 0.8:
            # Coverage along each edge of the quad; a corner whose two edges are mostly transparent moves halfway in.
            grid = opaque.reshape(7, 7)  # [s, t]
            edge = {"s0": grid[0].mean(), "s1": grid[-1].mean(), "t0": grid[:, 0].mean(), "t1": grid[:, -1].mean()}
            centre = positions[corners].mean(axis=0)
            for corner, (cs, ct) in zip(corners, ((0, 0), (1, 0), (1, 1), (0, 1))):
                if edge[f"s{cs}"] < 0.35 or edge[f"t{ct}"] < 0.35:
                    pull.setdefault(corner, []).append(centre)
    narrowed = positions.copy()
    for corner, centres in pull.items():
        narrowed[corner] = 0.5 * positions[corner] + 0.5 * np.mean(centres, axis=0)
    used = sorted({v for f in kept for v in f})
    remap = {old: new for new, old in enumerate(used)}
    triangles = []
    for f in kept:
        mapped = [remap[v] for v in f]
        for k in range(1, len(mapped) - 1):
            triangles.append((mapped[0], mapped[k], mapped[k + 1]))
    shade = np.where(shade_count > 0, shade_sum / np.maximum(shade_count, 1), np.nan)[used]
    median = np.nanmedian(shade) if np.isfinite(shade).any() else 1.0
    shade = np.nan_to_num(shade / (median or 1.0), nan=1.0)
    shade = np.clip(0.8 + 0.4 * (shade - 1.0), 0.55, 1.0)
    return used, np.array(triangles, dtype=np.int64), narrowed[used], shade


def rest_vertices(model, phenotype: dict[str, float]) -> np.ndarray:
    from anny.models.phenotype import phenotype_blendshape_weights

    params = torch.tensor([[phenotype[k] for k in model.phenotype_labels]], dtype=torch.float64)
    w = phenotype_blendshape_weights(params, model.phenotype_labels, model.anchors, model.stacked_phenotype_blend_shapes_mask, False)
    if model.phenotype_blendshape_projection is not None:
        w = w @ model.phenotype_blendshape_projection
    coeffs = torch.zeros((1, model.blendshapes.shape[0]), dtype=torch.float64)
    coeffs[:, : w.shape[1]] = w
    return to_gltf(model.get_rest_vertices(coeffs)[0].numpy())


def main() -> None:
    archives = {key: fetch_pack(key) for key in PACKS}
    body = anny.Anny().to(dtype=torch.float64)
    full = anny.Anny(topology="anny-full").to(dtype=torch.float64)
    base_index = body.base_mesh_vertex_indices.numpy()
    hm_template = to_gltf(full.template_vertices.numpy())  # full topology index == hm08 index
    anny_template = to_gltf(body.template_vertices.numpy())
    faces = body.faces.numpy()
    labels = list(body.bone_labels)
    # Hair anchors on the head, neck and upper back, so long hair follows the shoulders and back too.
    anchor_bones = {labels.index(n) for n in ("head", "neck01", "neck02", "neck03", "spine01", "spine02", "clavicle.L", "clavicle.R", "shoulder01.L", "shoulder01.R")}
    dominant = body.vertex_bone_indices.numpy()[np.arange(len(anny_template)), body.vertex_bone_weights.numpy().argmax(1)]
    eyes_and_mouth = set()
    parent = np.arange(len(anny_template))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for f in faces:
        ra = find(f[0])
        parent[find(f[1])] = ra
        parent[find(f[2])] = ra
    roots = np.array([find(i) for i in range(len(anny_template))])
    largest = np.bincount(roots).argmax()
    body_part = roots == largest  # drops the eyeball and mouth-cavity parts
    allowed = np.isin(dominant, list(anchor_bones)) & body_part
    head_faces = faces[allowed[faces].all(axis=1)]
    tri_a, tri_b, tri_c = (anny_template[head_faces[:, k]] for k in range(3))
    # Head-size references for the offsets (MakeHuman's x/y/z scale vertices), mapped to Anny's indices.
    inverse = {int(h): i for i, h in enumerate(base_index)}
    head_scale_refs = {"x": (5399, 11998), "y": (791, 881), "z": (962, 5320)}
    scale = {}
    for k, axis in enumerate("xyz"):
        a, b = (inverse[h] for h in head_scale_refs[axis])
        scale[axis] = [a, b, float(abs(anny_template[a, k] - anny_template[b, k]))]
    variants = [
        {"gender": 0.0, "age": 0.65, "muscle": 0.9, "weight": 0.9, "height": 1.0, "proportions": 0.2},
        {"gender": 1.0, "age": 0.95, "muscle": 0.1, "weight": 0.1, "height": 0.0, "proportions": 0.9},
    ]
    hm_variants = [rest_vertices(full, v) for v in variants]
    anny_variants = [rest_vertices(body, v) for v in variants]

    parts, offset, styles = [], 0, []
    used_anchor_triangles: dict[int, int] = {}

    def remap_anchor(triangles_used: np.ndarray) -> np.ndarray:
        """Indices into the compact table of the anchor triangles any style uses."""
        return np.array([used_anchor_triangles.setdefault(int(t), len(used_anchor_triangles)) for t in triangles_used])

    def add(array: np.ndarray) -> dict:
        nonlocal offset
        pad = (-offset) % 4
        if pad:
            parts.append(b"\0" * pad)
            offset += pad
        data = np.ascontiguousarray(array).tobytes()
        entry = {"offset": offset, "dtype": str(array.dtype), "shape": list(array.shape)}
        parts.append(data)
        offset += len(data)
        return entry

    for style_id, label, length, shape, pack, folder, author in STYLES:
        archive = archives[pack]
        mhclo_name, mhclo = read_member(archive, folder, ".mhclo")
        scales, refs, weights, offsets, licence = parse_mhclo(mhclo.decode("utf-8", "replace"))
        obj_name, obj = read_member(archive, folder, ".obj")
        vertex_count, uvs, obj_faces = parse_obj(obj.decode("utf-8", "replace"))
        if vertex_count != len(refs):
            raise SystemExit(f"{folder}: {vertex_count} obj vertices but {len(refs)} proxy vertices")
        _, mhmat = read_member(archive, folder, ".mhmat")
        image = None
        for line in mhmat.decode("utf-8", "replace").splitlines():
            if line.strip().startswith("diffuseTexture"):
                name = f"hair/{folder}/{Path(line.split(maxsplit=1)[1].strip()).name}"
                if name in archive.namelist():
                    image = np.asarray(Image.open(io.BytesIO(archive.read(name))).convert("RGBA"), dtype=np.float32) / 255
        positions = mhclo_fit(refs, weights, offsets, scales, hm_template)
        used, triangles, narrowed, shade = cards_to_geometry(obj_faces, uvs, image, positions)
        tri, bary, dist = closest_on_triangles(narrowed, tri_a, tri_b, tri_c)
        # Faces buried in the head (every corner more than 2 mm under the skin) never show: drop them.
        normals = np.cross(tri_b[tri] - tri_a[tri], tri_c[tri] - tri_a[tri])
        normals /= np.linalg.norm(normals, axis=1, keepdims=True)
        depth = np.einsum("vd,vd->v", narrowed - np.einsum("vk,vkd->vd", bary, np.stack([tri_a[tri], tri_b[tri], tri_c[tri]], 1)), normals)
        buried = depth < -0.002
        visible = ~buried[triangles].all(axis=1)
        dropped = int((~visible).sum())
        triangles = triangles[visible]
        keep = np.unique(triangles)
        reindex = np.full(len(used), -1)
        reindex[keep] = np.arange(len(keep))
        triangles = reindex[triangles]
        used = [used[i] for i in keep]
        narrowed, shade, tri, bary, dist = narrowed[keep], shade[keep], tri[keep], bary[keep], dist[keep]
        anchors = head_faces[tri]
        base_points = np.einsum("vk,vkd->vd", bary, anny_template[anchors])
        offsets_m = narrowed - base_points

        def predict(vertices: np.ndarray) -> np.ndarray:
            s = np.array([abs(vertices[a, k] - vertices[b, k]) / den for k, (a, b, den) in enumerate(scale[x] for x in "xyz")])
            return np.einsum("vk,vkd->vd", bary, vertices[anchors]) + offsets_m * s

        errors = []
        for hm_v, anny_v in zip(hm_variants, anny_variants):
            truth = mhclo_fit(refs, weights, offsets, scales, hm_v)[used]
            errors.append(np.linalg.norm(predict(anny_v) - truth, axis=1))
        err = np.concatenate(errors)
        offset_step = OFFSET_STEP
        layout = {
            "anchorTriangles": add(byte_planes(delta(remap_anchor(tri).astype(np.uint16).reshape(-1, 1)).reshape(-1))),
            "weights": add(np.round(bary[:, :2] * 255).astype(np.uint8)),
            "offsets": add(byte_planes(delta(np.round(offsets_m / offset_step).astype(np.int16)))),
            "shade": add(np.round(shade * 255).astype(np.uint8)),
            "triangles": add(byte_planes(delta(triangles.astype(np.uint16).reshape(-1, 1)).reshape(-1, 3))),
        }
        styles.append(
            {
                "id": style_id,
                "label": label,
                "length": length,
                "shape": shape,
                "licence": "CC0-1.0",
                "source": {
                    "pack": PACKS[pack]["name"],
                    "packUrl": PACKS[pack]["url"],
                    "asset": folder,
                    "author": author,
                    "files": [mhclo_name, obj_name],
                    "statement": licence[0] if licence else "listed as CC0 in the pack's metadata (packs/hair01.json)",
                },
                "offsetStep": offset_step,
                "vertexCount": len(used),
                "triangleCount": len(triangles),
                "bindingErrorMm": {"mean": round(float(err.mean() * 1000), 2), "p95": round(float(np.percentile(err, 95) * 1000), 2)},
                "layout": layout,
            }
        )
        print(
            f"{style_id:9s} {len(used):5d} vertices {len(triangles):5d} triangles; binding error vs full topology "
            f"mean {err.mean() * 1000:.1f} mm p95 {np.percentile(err, 95) * 1000:.1f} mm; max scalp distance {dist.max() * 1000:.0f} mm; "
            f"{dropped} buried triangles dropped",
            file=sys.stderr,
        )

    order = sorted(used_anchor_triangles, key=used_anchor_triangles.get)
    anchor_faces_entry = add(head_faces[order].astype(np.uint16))
    blob = b"".join(parts)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "hair.bin").write_bytes(blob)
    manifest = {
        "format": "eskais-hair/2",
        "encoding": "offsets, triangles and anchorTriangles are delta-coded per column (16-bit wrap) and stored as byte planes (all low bytes, then all high bytes)",
        "note": "CC0 MakeHuman hair fitted to Anny's head; geometry only, no textures (tooling/bake/hair/bake_hair.py).",
        "sha256": hashlib.sha256(blob).hexdigest(),
        "byteLength": len(blob),
        "checked": CHECKED,
        "scale": scale,
        "anchorFaces": anchor_faces_entry,
        "packs": PACKS,
        "styles": styles,
    }
    with open(OUT / "hair.json", "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(manifest, indent=2) + "\n")
    print(f"hair.bin {len(blob)} bytes", file=sys.stderr)


if __name__ == "__main__":
    main()
