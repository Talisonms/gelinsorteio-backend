# Gelin Sorteio 🎰

Site de rifa para iPhone 18 Pro Max 256GB ou R$ 7.000 no Pix.

## Estrutura

```
gelinsorteio/
├── index.html      # Página principal
├── style.css       # Estilos
├── app.js          # Lógica (compra, Pix, progresso)
└── assets/
    └── iphone-hero.jpg  # Foto do iPhone
```

## Como colocar no ar

### Opção 1: Netlify (mais fácil)
1. Acesse https://www.netlify.com
2. Arraste a pasta `gelinsorteio` pra dentro do site
3. Pronto — seu site está no ar

### Opção 2: Vercel
1. Acesse https://vercel.com
2. Importe a pasta como projeto
3. Deploy automático

### Opção 3: GitHub Pages
1. Crie um repositório no GitHub
2. Suba os arquivos
3. Ative Pages nas configurações do repo

## Configurar o Mercado Pago

1. Acesse https://www.mercadopago.com.br/developers
2. Crie uma conta (grátis)
3. Vá em "Suas integrações" → "Criar aplicação"
4. Copie o **Access Token**
5. Abra `app.js` e cole no campo `MERCADO_PAGO_ACCESS_TOKEN`
6. Mude `MP_TEST_MODE` para `false` quando quiser receber de verdade

## Configurar seu Pix

No `app.js`, altere:
- `PIX_KEY`: seu CPF, CNPJ, e-mail ou chave aleatória
- `PIX_NAME`: nome que aparece pro comprador
- `PIX_CITY`: sua cidade

## Personalizar

- **Nome da campanha**: mude `CAMPAIGN_NAME` no `app.js`
- **Total de bilhetes**: mude `TOTAL_TICKETS`
- **Preço do bilhete**: mude `TICKET_PRICE`
- **Cores**: edite as variáveis CSS no topo do `style.css`

## Importante

- O site salva os bilhetes vendidos no `localStorage` do navegador
- Para produção real, você precisará de um backend (ou usar o Mercado Pago como fonte de verdade)
- O sorteio em 100% é manual: quando a barra chegar lá, você faz o sorteio e anuncia
