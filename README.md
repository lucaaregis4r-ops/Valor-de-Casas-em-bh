# Moradia BH

Observatório cartográfico do mercado residencial de Belo Horizonte. O site estático apresenta ambientes separados:

- **Mapa:** entrada cartográfica com acesso ao Atlas e ao Mercado Agora.
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

As bases históricas ficam em `data/baseline/2021.json` e `2026.json`. Os snapshots de anúncios e os agregados diários ficam em `data/public/`. O Atlas compara medianas de anúncios de **venda**; o Mercado Agora descreve principalmente anúncios observados de **aluguel**. Essas medidas não formam uma única série temporal. Amostras insuficientes são identificadas nos perfis e na comparação.

O coletor mantém o histórico local em PostgreSQL e atualiza os JSONs públicos usados pelo site.

## Execução diária neste computador

O agendamento roda às 05:00 no fuso horário do sistema (`America/Sao_Paulo`). A coleta pode levar até 4 horas antes de ser interrompida; o computador precisa permanecer ligado e conectado à internet. O PostgreSQL roda em um contêiner Docker local, limitado a `127.0.0.1`, com volume persistente.

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

```bash
scripts/run_local_daily.sh
```

As opções da coleta e seus limites podem ser ajustados em `.env`. Uma coleta rejeitada não substitui os dados aceitos anteriormente; o script ainda exporta e envia o estado de saúde da fonte.
