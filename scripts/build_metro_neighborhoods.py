"""Gera bairros e células de 400 m para Contagem e Betim.

Uso: python scripts/build_metro_neighborhoods.py contagem.geojson betim.zip
Dependências de geração: shapely, pyproj, pyshp.

Contagem: https://geoprocessamento.contagem.mg.gov.br/arcgis/rest/services/SIGM_BD_Publico/Divisao_Territorial_Publico/FeatureServer/0
Betim: https://www.betim.mg.gov.br/portal/secretarias-paginas/308/cartografia/
"""

import json
import math
import sys
import tempfile
import zipfile
from pathlib import Path

import shapefile
from pyproj import Transformer
from shapely import transform
from shapely.geometry import box, shape
from shapely.validation import make_valid

from build_bh_mosaic import OUT, polygons_only, rounded_shape


ROOT = Path(__file__).resolve().parents[1]
CELL_METERS = 400
to_utm = Transformer.from_crs(4326, 31983, always_xy=True)


def to_meters(geometry):
    return transform(geometry, to_utm.transform, interleaved=False)


def municipal_shapes():
    data = json.loads((OUT / "rmbh_cities.geojson").read_text(encoding="utf-8"))
    return {str(feature["properties"]["code"]): to_meters(shape(feature["geometry"]))
            for feature in data["features"]}


def source_features(contagem_path, betim_path):
    contagem = json.loads(Path(contagem_path).read_text(encoding="utf-8"))
    for feature in contagem["features"]:
        props = feature["properties"]
        yield "32", f"32:{props['OBJECTID']}", props["Nome_bairro"].strip().title(), to_meters(shape(feature["geometry"]))
    with tempfile.TemporaryDirectory() as directory:
        with zipfile.ZipFile(betim_path) as archive:
            archive.extractall(directory)
        path = next(Path(directory).glob("*.shp"))
        reader = shapefile.Reader(str(path), encoding="1252")
        for feature in reader.iterShapeRecords():
            props = feature.record.as_dict()
            yield "11", f"11:{props['PKIDBAIRRO']}", props["NOMBAIRRO"].strip().title(), shape(feature.shape.__geo_interface__)


def main(contagem_path, betim_path):
    cities = municipal_shapes()
    neighborhoods = []
    cells = []
    for city_code, code, name, source_shape in source_features(contagem_path, betim_path):
        if not source_shape.is_valid:
            source_shape = make_valid(source_shape)
        geometry = polygons_only(source_shape.intersection(cities[city_code]))
        if geometry.is_empty or geometry.area < 100:
            continue
        display = polygons_only(geometry.simplify(5, preserve_topology=True).intersection(cities[city_code]))
        props = {"code": code, "name": name, "cityCode": city_code}
        neighborhoods.append({"type": "Feature", "properties": props, "geometry": rounded_shape(display)})
        min_x, min_y, max_x, max_y = display.bounds
        for ix in range(math.floor(min_x / CELL_METERS), math.ceil(max_x / CELL_METERS)):
            for iy in range(math.floor(min_y / CELL_METERS), math.ceil(max_y / CELL_METERS)):
                clipped = polygons_only(display.intersection(box(
                    ix * CELL_METERS, iy * CELL_METERS,
                    (ix + 1) * CELL_METERS, (iy + 1) * CELL_METERS,
                )))
                if clipped.is_empty or clipped.area < 100:
                    continue
                cells.append({"type": "Feature", "properties": {"id": f"{code}:{ix}:{iy}", "code": code,
                    "cityCode": city_code}, "geometry": rounded_shape(clipped)})
    if len(neighborhoods) < 500 or len({feature["properties"]["code"] for feature in neighborhoods}) != len(neighborhoods):
        raise ValueError("A malha de bairros está incompleta ou contém códigos repetidos")
    OUT.mkdir(parents=True, exist_ok=True)
    for filename, features in (("metro_neighborhoods.geojson", neighborhoods),
                               ("metro_neighborhood_cells_400m.geojson", cells)):
        path = OUT / filename
        path.write_text(json.dumps({"type": "FeatureCollection", "features": features},
                                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(filename, len(features), path.stat().st_size)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Uso: python scripts/build_metro_neighborhoods.py contagem.geojson betim.zip")
    main(sys.argv[1], sys.argv[2])
