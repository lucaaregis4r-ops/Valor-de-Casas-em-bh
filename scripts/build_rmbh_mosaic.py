"""Converte a malha de municípios da RMBH da PBH em GeoJSON para o site.

Uso: python scripts/build_rmbh_mosaic.py 20260101_municipio_rmbh.csv
Fonte: https://ckan.pbh.gov.br/dataset/municipio-rmbh
Recurso: 20260101_municipio_rmbh (FJP/PBH-Prodabel, CC BY).
"""

import csv
import json
import math
import sys

from shapely import wkt
from shapely.geometry import box
from shapely.validation import make_valid

from build_bh_mosaic import OUT, polygons_only, rounded_shape


CELL_METERS = 1000


def display_name(value):
    words = value.title().split()
    return " ".join(word.lower() if index and word.lower() in {"da", "das", "de", "do", "dos"} else word
                    for index, word in enumerate(words))


def main(source):
    cities = []
    cells = []
    csv.field_size_limit(sys.maxsize)
    with open(source, newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle, delimiter=";"):
            shape = wkt.loads(row["GEOMETRIA"])
            if not shape.is_valid:
                shape = make_valid(shape)
            shape = polygons_only(shape)
            if shape.is_empty:
                raise ValueError(f"Geometria vazia: {row['NOME_MUNICIPIO']}")
            display_shape = shape.simplify(20, preserve_topology=True)
            code = row["ID_MRMBH"]
            name = display_name(row["NOME_MUNICIPIO"])
            cities.append({
                "type": "Feature",
                "properties": {"code": code, "name": name},
                "geometry": rounded_shape(display_shape),
            })
            if name == "Belo Horizonte":
                continue  # BH já usa sua malha de bairros mais detalhada.
            min_x, min_y, max_x, max_y = display_shape.bounds
            for ix in range(math.floor(min_x / CELL_METERS), math.ceil(max_x / CELL_METERS)):
                for iy in range(math.floor(min_y / CELL_METERS), math.ceil(max_y / CELL_METERS)):
                    clipped = polygons_only(display_shape.intersection(box(
                        ix * CELL_METERS, iy * CELL_METERS,
                        (ix + 1) * CELL_METERS, (iy + 1) * CELL_METERS,
                    )))
                    if clipped.is_empty or clipped.area < 100:
                        continue
                    clipped = polygons_only(clipped.simplify(10, preserve_topology=True).intersection(display_shape))
                    cells.append({
                        "type": "Feature",
                        "properties": {"id": f"{code}:{ix}:{iy}", "code": code},
                        "geometry": rounded_shape(clipped),
                    })
    if len(cities) != 34:
        raise ValueError(f"A malha deveria ter 34 municípios, recebeu {len(cities)}")
    OUT.mkdir(parents=True, exist_ok=True)
    for filename, features in (("rmbh_cities.geojson", cities), ("rmbh_cells_1000m.geojson", cells)):
        path = OUT / filename
        path.write_text(json.dumps({"type":"FeatureCollection", "features":features}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(filename, len(features), path.stat().st_size)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Uso: python scripts/build_rmbh_mosaic.py arquivo.csv")
    main(sys.argv[1])
