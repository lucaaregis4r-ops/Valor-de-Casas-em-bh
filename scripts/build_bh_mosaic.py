"""Converte o CSV Bairro Popular da PBH em uma malha leve para o site.

Uso: python scripts/build_bh_mosaic.py 20240902_bairro_popular.csv
Dependências de geração: shapely e pyproj. O site não precisa delas.
Fonte: https://ckan.pbh.gov.br/dataset/bairro-popular
Recurso: 20240902_bairro_popular (CC BY, PBH/Prodabel).
"""

import csv
import json
import math
import sys
from pathlib import Path

from pyproj import Transformer
from shapely import transform, wkt
from shapely.geometry import box, mapping
from shapely.validation import make_valid


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "geography"
CELL_METERS = 400
transformer = Transformer.from_crs(31983, 4326, always_xy=True)


def rounded_shape(shape):
    def round_coords(value):
        if isinstance(value, (tuple, list)) and value and isinstance(value[0], (int, float)):
            return [round(value[0], 7), round(value[1], 7)]
        return [round_coords(part) for part in value]

    result = mapping(transform(shape, transformer.transform, interleaved=False))
    result["coordinates"] = round_coords(result["coordinates"])
    return result


def polygons_only(shape):
    if shape.geom_type in ("Polygon", "MultiPolygon"):
        return shape
    from shapely.geometry import MultiPolygon

    if not hasattr(shape, "geoms"):
        return MultiPolygon([])
    polygons = []
    for part in shape.geoms:
        polygon_part = polygons_only(part)
        if polygon_part.geom_type == "Polygon":
            polygons.append(polygon_part)
        elif polygon_part.geom_type == "MultiPolygon":
            polygons.extend(polygon_part.geoms)
    return MultiPolygon(polygons)


def main(source):
    neighborhoods = []
    cells = []
    with open(source, newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle, delimiter=";"):
            shape = wkt.loads(row["GEOMETRIA"])
            if not shape.is_valid:
                shape = make_valid(shape)
            shape = polygons_only(shape)
            if shape.is_empty:
                raise ValueError(f"Geometria vazia: {row['NOME']}")
            code = row["CODIGO"]
            name = row["NOME"]
            display_shape = shape.simplify(5, preserve_topology=True)
            neighborhoods.append({
                "type": "Feature",
                "properties": {"code": code, "name": name},
                "geometry": rounded_shape(display_shape),
            })
            min_x, min_y, max_x, max_y = display_shape.bounds
            for ix in range(math.floor(min_x / CELL_METERS), math.ceil(max_x / CELL_METERS)):
                for iy in range(math.floor(min_y / CELL_METERS), math.ceil(max_y / CELL_METERS)):
                    clipped = polygons_only(display_shape.intersection(box(
                        ix * CELL_METERS, iy * CELL_METERS,
                        (ix + 1) * CELL_METERS, (iy + 1) * CELL_METERS,
                    )))
                    if clipped.is_empty or clipped.area < 100:
                        continue
                    clipped = polygons_only(clipped.simplify(3, preserve_topology=True).intersection(display_shape))
                    cells.append({
                        "type": "Feature",
                        "properties": {"id": f"{code}:{ix}:{iy}", "code": code},
                        "geometry": rounded_shape(clipped),
                    })
    OUT.mkdir(parents=True, exist_ok=True)
    for filename, features in (("bh_neighborhoods.geojson", neighborhoods), ("bh_cells_400m.geojson", cells)):
        (OUT / filename).write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(filename, len(features), (OUT / filename).stat().st_size)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Uso: python scripts/build_bh_mosaic.py arquivo.csv")
    main(sys.argv[1])
