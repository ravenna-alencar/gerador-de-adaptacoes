# Gerador de Adaptações

Ferramenta interna da Gocase que **adapta estampas para os diferentes tamanhos/máscaras de produto**.
Reposiciona a arte de um **PSD em camadas** com fidelidade total (100% no navegador, sem IA) e, como
fluxos secundários, recompõe via IA e cruza dados de vendas/cobertura do catálogo.

- **Plataforma:** GoDeploy (Cloudflare Workers) — `appId: 2cf259c9`
- **URL:** https://gerador-de-adaptacoes.devgogroup.com/ (acesso `authenticated`, login Google Gogroup)

> A documentação técnica completa está em [`CLAUDE.md`](./CLAUDE.md).

## Estrutura

```
src/server.ts        # worker: rotas /api/*, /img, registro PRODUTOS, SQL
public/
  index.html         # frontend inteiro (HTML + CSS + JS inline, sem build)
  favicon.svg
  vendor/ag-psd.js   # leitor de PSD (UMD, vendorizado)
package.json
CLAUDE.md            # documentação / decisões
```

## Segredos

Tokens **não** ficam no código — são secrets do GoDeploy (`setAppSecret`), injetados como `env` do worker:
`PIAPP_TOKEN`, `AI_PROXY_TOKEN`, `METABASE_TOKEN`, `PROXY_BASE_URL`.

## Deploy

O app = `src/server.ts` (entrypoint) + assets estáticos. Sempre subir todos os arquivos (o upload
substitui o app inteiro): `getUploadToken` → `curl` (multipart) → `updateApp`. Detalhes em `CLAUDE.md`.
