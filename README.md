# Backend Gelinsorteio G

API para gerenciar bilhetes da rifa.

## Como rodar

### 1. Instalar dependências
```bash
cd gelinsorteio-backend
npm install
```

### 2. Iniciar servidor
```bash
npm start
```

Ou em modo desenvolvimento (auto-reload):
```bash
npm run dev
```

## Endpoints

### GET /api/health
Verifica se o backend está rodando.

### GET /api/stats
Retorna estatísticas da rifa:
```json
{
  "sold": 150,
  "total": 20000,
  "percent": 1,
  "available": 19850
}
```

### POST /api/buy
Compra bilhetes. Body:
```json
{
  "quantity": 10,
  "buyerEmail": "opcional@email.com"
}
```

Resposta:
```json
{
  "success": true,
  "purchaseId": "uuid-aqui",
  "tickets": ["03847", "12903", "00561"],
  "total": 10
}
```

### GET /api/purchase/:id
Busca uma compra pelo ID.

### GET /api/purchases
Lista todas as compras (admin).

### POST /api/reset
Reseta o banco de dados (admin - cuidado!).

## Banco de dados

O backend usa um arquivo JSON local (`db.json`) para armazenar os dados. É simples e suficiente para rifas pequenas. Para produção com muito tráfego, considere migrar para um banco real (MongoDB, PostgreSQL, etc.).

## Integrar com o frontend

No `app.js` do frontend, troque a lógica local por chamadas à API:

```javascript
// Exemplo: comprar bilhetes
async function buyTickets(quantity) {
    const response = await fetch('http://localhost:3000/api/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity })
    });
    const data = await response.json();
    
    if (data.success) {
        // Mostrar bilhetes na tela
        showSuccessModal(data.tickets, data.total);
    }
}
```
