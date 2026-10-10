# Moradia BH

Observatório cartográfico do mercado residencial de Belo Horizonte. O site estático apresenta ambientes separados:

- **Mapa:** mosaico das 34 cidades da RMBH; BH abre seus bairros e as demais cidades abrem uma grade de regiões internas.
- **Atlas:** anúncios históricos de venda de 2021 e 2026, variação da mediana do preço pedido por m², rankings, camadas de aluguel da base 2026 e comparação entre bairros.
- **Mercado Agora:** anúncios ativos de aluguel, eventos e agregados das coletas recentes, com data e comparação opcional entre coletas.
- **Bairros:** índice e perfis que mostram o histórico de venda e a oferta atual de aluguel em blocos distintos.
- **Metodologia:** fontes, períodos e limites de interpretação.

A navegação usa fragmentos (`#/atlas`, `#/agora`, `#/bairro/santa-tereza`) para funcionar no GitHub Pages sem configuração de servidor. Para pré-visualizar localmente:

```bash
python3 -m http.server 8000
```

Abra `http://localhost:8000`. Abrir o HTML diretamente como arquivo pode impedir o carregamento dos JSONs.

O frontend está em `index.html` e `assets/css/app.css`. `assets/js/app.js` concentra as camadas do Atlas e a navegação; `daily-market.js` contém o Mercado Agora; `neighborhoods.js` contém índice, perfis e comparação de bairros. `map.js`, `filters.js`, `statistics.js` e `public-data.js` compartilham mapa, filtros, cálculos e carregamento. O pipeline de coleta permanece em `pipeline/`.

## Mosaico metropolitano

A página **Mapa** usa os limites das 34 cidades do conjunto [Municípios RMBH da Fundação João Pinheiro/PBH](https://ckan.pbh.gov.br/dataset/municipio-rmbh), recurso `20260101_municipio_rmbh`, e os limites de 493 bairros, conjuntos e vilas de BH do [Bairro Popular da PBH/Prodabel](https://ckan.pbh.gov.br/dataset/bairro-popular), recurso `20240902_bairro_popular`, ambos CC BY. As malhas originais em EPSG:31983 foram convertidas para GeoJSON (EPSG:4326). As cidades fora de BH foram subdivididas em células de 1 km e os bairros de BH em células de 400 m, sempre recortadas pelos respectivos limites. A grade municipal não representa bairros oficiais. Os arquivos publicados estão em `data/geography/`; `assets/js/mosaic.js` cruza as coordenadas dos anúncios com as malhas durante o carregamento do site.

Clique numa cidade ou use o seletor **Cidade** para abrir seu mapa. Em BH, clique num bairro ou use o seletor **Bairro** para ver suas regiões de 400 m. O seletor de preços alterna venda 2021, venda 2026, aluguel da base 2026 e aluguel ativo. As cores representam a mediana do preço pedido por m²; cidades e bairros precisam de pelo menos 5 anúncios e células de pelo menos 3 para receber cor. Pontos com coordenadas podem ser exibidos no detalhe. Anúncios do Mercado Agora com `location_precision=neighborhood` entram apenas no total da cidade ou do bairro, sem criar uma falsa distribuição dentro da grade. A posição informada por uma fonte também pode ser aproximada; confira o endereço original antes de interpretar uma célula como localização exata.

A classificação segue anúncio → coordenadas → polígono do município → polígono do bairro → célula interna. O nome do bairro escrito no anúncio não precisa constar na malha: quando a coordenada cai em um polígono, a classificação usa esse polígono. Para posições explicitamente aproximadas pelo bairro, o nome informado só é usado como alternativa quando a coordenada não encontra um polígono. O mapa informa quantos anúncios ficam fora da malha metropolitana, quantos entram em BH mas não caem em um bairro e quantos entram no bairro mas não em uma célula; esses anúncios continuam nos totais da área mais ampla em que foi possível localizá-los.

No detalhe de um bairro de BH, as células são translúcidas para manter as ruas legíveis. A escala de cores usa os preços mínimo e máximo das células com amostra **dentro do bairro selecionado**; uma mesma cor em bairros distintos não implica o mesmo preço. As três regiões de maior mediana aparecem numeradas e no ranking abaixo do mapa, com aproximação por clique. Os pontos individuais ficam ocultos inicialmente e podem ser ativados no detalhe. Um mapa de calor por densidade de anúncios foi evitado porque destacaria concentração de ofertas, que não equivale necessariamente às regiões mais caras.

Para atualizar a malha, baixe o CSV da PBH e execute:

```bash
.venv/bin/python -m pip install shapely pyproj
.venv/bin/python scripts/build_bh_mosaic.py 20240902_bairro_popular.csv
.venv/bin/python scripts/build_rmbh_mosaic.py 20260101_municipio_rmbh.csv
```

Os scripts geram as quatro malhas GeoJSON; `shapely` e `pyproj` são dependências apenas dessa etapa de geração, não do site publicado.

As bases históricas ficam em `data/baseline/2021.json` e `2026.json`. Os snapshots de anúncios e os agregados diários ficam em `data/public/`. O Atlas compara medianas de anúncios de **venda**; o Mercado Agora descreve principalmente anúncios observados de **aluguel**. Essas medidas não formam uma única série temporal. Amostras insuficientes são identificadas nos perfis e na comparação.

O coletor mantém o histórico local em PostgreSQL e atualiza os JSONs públicos usados pelo site.

## Execução diária neste computador

O agendamento roda às 03:00 no fuso horário do sistema (`America/Sao_Paulo`). A coleta pode levar até 4 horas antes de ser interrompida; o computador precisa permanecer ligado e conectado à internet. O PostgreSQL roda em um contêiner Docker local, limitado a `127.0.0.1`, com volume persistente.

Na primeira configuração, o usuário local cria `.env` a partir de `.env.example`, define uma senha longa para o banco e executa:

```bash
docker compose up -d postgres
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
scripts/run_local_daily.sh
```

O script aplica o esquema, coleta e valida anúncios, gera `data/public/*.json`, registra apenas esses artefatos e o cache geográfico no Git, e envia atualizações para `main`. O GitHub Pages publica o site a partir da branch `main`.

Para consultar o log do agendamento:

```bash
tail -f logs/local_daily.log
```

O histórico completo fica no volume Docker `observatorio_postgres_data`; não é versionado no Git. `.env` também é local e ignorado pelo Git.

## Rodar manualmente

Clique em `Executar coleta manual.sh` na pasta do projeto ou no atalho `Executar coleta Moradia BH` na área de trabalho. Uma janela de terminal mostra o andamento e mantém o resultado visível até você pressionar Enter. O registro fica em `logs/manual_*.log`.

Durante a coleta, o terminal mostra cada anúncio lido com ID, bairro e aluguel. Os dados só são publicados depois que o lote completo passa pela validação.
Para interromper uma execução manual, pressione `Ctrl+C` no terminal. A interrupção é registrada no histórico; uma nova execução começa do início.

Também é possível executar no terminal:

```bash
./Executar\ coleta\ manual.sh
```

As opções da coleta e seus limites podem ser ajustados em `.env`. Uma coleta rejeitada não substitui os dados aceitos anteriormente; o script ainda exporta e envia o estado de saúde da fonte.
