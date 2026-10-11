# metrics-sync

Este serviço sincroniza as métricas dos posts de um criador. O provedor é simulado. O token é fictício.

## Como rodar

Use Node 20 ou mais novo.

```bash
npm install
npm test
npm run typecheck
npm start
```

`npm start` abre a API na porta 3000. O provedor simulado tem três posts de outubro de 2026.

```bash
curl -X POST localhost:3000/connections -H 'content-type: application/json' -d '{"platform":"instagram","accessToken":"token-ficticio"}'
curl -X POST localhost:3000/connections/<id>/sync -H 'content-type: application/json' -d '{"from":"2026-10-01T00:00:00Z","to":"2026-10-10T00:00:00Z"}'
curl localhost:3000/connections/<id>/posts
```

## API

| Rota | O que faz |
| --- | --- |
| `POST /connections` | Registra a conexão e devolve o `id`. |
| `POST /connections/:id/sync` | Sincroniza os posts publicados em `[from, to)`. |
| `GET /connections/:id/posts` | Lista os posts em páginas. |

O sync roda dentro da requisição. A resposta é 200 quando o sync termina, 502 quando o provedor falha e 503 com `Retry-After` quando o provedor limita a taxa.

A listagem aceita `limit` (padrão 50, máximo 200) e `cursor`. A resposta traz `nextCursor` quando existe outra página.

## Idempotência

O código está em [src/store.ts](src/store.ts).

- O provedor manda contadores absolutos. O serviço substitui o número e nunca soma.
- Cada post tem uma linha. A chave é `(connection_id, post_id)`.
- Post repetido, página repetida, sync refeito e janela sobreposta gravam na mesma linha.
- O serviço ignora um snapshot mais velho que o gravado. A comparação usa `measured_at`.
- `measured_at` é a hora da medição no provedor. `fetched_at` é a hora da busca.
- O serviço grava cada página quando ela chega. Se o sync falhar, repita a janela.

## Retry e 429

O código está em [src/sync-service.ts](src/sync-service.ts).

| Limite | Padrão |
| --- | --- |
| Tentativas por página | 4 |
| Backoff | 1 s, dobra até 30 s |
| Maior `Retry-After` aceito | 60 s |

- Timeout e 5xx: o sync espera o backoff e tenta de novo.
- 429: o sync espera o `Retry-After` exato. O valor pode vir em segundos ou como data HTTP.
- `Retry-After` maior que o teto: o sync não espera. Ele para com `rate_limited` e devolve `retryAt`.
- Depois de 4 tentativas na mesma página, o sync para.
- Outro 4xx, corpo inválido ou cursor repetido: o sync para sem tentar de novo.

Os testes usam um relógio falso no lugar de [src/clock.ts](src/clock.ts). Os testes de 429 estão em [test/retry.test.ts](test/retry.test.ts).

## Provedor e regra de negócio

- [metrics-provider.ts](src/provider/metrics-provider.ts) é a interface. A regra de negócio só conhece este arquivo.
- [http-metrics-provider.ts](src/provider/http-metrics-provider.ts) é o adaptador. Ele lê status, headers e JSON.
- [fake-transport.ts](src/provider/fake-transport.ts) é o provedor simulado. Ele responde como um servidor HTTP e aceita um roteiro de falhas.

## Fora do escopo

- Sync em segundo plano. Hoje a requisição espera o sync terminar.
- Histórico de snapshots. O serviço guarda só o número atual.
- Trava contra dois syncs da mesma conexão ao mesmo tempo.
- Retomada pelo cursor depois de uma falha.
- Jitter no backoff e limite de taxa compartilhado entre conexões.
- Autenticação de quem chama a API. Hoje quem sabe o `id` da conexão pode sincronizar e listar.
- OAuth e criptografia do token.
- Formato próprio de cada rede.

## Uso de IA

O Claude Code escreveu o código, os testes e este README.

Eu defini o desenho: a stack, o comportamento do 429 acima do teto, o corte de escopo e a paginação da listagem. Eu li trechos de `src/store.ts`, `src/clock.ts` e `src/sync-service.ts` e pedi mudanças. Eu pedi o `EXPLAIN` das queries e os testes de carga. Não revisei o resto do código linha a linha.
