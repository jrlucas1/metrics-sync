# metrics-sync

Serviço que recebe uma conexão já autorizada de um criador e sincroniza as métricas dos posts a partir de um provedor. O provedor é simulado e o token é fictício.

## Como rodar

Precisa de Node 20 ou mais novo.

```bash
npm install
npm test
npm run typecheck
npm start
```

`npm start` sobe a API na porta 3000 com um provedor simulado que tem três posts de outubro de 2026. `PORT` e `DB_PATH` mudam a porta e o arquivo do SQLite.

```bash
curl -X POST localhost:3000/connections -H 'content-type: application/json' -d '{"platform":"instagram","accessToken":"token-ficticio"}'
curl -X POST localhost:3000/connections/<id>/sync -H 'content-type: application/json' -d '{"from":"2026-10-01T00:00:00Z","to":"2026-10-10T00:00:00Z"}'
curl localhost:3000/connections/<id>/posts
```

## API

| Rota | O que faz |
| --- | --- |
| `POST /connections` | Registra a conexão (`platform`, `accessToken`) e devolve o `id`. |
| `POST /connections/:id/sync` | Sincroniza os posts publicados em `[from, to)` e devolve o resultado. |
| `GET /connections/:id/posts` | Lista os posts com os números, `measuredAt` e `fetchedAt`. |

O sync roda dentro da requisição. A resposta é 200 quando conclui, 502 quando o provedor falha e 503 com `Retry-After` quando o provedor limitou a taxa por mais tempo do que o serviço aceita esperar. O corpo traz `status`, `providerCalls`, `postsReceived`, `postsSaved`, o erro e, no caso de limite de taxa, `retryAt`.

## Idempotência

O provedor devolve contadores absolutos (o post tem 180 views), não deltas. Por isso gravar um snapshot é substituir os números do post, nunca somar.

A tabela `post_metrics` tem uma linha por post, com chave primária `(connection_id, post_id)`. Cada snapshot entra por um `INSERT ... ON CONFLICT DO UPDATE` em [src/store.ts](src/store.ts). O mesmo post pode chegar de novo de quatro jeitos: repetido na mesma página, numa página repetida, num sync refeito ou numa janela que se sobrepõe à anterior. Os quatro caem na mesma linha.

O update só acontece se o `measured_at` que chega for igual ou mais novo que o gravado. Um snapshot velho que chega atrasado é ignorado e o número não regride. Em empate de `measured_at` vale o último recebido.

Cada linha guarda dois horários. `measured_at` é quando o provedor mediu os números. `fetched_at` é quando este serviço buscou, lido do relógio injetado no momento em que a página é gravada.

As páginas são gravadas conforme chegam, cada uma em uma transação. Se o sync parar na terceira página, as duas primeiras ficam no banco, e refazer a janela não duplica nada.

## Retry e 429

As regras estão em [src/sync-service.ts](src/sync-service.ts) e os limites em `SyncConfig`.

| Limite | Padrão |
| --- | --- |
| `maxAttempts`, chamadas por página contando a primeira | 4 |
| `backoffBaseMs` e `backoffMaxMs` | 1 s, dobrando até 30 s |
| `maxRetryAfterMs`, maior `Retry-After` aceito | 60 s |

Timeout e 5xx são transitórios. O sync espera o backoff e tenta de novo, até `maxAttempts`. Depois disso encerra com `failed`.

No 429 o adaptador lê o `Retry-After`, em segundos ou como data HTTP, e o sync espera exatamente esse prazo antes da próxima tentativa. O 429 conta como tentativa. Sem `Retry-After`, ou com um valor ilegível, a espera é a do backoff.

Se o `Retry-After` for maior que `maxRetryAfterMs`, o sync não espera. Ele encerra com `rate_limited` e devolve em `retryAt` o horário a partir do qual o provedor aceita nova chamada. Esperar só até o teto e tentar gastaria uma tentativa em outro 429.

Outros 4xx e respostas com corpo inválido encerram o sync na hora, sem retry. Um cursor repetido pelo provedor também encerra, para a paginação não girar para sempre.

O serviço nunca chama `setTimeout` direto. Ele usa a interface `Clock` de [src/clock.ts](src/clock.ts), e os testes passam um relógio falso que registra cada espera e avança o tempo. Os testes de 429 estão em [test/retry.test.ts](test/retry.test.ts).

## Fronteira entre o provedor e a regra de negócio

[src/provider/metrics-provider.ts](src/provider/metrics-provider.ts) é tudo o que a regra de negócio conhece de um provedor: a interface `MetricsProvider`, os tipos de página e snapshot e o `ProviderError` com cinco tipos de erro. Do provedor, o serviço de sync importa só esse arquivo.

[src/provider/http-metrics-provider.ts](src/provider/http-metrics-provider.ts) é o adaptador. Ele monta a requisição, valida o JSON e traduz status e headers para `ProviderError`. O `Retry-After` é lido ali.

[src/provider/fake-transport.ts](src/provider/fake-transport.ts) é o provedor simulado. Ele responde com status, headers e corpo, como um provedor real responderia, e aceita um roteiro de respostas para simular timeout, 429 e erro. Trocar o provedor simulado por um real significa escrever outro `ProviderTransport` com `fetch`. As quatro redes entrariam como adaptadores da mesma interface.

## O que ficou de fora

- Sync em segundo plano. Uma requisição pode ficar presa por alguns minutos no pior caso de esperas. Em produção o sync iria para uma fila, e o `retryAt` serviria para reagendar.
- Histórico de snapshots. Só o estado atual de cada post é guardado.
- Trava contra dois syncs simultâneos da mesma conexão. Eles não duplicam nem regridem números por causa da chave e da regra do `measured_at`, mas gastam chamadas do provedor em dobro.
- Retomada pelo cursor. Um sync que falha recomeça a janela do início.
- Jitter no backoff.
- OAuth, renovação de token e criptografia do token, que hoje fica em texto puro no SQLite.
- Formato próprio de cada rede. Existe um formato de resposta só, o do provedor simulado.

## Uso de IA

O código, os testes e este README foram escritos com o Claude Code, a partir de uma conversa em que eu defini o desenho.

As decisões foram minhas: TypeScript com Fastify, Vitest e SQLite; encerrar o sync em vez de esperar quando o `Retry-After` passa do teto; e cortar do escopo a fila, o histórico e a retomada pelo cursor, que eu tinha pedido antes, para ficar no que o enunciado avalia.

Ainda não revisei o código. Até aqui a minha parte foi o desenho.
