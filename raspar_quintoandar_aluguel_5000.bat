@echo off
cd /d "%~dp0"
python .\scrape_imoveis_bh.py --source quintoandar --operation rent --max-pages 5000 --delay 0.45 --incremental --append --output moradias_bh_quintoandar_aluguel_2026.csv
echo.
echo Raspagem de alugueis finalizada ou interrompida.
echo O CSV foi somado em moradias_bh_quintoandar_aluguel_2026.csv, sem arquivar o anterior.
echo Para atualizar o painel, rode: python .\gerar_painel_unico_2021_2026.py
pause
