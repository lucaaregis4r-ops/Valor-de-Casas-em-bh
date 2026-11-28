@echo off
cd /d "%~dp0"
python .\scrape_imoveis_bh.py --source quintoandar --operation sale --max-pages 1000 --delay 0.45 --incremental --append --output moradias_bh_quintoandar_venda_2026.csv
echo.
echo Raspagem finalizada ou interrompida. O CSV foi salvo incrementalmente.
echo Para atualizar o painel, rode: python .\gerar_painel_unico_2021_2026.py
pause
