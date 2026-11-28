# Contexto do projeto

Este projeto compara imóveis de Belo Horizonte e região usando:

- `data.csv`: base antiga de imóveis, tratada como referência de 2021.
- `moradias_bh_quintoandar_venda_2026.csv`: anúncios de venda do QuintoAndar em 2026.
- `moradias_bh_quintoandar_aluguel_2026.csv`: anúncios de aluguel do QuintoAndar em 2026.
- `index.html`: painel principal interativo, com estilos, scripts e bases JSON em arquivos separados.

## Fluxo principal

Para continuar raspando vendas:

```powershell
python .\scrape_imoveis_bh.py --source quintoandar --operation sale --max-pages 1000 --delay 0.45 --incremental --append --output moradias_bh_quintoandar_venda_2026.csv
```

Para continuar raspando alugueis:

```powershell
python .\scrape_imoveis_bh.py --source quintoandar --operation rent --max-pages 5000 --delay 0.45 --incremental --append --output moradias_bh_quintoandar_aluguel_2026.csv
```

Ou clique em:

- `raspar_quintoandar_1000.bat`
- `raspar_quintoandar_aluguel_5000.bat`

O arquivo de aluguel faz append no CSV existente. Ele nao arquiva nem renomeia o arquivo anterior.

Depois de raspar, regenere os arquivos JSON consumidos pelo painel:

```powershell
python .\gerar_painel_unico_2021_2026.py
```

Sirva a pasta do projeto localmente (os módulos JavaScript e o `fetch` das bases precisam de HTTP):

```powershell
python -m http.server 8000
```

Depois abra `http://localhost:8000/`. O script grava `data/baseline/2021.json` e `data/baseline/2026.json`.

## Banco histórico (PR 2)

O modelo do observatório está em `pipeline/`:

- `listings` mantém a identidade e os dados estáveis do anúncio.
- `observations` guarda preço e disponibilidade por data.
- `collection_runs` registra início, fim, resultado e contagens de cada coleta.

Instale o driver PostgreSQL:

```powershell
python -m pip install -r requirements.txt
```

Defina `DATABASE_URL` no ambiente e aplique o esquema com:

```powershell
python -m pipeline.init_db
```

Em automações, a URL do banco deve ficar em um secret do GitHub Actions. Não grave credenciais no repositório.

Para rodar os testes sem um servidor PostgreSQL:

```powershell
python -m unittest discover -s tests -v
```

## Coletor estruturado (PR 3)

O primeiro coletor do pipeline consulta o sitemap público do QuintoAndar e lê os dados JSON-LD das páginas de aluguel da RMBH. Ele usa uma pausa de 1 segundo entre requisições e limita cada execução a 100 páginas por padrão. Um bloqueio HTTP ou limite de acesso encerra a execução sem tentativa de contorno.

Com o esquema inicializado e `DATABASE_URL` definido, execute:

```powershell
python -m pipeline.collect_quintoandar --max-pages 100 --delay-seconds 1
```

O comando registra a execução em `collection_runs`, mantém uma linha por anúncio e acrescenta uma observação de preço por coleta. Os fixtures locais de sitemap e JSON-LD ficam em `tests/fixtures/quintoandar/`.

## Automação e validação (PR 4)

O workflow `.github/workflows/collect-daily.yml` agenda a coleta para 05:00 no horário de Brasília e também permite execução manual pela aba **Actions** do GitHub. Antes de gravar observações, o pipeline valida o tamanho mínimo, compara quedas com a última coleta válida, verifica campos de localização, faixa de aluguel, taxa de leitura do JSON-LD, erros de normalização, truncamento, falhas parciais e duração. Por padrão, qualquer página de anúncio que falhe reprova a coleta; o limite pode ser alterado em `PIPELINE_MAX_PAGE_FAILURE_FRACTION`. Uma coleta reprovada fica marcada como `failed` em `collection_runs`; a validação ocorre antes de gravar observações.

Para ativar no GitHub, adicione `DATABASE_URL` em **Settings → Secrets and variables → Actions → New repository secret**. O workflow aplica as migrações idempotentes do PostgreSQL antes da coleta; `python -m pipeline.init_db` também pode ser executado manualmente. Os limites de coleta usam valores padrão no workflow e podem ser ajustados em **Actions variables** (`COLLECTOR_MAX_PAGES`, `PIPELINE_MIN_RECORDS` e demais variáveis `PIPELINE_*`).

## Agregados e JSON público (PR 5)

Depois de uma coleta válida, o workflow executa `python -m pipeline.export_public` e gera:

- `data/public/current.json`: anúncios observados na coleta válida mais recente de cada fonte;
- `data/public/neighborhood_daily.json`: oferta observada e estatísticas por data, cidade e bairro;
- `data/public/listing_events.json`: entrada, retirada e mudança de preço dos anúncios;
- `data/public/meta.json`: horário da última coleta válida, contagem de anúncios e estado das fontes.

`active` conta os anúncios presentes no último snapshot válido daquele dia. `new` conta a primeira observação válida do anúncio; reduções e aumentos comparam observações válidas consecutivas. Os percentis P25/P75 usam interpolação linear. As variações de 7 e 30 dias comparam a mediana de preço/m² com a data exata anterior; sem dados nessa data, o campo fica `null`. A variação descreve a mediana dos anúncios observados, não a valorização dos imóveis. `removed` conta observações explicitamente indisponíveis; um 404 só retira um anúncio já conhecido depois que a coleta inteira passa na validação.

Os arquivos são validados antes de substituir os existentes. O mapa carrega esses JSONs por `assets/js/public-data.js`. `current.json` inclui o primeiro registro, cada mudança de aluguel/condomínio e a observação mais recente em `price_history`; as linhas diárias incluem centroides para mapear períodos passados. Para a publicação automática, configure **Settings → Pages → Build and deployment → Source → GitHub Actions**. O workflow publica a pasta do site diretamente, além de versionar os JSONs.

## Modo diário (PR 6)

A aba **Mercado diário** usa um calendário principal e uma data opcional de comparação. O mapa mostra a data principal, e o painel compara oferta, medianas de bairro e eventos entre as duas datas. As camadas incluem aluguel/m², oferta ativa, novos, retirados, reduções, aumentos e variações de 7/30 dias. As estatísticas respeitam cidade e bairro; o filtro de tipo fica oculto porque os agregados diários ainda combinam os tipos. Em datas históricas, os pontos são agregados nos centroides dos bairros. Na data mais recente, a camada de oferta usa os anúncios individuais e exibe fonte, período observado, dias acompanhados, histórico de preços e link original.

Para gerar os arquivos manualmente com `DATABASE_URL` configurada:

```powershell
python -m pipeline.export_public --output-dir data/public
```

## Robustez operacional (PR 7)

- `data/geocoding_cache.json` guarda centros aproximados por cidade e bairro a partir das coordenadas já fornecidas pelas páginas. O coletor usa esse cache somente quando faltam coordenadas no anúncio; o campo `location_precision` distingue essa posição aproximada da coordenada original. O cache é atualizado apenas após uma coleta validada e pode ser configurado com `GEOCODING_CACHE_PATH` ou `--geocoding-cache`.
- `collection_runs.metrics_json` mantém páginas tentadas, falhas, taxa de parse, erros de normalização, tempo de execução, resultados e uso do cache. Cada snapshot aprovado grava anúncios e retiradas em uma única transação; se uma gravação falhar, o lote inteiro é revertido. `meta.json` publica um resumo por fonte (`healthy`, `degraded`, `failed` ou `running`) sem expor mensagens internas de erro.
- Se a coleta falhar após registrar o estado no banco, o workflow ainda exporta e publica o último snapshot válido, junto com o estado de falha. A execução do Actions permanece vermelha e grava um resumo da coleta/exportação/publicação. Para receber e-mail, acompanhe o repositório e habilite notificações de falha de workflows nas [preferências de notificações do GitHub](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs).
- `current.json`, `neighborhood_daily.json`, `listing_events.json` e `meta.json` são serializados sem espaços de indentação e validados antes da troca atômica dos arquivos.

## Métricas no painel

O painel inclui:

- preço de venda 2021;
- preço de venda 2026;
- delta 2021-2026;
- preço de aluguel;
- aluguel por metro quadrado;
- condomínio médio;
- índice de condominização: condomínio médio da área / aluguel médio da área.

## Cuidados

- Nao rode corretor e raspador no mesmo CSV ao mesmo tempo.
- Use sempre `--append` para continuar uma base existente.
- O campo `adm-fees` guarda o valor de condomínio.
- O raspador imprime no terminal se o anúncio veio com condomínio e se é `apartment`, `house` ou `kitnet`.
- O CSV de venda e o CSV de aluguel foram consolidados por URL única para evitar duplicados.
