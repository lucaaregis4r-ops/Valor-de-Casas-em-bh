#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ ! -f .env ]]; then
  echo "Arquivo .env ausente. Copie .env.example para .env e configure a senha local do banco." >&2
  exit 2
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

PYTHON="$PROJECT_ROOT/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  python3 -m venv .venv
  "$PROJECT_ROOT/.venv/bin/python" -m pip install -r requirements.txt
fi

docker compose up -d postgres

ready=0
for attempt in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  echo "PostgreSQL local não ficou pronto após 120 segundos." >&2
  exit 3
fi

git pull --ff-only origin main
"$PYTHON" -m pipeline.init_db

collect_status=0
"$PYTHON" -m pipeline.collect_quintoandar \
  --max-pages "${COLLECTOR_MAX_PAGES:-5000}" \
  --delay-seconds "${COLLECTOR_DELAY_SECONDS:-1}" \
  --min-records "${PIPELINE_MIN_RECORDS:-50}" \
  --max-drop-percent "${PIPELINE_MAX_DROP_PERCENT:-70}" \
  --max-invalid-fraction "${PIPELINE_MAX_INVALID_FRACTION:-0.05}" \
  --max-page-failure-fraction "${PIPELINE_MAX_PAGE_FAILURE_FRACTION:-0}" \
  --min-parse-success-fraction "${PIPELINE_MIN_PARSE_SUCCESS_FRACTION:-0.8}" \
  --min-monthly-rent "${PIPELINE_MIN_MONTHLY_RENT:-100}" \
  --max-monthly-rent "${PIPELINE_MAX_MONTHLY_RENT:-100000}" \
  --max-duration-seconds "${PIPELINE_MAX_DURATION_SECONDS:-7200}" || collect_status=$?

# Export even after a rejected collection so the public health status is updated
# while the last accepted snapshot remains intact.
"$PYTHON" -m pipeline.export_public --output-dir data/public

"$PYTHON" - <<'PY'
import json
from pathlib import Path

directory = Path("data/public")
for filename, expected_type in (
    ("current.json", list),
    ("neighborhood_daily.json", list),
    ("listing_events.json", list),
    ("meta.json", dict),
):
    payload = json.loads((directory / filename).read_text(encoding="utf-8"))
    if not isinstance(payload, expected_type):
        raise SystemExit(f"Estrutura inválida em {filename}")
print("Arquivos públicos JSON validados.")
PY

git add data/public/current.json data/public/neighborhood_daily.json \
  data/public/listing_events.json data/public/meta.json data/geocoding_cache.json
if ! git diff --cached --quiet; then
  git commit -m "Atualiza dados públicos do observatório"
fi
git push origin HEAD:main

exit "$collect_status"
