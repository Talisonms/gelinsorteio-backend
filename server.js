const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// ASAAS CONFIG
// ============================================
const ASAAS_API_KEY = process.env.ASAAS_API_KEY || '$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6Ojg1ZTI5NmFjLTAyZmMtNGYzZi1hM2Y3LWZiOWIxNWZiODBhNzo6JGFhY2hfMjYyZjhlZjUtMzRhMC00NDhhLWExOTMtMDU2MGE0YmY2NmI3';

app.use(cors());
app.use(express.json());

let db = {
    tickets: [],      // bilhetes CONFIRMADOS (vendidos)
    pending: [],      // compras aguardando pagamento
    purchases: [],    // compras confirmadas
    buyers: []        // compradores
};

const TOTAL_TICKETS = 20000;
const TICKET_PRICE = 1;
const MIN_TICKETS = 5; // Asaas exige minimo R$ 5 por cobranca

function formatCPF(cpf) {
    return String(cpf || '').replace(/\D/g, '');
}

// ============================================
// ASAAS API HELPER
// ============================================
function asaasRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'api.asaas.com',
            path: path,
            method: method,
            headers: { 'access_token': ASAAS_API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'GelinSorteio/1.0' }
        };
        if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
        const req = https.request(options, (res) => {
            let chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
                else { const err = new Error('Asaas error ' + res.statusCode); err.status = res.statusCode; err.body = json; reject(err); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

// Cria (ou reusa) cliente no Asaas pelo CPF
async function getOrCreateAsaasCustomer(buyer) {
    const cpf = formatCPF(buyer.cpf);
    try {
        const list = await asaasRequest('GET', '/v3/customers?cpfCnpj=' + cpf + '&pageSize=1');
        if (list && list.data && list.data.length > 0) return list.data[0];
    } catch (e) { /* segue pra criar */ }

    const fullName = ((buyer.name || '') + ' ' + (buyer.lastName || '')).trim() || 'Comprador Gelinsorteio';
    const cell = formatCPF(buyer.phone);
    const newCustomer = {
        name: fullName.substring(0, 100),
        cpfCnpj: cpf,
        personType: 'FISICA',
        email: buyer.email || ('cpf' + cpf + '@gelinsorteio.com')
    };
    if (cell) newCustomer.mobilePhone = cell.substring(0, 11);
    return await asaasRequest('POST', '/v3/customers', newCustomer);
}

// Busca o QR Code Pix de uma cobranca
async function getPixQrCode(paymentId) {
    return await asaasRequest('GET', '/v3/payments/' + paymentId + '/pixQrCode');
}

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Gelin Sorteio API', asaas: !!ASAAS_API_KEY });
});

// Stats
app.get('/api/stats', (req, res) => {
    const sold = db.tickets.length;
    res.json({
        success: true,
        totalTickets: TOTAL_TICKETS,
        sold: sold,
        available: TOTAL_TICKETS - sold,
        pendingCount: db.pending.length,
        percentage: Math.round((sold / TOTAL_TICKETS) * 100)
    });
});

// ============================================
// INICIAR COMPRA: reserva bilhetes + cria cobranca Pix
// ============================================
app.post('/api/buy', async (req, res) => {
    try {
        const { quantity, buyer } = req.body;

        if (!quantity || quantity < MIN_TICKETS || quantity > 100) {
            return res.status(400).json({ success: false, error: 'Minimo ' + MIN_TICKETS + ' bilhetes' });
        }
        if (!buyer || !formatCPF(buyer.cpf)) {
            return res.status(400).json({ success: false, error: 'CPF obrigatorio' });
        }

        const taken = new Set([...db.tickets, ...db.pending.flatMap(p => p.tickets)]);
        const available = [];
        for (let i = 1; i <= TOTAL_TICKETS; i++) if (!taken.has(i)) available.push(i);
        if (available.length < quantity) {
            return res.status(400).json({ success: false, error: 'Bilhetes insuficientes' });
        }

        for (let i = available.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [available[i], available[j]] = [available[j], available[i]];
        }
        const selected = available.slice(0, quantity);
        const total = quantity * TICKET_PRICE;

        // 1) cliente no Asaas
        const asaasCustomer = await getOrCreateAsaasCustomer(buyer);

        // 2) cobranca Pix
        const dueDate = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
        const chargeBody = {
            customer: asaasCustomer.id,
            value: total,
            dueDate: dueDate,
            description: ('Gelin Sorteio - ' + quantity + ' bilhetes').substring(0, 100),
            billingType: 'PIX',
            pixExpirationInMinutes: 60
        };
        const payment = await asaasRequest('POST', '/v3/payments', chargeBody);

        // 3) busca o QR Code
        const qr = await getPixQrCode(payment.id);

        // 4) guarda como PENDENTE
        const purchase = {
            id: payment.id,
            tickets: selected,
            quantity: quantity,
            total: total,
            buyerCpf: formatCPF(buyer.cpf),
            buyerName: ((buyer.name || '') + ' ' + (buyer.lastName || '')).trim(),
            status: 'pending',
            createdAt: new Date().toISOString()
        };
        db.pending.push(purchase);

        res.json({
            success: true,
            purchaseId: payment.id,
            tickets: selected,
            total: total,
            pix: {
                qrCodeBase64: qr.encodedImage || null,
                copyPaste: qr.payload || null,
                expiresAt: qr.expirationDate || null
            }
        });
    } catch (error) {
        console.error('Error buying:', error);
        if (error.status === 404) {
            return res.status(503).json({ success: false, error: 'PIX_INDISPONIVEL' });
        }
        res.status(500).json({ success: false, error: 'Erro ao criar pagamento: ' + (error.message || '') });
    }
});

// Status de uma compra
app.get('/api/purchase/:id', (req, res) => {
    const p = db.pending.find(x => x.id === req.params.id) || db.purchases.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ success: false, error: 'Compra nao encontrada' });
    res.json({ success: true, purchase: p });
});

// Admin
app.get('/api/purchases', (req, res) => {
    res.json({ success: true, purchases: db.purchases, pending: db.pending });
});

// Register buyer
app.post('/api/register', (req, res) => {
    try {
        const { name, lastName, cpf, phone } = req.body;
        if (!name || !lastName || !cpf || !phone) {
            return res.status(400).json({ success: false, error: 'Dados incompletos' });
        }
        const formattedCpf = formatCPF(cpf);
        let buyer = db.buyers.find(b => b.cpf === formattedCpf);
        if (buyer) {
            buyer.name = name; buyer.lastName = lastName; buyer.phone = phone;
        } else {
            buyer = { id: uuidv4(), name, lastName, cpf: formattedCpf, phone, createdAt: new Date().toISOString() };
            db.buyers.push(buyer);
        }
        res.json({ success: true, buyer });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Meus bilhetes por CPF (so CONFIRMADOS)
app.get('/api/my-tickets', (req, res) => {
    try {
        const { cpf } = req.query;
        if (!cpf) return res.status(400).json({ success: false, error: 'CPF obrigatorio' });
        const formattedCpf = formatCPF(cpf);
        const purchases = db.purchases.filter(p => p.buyerCpf === formattedCpf);
        const tickets = purchases.flatMap(p => p.tickets);
        const buyer = db.buyers.find(b => b.cpf === formattedCpf);
        res.json({
            success: true, cpf: formattedCpf, tickets,
            count: tickets.length, totalTickets: tickets.length,
            purchases, buyer: buyer || { name: 'Comprador', lastName: '' }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Reset (teste)
app.post('/api/reset', (req, res) => {
    db = { tickets: [], pending: [], purchases: [], buyers: [] };
    res.json({ success: true, message: 'Database reset' });
});

function confirmPurchase(chargeId) {
    const idx = db.pending.findIndex(p => p.id === chargeId);
    if (idx === -1) return false;
    const purchase = db.pending.splice(idx, 1)[0];
    purchase.status = 'paid';
    purchase.paidAt = new Date().toISOString();
    db.purchases.push(purchase);
    db.tickets.push(...purchase.tickets);
    console.log('PIX CONFIRMADO -> liberados', purchase.tickets.length, 'bilhetes:', purchase.id);
    return true;
}

function cancelPurchase(chargeId) {
    const idx = db.pending.findIndex(p => p.id === chargeId);
    if (idx === -1) return false;
    const purchase = db.pending.splice(idx, 1)[0];
    purchase.status = 'canceled';
    console.log('PIX CANCELADO/EXPIRADO -> devolvidos bilhetes:', purchase.id);
    return true;
}

// WEBHOOK ASAAS
app.post('/webhook/asaas', async (req, res) => {
    res.sendStatus(200);
    try {
        let event = req.body;
        if (typeof event === 'string') {
            try { event = JSON.parse(event); } catch(e) { event = {}; }
        }
        if (!event || typeof event !== 'object') event = {};
        const type = event.type || '';
        const data = event.data || {};
        const chargeId = data.id || (typeof data === 'string' ? data : null);
        console.log('WEBHOOK RECEIVED:', type, 'chargeId:', chargeId);
        // Eventos de pagamento confirmado (Pix caiu)
        if ((type === 'PAYMENT_CONFIRMED' || type === 'PAYMENT_RECEIVED' || type === 'paymentPaid' || type === 'chargePaid' || type === 'chargePaidPix') && chargeId) {
            confirmPurchase(chargeId);
        }
        // Eventos de cancelamento/expiracao
        else if ((type === 'PAYMENT_OVERDUE' || type === 'PAYMENT_DELETED' || type === 'paymentCanceled' || type === 'chargeCanceled' || type === 'chargeExpired') && chargeId) {
            cancelPurchase(chargeId);
        }
    } catch (err) {
        console.error('Webhook error:', err);
    }
});

// Fallback: frontend consulta status direto no Asaas
app.get('/api/check-charge/:id', async (req, res) => {
    try {
        const payment = await asaasRequest('GET', '/v3/payments/' + req.params.id);
        const status = payment.status; // PENDING, PAID, OVERDUE, CANCELED
        if (status === 'PAID') confirmPurchase(req.params.id);
        else if (status === 'CANCELED' || status === 'OVERDUE') cancelPurchase(req.params.id);
        res.json({ success: true, status: status });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log('Backend Gelinsorteio rodando na porta ' + PORT);
    console.log('Asaas configurado:', !!ASAAS_API_KEY);
    console.log('Webhook: POST http://localhost:' + PORT + '/webhook/asaas');
});
