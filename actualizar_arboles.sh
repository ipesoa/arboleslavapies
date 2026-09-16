#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
python3 -m pip install -r requirements.txt
python3 scripts/import_madrid.py --barrio EMBAJADORES --out docs/data/trees.geojson
echo "Listo: docs/data/trees.geojson actualizado."
