# @bfocus/monitor-node

Monitoramento de erros do [bFocus](https://bfocus.com.br) para Node.js ≥ 18. Os erros não tratados
do seu sistema chegam ao bFocus, são agrupados pela causa entre todos os clientes e viram demanda
para a equipe — com a versão do sistema, o ambiente e o cliente afetado.

Zero dependências. Nunca derruba o app: toda falha do monitor é engolida, o envio é em segundo
plano e o processo termina exatamente como terminaria sem ele.

## Instalar

```sh
npm install @bfocus/monitor-node
```

## Ligar (uma linha)

```js
const monitor = require('@bfocus/monitor-node') // ou: import * as monitor from '@bfocus/monitor-node'

monitor.init({
  key: 'bf_mon_…',                                   // a chave do agente (painel → Monitoramento → Agentes)
  release: process.env.APP_VERSION,                  // a versão do seu sistema
  environment: process.env.NODE_ENV,                 // padrão: production
  signingSecret: process.env.BFOCUS_SIGNING_SECRET,  // assina a identidade sozinho (ver abaixo)
})
```

Isso já captura `uncaughtException` (nível `fatal`: envia com teto de 2 s, imprime o erro e sai
com código 1, como o Node faria) e `unhandledRejection` (no modo padrão do Node o processo cai do
mesmo jeito; com `--unhandled-rejections=warn`/`none` só registra). O que estiver na fila sai no
`beforeExit`. Um sinal de vida sai no `init` e a cada 5 min (timer que não segura o processo),
para o painel saber que o agente está rodando mesmo sem erro.

Opções: `key` (obrigatória), `release`, `environment`, `baseUrl`, `sampleRate` (0..1), `ignore`
(textos ou RegExp), `beforeSend(event)` (devolva o evento alterado ou `null` para descartar),
`signingSecret`, `autoCapture` (padrão `true`), `inAppPrefixes` (caminhos que são do seu sistema
mesmo dentro de `node_modules`, ex.: pacotes do monorepo).

## Framework

**Express** — a identidade fica presa à requisição, e o erro leva a rota (`GET /pedidos/:id`):

```js
app.use(monitor.expressRequestHandler()) // antes das rotas
// ...rotas...
app.use(monitor.expressErrorHandler())   // depois das rotas; captura e repassa com next(err)
```

**Fastify**

```js
await app.register(monitor.fastifyMonitor)
```

**Next.js / serverless** — captura, espera o envio (até 2 s) e relança:

```js
export default monitor.withMonitor(async (req, res) => { /* ... */ })
```

Erros 4xx (`status`/`statusCode` < 500) não viram evento nas integrações. No Express, mude com
`expressErrorHandler({ shouldHandle: (err) => true })`.

## Quem foi afetado

O bFocus só liga o erro ao cliente e à pessoa com a identidade assinada (a mesma assinatura v2 do
widget). Com `signingSecret`, basta:

```js
monitor.setUser(user.id, user.companyId)   // dentro da requisição (vale só para ela)
```

Sem `signingSecret`, mande a assinatura pronta: `monitor.setUser(userId, customerId, userHash)`.
Fora de uma requisição (sem `expressRequestHandler`/`fastifyMonitor`/`withMonitor`), use
`monitor.withContext(() => ...)` para não misturar usuários. `monitor.signUserHash(secret, userId,
customerId)` calcula a assinatura para entregar ao front.

## Manual

```js
monitor.captureException(err, { level: 'warning', tags: { modulo: 'fiscal' }, fingerprint: ['nf', 'timeout'] })
monitor.captureMessage('estoque negativo', 'info')
monitor.setTag('modulo', 'fiscal')
monitor.addBreadcrumb('http', 'GET /api/x 500', 'error')
await monitor.flush(2000) // CLI e scripts: espera o envio
await monitor.close()
```

## Envio

Lote a cada 1 s ou 20 eventos; 429/5xx/rede → uma nova tentativa depois de 2 s; 401/403 → para de
enviar até o próximo `init`. O mesmo erro sai no máximo uma vez a cada 30 s, e no máximo 100
eventos por minuto. Exceção encadeada (`cause`): vai a causa raiz, com a externa na mensagem
(`" (dentro de: Tipo: mensagem)"`). O pacote não manda corpo de requisição, cookies, headers nem query string.

## Licença

MIT — Berni Software.
