# Observatório diário de aluguéis de Belo Horizonte

O mapa combina as bases históricas de 2021 e 2026 com anúncios públicos de aluguel. O coletor mantém um histórico local em PostgreSQL e atualiza os JSONs que o mapa usa.

## Execução diária neste computador

O agendamento roda às 05:00 no fuso horário do sistema (`America/Sao_Paulo`). O computador precisa estar ligado e conectado à internet. O PostgreSQL roda em um contêiner Docker local, limitado a `127.0.0.1`, com volume persistente.

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
