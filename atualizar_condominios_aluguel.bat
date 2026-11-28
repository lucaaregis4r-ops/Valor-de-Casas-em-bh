@echo off
cd /d "%~dp0"
python .\atualizar_condominios_aluguel.py
echo.
echo Atualizacao finalizada ou interrompida.
echo O arquivo corrigido fica em: moradias_bh_quintoandar_aluguel_2026_corrigido.csv
echo Depois rode: python .\gerar_painel_unico_2021_2026.py
pause
