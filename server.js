const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// DATABASE CONFIG (Postgres)
// ============================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,   // 5s timeout pra conectar (mais agressivo)
    idleTimeoutMillis: 20000,        // conexao ociosa morre em 20s
    max: 5                           // maximo de conexoes simultaneas (reduzido)
});

// Log de eventos da pool
pool.on('connect', (client) => {
    console.log('POOL: nova conexao estabelecida');
});
pool.on('error', (err) => {
    console.error('POOL: erro na conexao:', err.message);
});
pool.on('acquire', (client) => {
    console.log('POOL: conexao adquirida');
});
pool.on('remove', (client) => {
    console.log('POOL: conexao removida');
});

// Wrapper com RETRY automatico: se a conexao cair, tenta de novo (ate 3x)
async function queryDB(text, params) {
    let lastErr;
    const startTime = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`DB query iniciando (tentativa ${attempt}/3):`, text.substring(0, 50));
            const result = await pool.query(text, params);
            console.log(`DB query OK em ${Date.now() - startTime}ms`);
            return result;
        } catch (err) {
            lastErr = err;
            console.error(`DB query falhou (tentativa ${attempt}/3) após ${Date.now() - startTime}ms:`, err.message);
            if (attempt < 3) {
                await new Promise(r => setTimeout(r, 500 * attempt)); // espera 500ms, 1s
            }
        }
    }
    throw lastErr;
}

// Keepalive: testa a conexao a cada 30s pra pool nunca acumular conexao morta
setInterval(async () => {
    try {
        await pool.query('SELECT 1');
    } catch (err) {
        console.error('Keepalive DB falhou:', err.message);
    }
}, 30000);

// Create tables on startup
async function initDB() {
    try {
        await queryDB(`
            CREATE TABLE IF NOT EXISTS purchases (
                id TEXT PRIMARY KEY,
                tickets TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                total NUMERIC(10,2) NOT NULL,
                buyer_cpf TEXT NOT NULL,
                buyer_name TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                confirmed_at TIMESTAMP WITH TIME ZONE
            );
            CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
            CREATE INDEX IF NOT EXISTS idx_purchases_buyer_cpf ON purchases(buyer_cpf);
        `);
        console.log('Database tables initialized');
    } catch (err) {
        console.error('Error initializing DB:', err);
    }
}

// ============================================
// ASAAS CONFIG
// ============================================
const ASAAS_API_KEY = process.env.ASAAS_API_KEY || '$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6Ojg1ZTI5NmFjLTAyZmMtNGYzZi1hM2Y3LWZiOWIxNWZiODBhNzo6JGFhY2hfMjYyZjhlZjUtMzRhMC00NDhhLWExOTMtMDU2MGE0YmY2NmI3';
const ABACATE_API_KEY = process.env.ABACATE_API_KEY || 'abc_dev_e0FnGxwgAk1UedtfeGnmHAe2';
const ABACATE_API_URL = 'https://api.abacatepay.com/v2';

app.use(cors());
app.use(express.json());

const TOTAL_TICKETS = 20000;
const TICKET_PRICE = 1;
const MIN_TICKETS = 1; // AbacatePay permite valores pequenos

function formatCPF(cpf) {
    return String(cpf || '').replace(/\D/g, '');
}

// ============================================
// DATABASE HELPER FUNCTIONS
// ============================================

// Get all sold ticket numbers (from confirmed purchases)
async function getSoldTickets() {
    const result = await queryDB('SELECT tickets FROM purchases WHERE status = $1', ['paid']);
    const sold = new Set();
    result.rows.forEach(row => {
        JSON.parse(row.tickets).forEach(t => sold.add(t));
    });
    return sold;
}

// Get all pending ticket numbers (from pending purchases)
async function getPendingTickets() {
    const result = await queryDB('SELECT tickets FROM purchases WHERE status = $1', ['pending']);
    const pending = new Set();
    result.rows.forEach(row => {
        JSON.parse(row.tickets).forEach(t => pending.add(t));
    });
    return pending;
}

// Create a purchase in the database
async function createPurchase(purchase) {
    await queryDB(
        'INSERT INTO purchases (id, tickets, quantity, total, buyer_cpf, buyer_name, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [purchase.id, JSON.stringify(purchase.tickets), purchase.quantity, purchase.total, purchase.buyerCpf, purchase.buyerName, purchase.status, new Date()]
    );
}

// Update purchase status to paid
async function confirmPurchaseInDB(chargeId) {
    await queryDB(
        'UPDATE purchases SET status = $1, confirmed_at = $2 WHERE id = $3',
        ['paid', new Date(), chargeId]
    );
}

// Update purchase status to canceled
async function cancelPurchaseInDB(chargeId) {
    await queryDB(
        'UPDATE purchases SET status = $1 WHERE id = $2',
        ['canceled', chargeId]
    );
}

// Get a purchase by ID
async function getPurchaseById(id) {
    const result = await queryDB('SELECT * FROM purchases WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
        id: row.id,
        tickets: JSON.parse(row.tickets),
        quantity: row.quantity,
        total: parseFloat(row.total),
        buyerCpf: row.buyer_cpf,
        buyerName: row.buyer_name,
        status: row.status,
        createdAt: row.created_at,
        confirmedAt: row.confirmed_at
    };
}

// Get all purchases
async function getAllPurchases() {
    const result = await queryDB('SELECT * FROM purchases ORDER BY created_at DESC');
    return result.rows.map(row => ({
        id: row.id,
        tickets: JSON.parse(row.tickets),
        quantity: row.quantity,
        total: parseFloat(row.total),
        buyerCpf: row.buyer_cpf,
        buyerName: row.buyer_name,
        status: row.status,
        createdAt: row.created_at,
        confirmedAt: row.confirmed_at
    }));
}

// Get tickets for a specific CPF (only paid)
async function getTicketsByCPF(cpf) {
    const result = await queryDB('SELECT tickets FROM purchases WHERE buyer_cpf = $1 AND status = $2', [cpf, 'paid']);
    const tickets = [];
    result.rows.forEach(row => {
        tickets.push(...JSON.parse(row.tickets));
    });
    return tickets;
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

// ============================================
// ABACATEPAY API HELPER
// ============================================
function abacateRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'api.abacatepay.com',
            path: path,
            method: method,
            headers: { 'Authorization': 'Bearer ' + ABACATE_API_KEY, 'Content-Type': 'application/json' }
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
                else { const err = new Error('Abacate error ' + res.statusCode); err.status = res.statusCode; err.body = json; reject(err); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

// Cria cobranca Pix no AbacatePay (valor em centavos)
async function createAbacatePixCharge(quantity, totalCents, description, externalId) {
    const body = {
        method: 'PIX',
        data: {
            amount: totalCents, // em centavos
            expiresIn: 3600, // 1 hora em segundos
            description: description,
            externalId: externalId
        }
    };
    return await abacateRequest('POST', '/v2/transparents/create', body);
}

// Checa status de uma cobranca no AbacatePay
async function checkAbacateStatus(externalId) {
    return await abacateRequest('GET', '/v2/transparents/' + externalId + '/status');
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
    res.json({ status: 'ok', message: 'Gelin Sorteio API', asaas: !!ASAAS_API_KEY, abacate: !!ABACATE_API_KEY, db: !!process.env.DATABASE_URL });
});

// Stats
app.get('/api/stats', async (req, res) => {
    try {
        const soldSet = await getSoldTickets();
        const pendingSet = await getPendingTickets();
        const sold = soldSet.size;
        res.json({
            success: true,
            totalTickets: TOTAL_TICKETS,
            sold: sold,
            available: TOTAL_TICKETS - sold - pendingSet.size,
            pendingCount: pendingSet.size,
            percentage: Math.round((sold / TOTAL_TICKETS) * 100)
        });
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ success: false, error: 'Erro ao buscar stats' });
    }
});

// ============================================
// INICIAR COMPRA: reserva bilhetes + cria cobranca Pix
// ============================================
app.post('/api/buy', async (req, res) => {
    try {
        const { quantity, buyer } = req.body;

        if (!quantity || quantity < MIN_TICKETS || quantity > 100) {
            return res.status(400).json({ success: false, error: 'Minimo ' + MIN_TICKETS + ' bilhete(s)' });
        }
        if (!buyer || !formatCPF(buyer.cpf)) {
            return res.status(400).json({ success: false, error: 'CPF obrigatorio' });
        }

        const soldSet = await getSoldTickets();
        const pendingSet = await getPendingTickets();
        const taken = new Set([...soldSet, ...pendingSet]);
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
        const totalCents = total * 100; // AbacatePay usa centavos
        const useAbacate = quantity < 5; // 1-4 bilhetes = AbacatePay, 5+ = Asaas

        let purchaseId, pixData;

        if (useAbacate) {
            // ===== ABACATEPAY (1-4 bilhetes) =====
            const externalId = 'gelin_' + uuidv4();
            const charge = await createAbacatePixCharge(
                quantity,
                totalCents,
                ('Gelin Sorteio - ' + quantity + ' bilhete(s)').substring(0, 100),
                externalId
            );
            
            // O AbacatePay retorna: { data: { brCode, brCodeBase64, expiresAt, ... } }
            const abData = charge.data || charge;
            purchaseId = externalId;
            pixData = {
                qrCodeBase64: abData.brCodeBase64 || null,
                copyPaste: abData.brCode || null,
                expiresAt: abData.expiresAt || null
            };
            
            console.log('AbacatePay charge created:', JSON.stringify(charge).substring(0, 300));
        } else {
            // ===== ASAAS (5+ bilhetes) =====
            const asaasCustomer = await getOrCreateAsaasCustomer(buyer);
            
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
            const qr = await getPixQrCode(payment.id);
            
            purchaseId = payment.id;
            pixData = {
                qrCodeBase64: qr.encodedImage || null,
                copyPaste: qr.payload || null,
                expiresAt: qr.expirationDate || null
            };
        }

        // Guarda como PENDENTE no banco
        const purchase = {
            id: purchaseId,
            tickets: selected,
            quantity: quantity,
            total: total,
            buyerCpf: formatCPF(buyer.cpf),
            buyerName: ((buyer.name || '') + ' ' + (buyer.lastName || '')).trim(),
            status: 'pending',
            createdAt: new Date().toISOString()
        };
        await createPurchase(purchase);

        res.json({
            success: true,
            purchaseId: purchaseId,
            provider: useAbacate ? 'abacate' : 'asaas',
            tickets: selected,
            total: total,
            pix: pixData
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
app.get('/api/purchase/:id', async (req, res) => {
    try {
        const p = await getPurchaseById(req.params.id);
        if (!p) return res.status(404).json({ success: false, error: 'Compra nao encontrada' });
        res.json({ success: true, purchase: p });
    } catch (error) {
        console.error('Error getting purchase:', error);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Admin
app.get('/api/purchases', async (req, res) => {
    try {
        const purchases = await getAllPurchases();
        res.json({ success: true, purchases: purchases });
    } catch (error) {
        console.error('Error getting purchases:', error);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Register buyer
app.post('/api/register', (req, res) => {
    try {
        const { name, lastName, cpf, phone } = req.body;
        if (!name || !lastName || !cpf || !phone) {
            return res.status(400).json({ success: false, error: 'Dados incompletos' });
        }
        const formattedCpf = formatCPF(cpf);
        // Buyers are now tracked via purchases, so just return success
        res.json({ success: true, buyer: { cpf: formattedCpf, name, lastName, phone } });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Meus bilhetes por CPF (so CONFIRMADOS)
app.get('/api/my-tickets', async (req, res) => {
    try {
        const { cpf } = req.query;
        if (!cpf) {
            return res.status(400).json({ success: false, error: 'CPF obrigatorio' });
        }
        const formattedCpf = formatCPF(cpf);
        const tickets = await getTicketsByCPF(formattedCpf);
        res.json({ success: true, cpf: formattedCpf, tickets: tickets });
    } catch (error) {
        console.error('Error getting my tickets:', error);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Reset (admin only)
app.post('/api/reset', async (req, res) => {
    try {
        await queryDB('DELETE FROM purchases');
        res.json({ success: true, message: 'Banco resetado' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Webhook handler
app.post('/webhook/asaas', async (req, res) => {
    try {
        const event = req.body;
        const eventType = event.type || event.event;
        const chargeId = event.data && event.data.id ? event.data.id : (event.id || null);

        console.log('Webhook received:', eventType, chargeId);

        if (eventType === 'PAYMENT_CONFIRMED' || eventType === 'PAYMENT_RECEIVED' || eventType === 'paymentPaid' || eventType === 'chargePaid' || eventType === 'chargePaidPix') {
            if (chargeId) {
                await confirmPurchaseInDB(chargeId);
                console.log('Purchase confirmed:', chargeId);
            }
        } else if (eventType === 'PAYMENT_OVERDUE' || eventType === 'PAYMENT_DELETED' || eventType === 'paymentCanceled' || eventType === 'chargeCanceled' || eventType === 'chargeExpired') {
            if (chargeId) {
                await cancelPurchaseInDB(chargeId);
                console.log('Purchase canceled:', chargeId);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Fallback: frontend consulta status direto no Asaas ou AbacatePay
app.get('/api/check-charge/:id', async (req, res) => {
    try {
        const id = req.params.id;
        
        // Se comeÃ§a com 'gelin_', Ã© AbacatePay
        if (id.startsWith('gelin_')) {
            const statusData = await checkAbacateStatus(id);
            const status = statusData.status || statusData.data?.status || 'PENDING';
            // AbacatePay statuses: PENDING, PAID, CANCELED, EXPIRED
            if (status === 'PAID' || status === 'CONFIRMED') {
                await confirmPurchaseInDB(id);
            } else if (status === 'CANCELED' || status === 'EXPIRED') {
                await cancelPurchaseInDB(id);
            }
            res.json({ success: true, status: status, provider: 'abacate' });
        } else {
            // Ã‰ Asaas
            const payment = await asaasRequest('GET', '/v3/payments/' + id);
            const status = payment.status; // PENDING, PAID, RECEIVED, OVERDUE, CANCELED
            if (status === 'PAID' || status === 'RECEIVED' || status === 'CONFIRMED') {
                await confirmPurchaseInDB(id);
            } else if (status === 'CANCELED' || status === 'OVERDUE') {
                await cancelPurchaseInDB(id);
            }
            res.json({ success: true, status: status, provider: 'asaas' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook AbacatePay
app.post('/webhook/abacate', async (req, res) => {
    try {
        const event = req.body;
        const eventType = event.type || event.event || '';
        const externalId = event.externalId || event.data?.externalId || event.id || null;
        
        console.log('Abacate webhook received:', eventType, externalId);
        
        if (eventType === 'pix.paid' || eventType === 'payment.paid' || eventType === 'PAID') {
            if (externalId) {
                await confirmPurchaseInDB(externalId);
                console.log('Abacate purchase confirmed:', externalId);
            }
        } else if (eventType === 'pix.canceled' || eventType === 'payment.canceled' || eventType === 'CANCELED' || eventType === 'EXPIRED') {
            if (externalId) {
                await cancelPurchaseInDB(externalId);
                console.log('Abacate purchase canceled:', externalId);
            }
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('Abacate webhook error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Initialize DB and start server
initDB().then(() => {
    app.listen(PORT, () => {
        console.log('Backend Gelinsorteio rodando na porta ' + PORT);
        console.log('Asaas configurado:', !!ASAAS_API_KEY);
        console.log('AbacatePay configurado:', !!ABACATE_API_KEY);
        console.log('Database configurado:', !!process.env.DATABASE_URL);
        console.log('Webhook: POST http://localhost:' + PORT + '/webhook/asaas');
    });
}).catch(err => {
    console.error('Failed to initialize DB:', err);
    process.exit(1);
});
