#!/usr/bin/env bash
set -uo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT" || exit 1
mkdir -p logs
LOG_FILE="logs/manual_$(date +%Y-%m-%d_%H-%M-%S).log"

echo "Iniciando coleta manual. Registro: $LOG_FILE"

# A coleta iniciada antes da instalação do bloqueio ainda pode estar rodando.
if pgrep -u "$(id -u)" -f 'python -m pipeline[.]collect_quintoandar' >/dev/null; then
  echo "Já existe uma coleta em andamento. Aguarde o término antes de executar outra." | tee -a "$LOG_FILE"
  status=4
else
  bash scripts/run_local_daily.sh 2>&1 | tee -a "$LOG_FILE"
  status=${PIPESTATUS[0]}
fi

if (( status == 0 )); then
  echo "Coleta concluída e arquivos públicos enviados. Registro: $LOG_FILE"
else
  echo "Coleta não concluída (código $status). Consulte o registro: $LOG_FILE"
fi

if [[ -t 0 ]]; then
  read -r -p "Pressione Enter para fechar esta janela..." _ || true
fi
exit "$status"
