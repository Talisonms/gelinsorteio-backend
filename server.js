const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const { Pool } = require('pg');

function base64_encode(str) {
    return Buffer.from(str).toString('base64');
}

// Cache em memória: externalId -> chargeId (AbacatePay)

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// DATABASE CONFIG (Postgres)
// ============================================
// Connection string do banco (com fallback)
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://gelinsorteio:9fSBimcLcQN9tPK3GMPjQofZw65JgGHg@dpg-dc114rvf3r2c73b8u1cg-a/gelinsorteio_ya75';

const pool = new Pool({
    connectionString: DATABASE_URL,
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
        // Garante a coluna efi_txid (txid da cobranca na API Pix Efi) - adiciona se nao existir
        try {
            await queryDB('ALTER TABLE purchases ADD COLUMN IF NOT EXISTS efi_txid TEXT');
        } catch (e) { /* ja existe */ }
        console.log('Database tables initialized');
    } catch (err) {
        console.error('Error initializing DB:', err);
    }
}

// ============================================
// API PIX EFI (processadora atual)
// ============================================
// Credenciais ficam no Render (env vars) pra nao vazar no GitHub.
// mTLS: certificado .p12 em base64 (EFI_CERT_BASE64) + senha (EFI_CERT_PASSPHRASE, pode ser vazia).
const EFI_ENV = process.env.EFI_ENV || 'production';
const EFI_HOSTNAME = EFI_ENV === 'production' ? 'pix.api.efipay.com.br' : 'pix-h.api.efipay.com.br';
const EFI_CLIENT_ID = process.env.EFI_CLIENT_ID || '';
const EFI_CLIENT_SECRET = process.env.EFI_CLIENT_SECRET || '';
const EFI_CHAVE_PIX = process.env.EFI_CHAVE_PIX || '';
const EFI_CERT_BASE64 = process.env.EFI_CERT_BASE64 || '';
const EFI_CERT_PASSPHRASE = process.env.EFI_CERT_PASSPHRASE || '';

// Agent mTLS: usa o certificado .p12 do integrador em todas as chamadas a Efi.
let efiAgent = null;
if (EFI_CERT_BASE64) {
    try {
        const pfx = Buffer.from(EFI_CERT_BASE64, 'base64');
        const _pp = (EFI_CERT_PASSPHRASE || '').trim();
efiAgent = new https.Agent({ pfx: pfx, passphrase: _pp ? _pp : undefined });
        console.log('Agente mTLS Efi criado com sucesso');
    } catch (e) {
        console.error('ERRO ao criar agente mTLS Efi:', e.message);
    }
} else {
    console.warn('EFI_CERT_BASE64 ausente - chamadas a Efi sem mTLS vao falhar');
}

// Cache do token OAuth2 (expira em 1h; renova com margem de 5 min)
let efiToken = null;
let efiTokenExpiresAt = 0;

function efiRequest(method, path, body, headers) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: EFI_HOSTNAME,
            path: path,
            method: method,
            agent: efiAgent,
            headers: Object.assign({ 'Content-Type': 'application/json', 'User-Agent': 'gelinsorteio/1.0' }, headers || {})
        };
        if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
        const req = https.request(opts, (res) => {
            let chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
                else { const err = new Error('Efi error ' + res.statusCode); err.status = res.statusCode; err.body = json; reject(err); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

// Obtem (ou reutiliza) o access_token via OAuth2 client_credentials + Basic Auth.
async function getEfiToken() {
    if (efiToken && Date.now() < efiTokenExpiresAt) return efiToken;
    const basic = base64_encode(EFI_CLIENT_ID + ':' + EFI_CLIENT_SECRET);
    const tok = await efiRequest('POST', '/oauth/token',
        { grant_type: 'client_credentials' },
        { 'Authorization': 'Basic ' + basic });
    efiToken = tok.access_token;
    efiTokenExpiresAt = Date.now() + ((tok.expires_in || 3600) - 300) * 1000;
    return efiToken;
}

// Cria cobranca Pix na Efi. txid: 26-35 chars alfanumericos (SEM underline).
// valor.original vai como STRING ("1.00"). chave = chave Pix da conta recebedora.
async function createEfiPixCharge(txid, valorOriginal, cpf, nome) {
    const token = await getEfiToken();
    return await efiRequest('PUT', '/v2/cob/' + txid, {
        chave: EFI_CHAVE_PIX,
        calendario: { expiracao: 1800 },   // expira em 30 minutos
        devedor: { cpf: cpf, nome: nome },
        valor: { original: valorOriginal }
    }, { 'Authorization': 'Bearer ' + token });
}

// Consulta status de uma cobranca na Efi (fonte da verdade).
async function checkEfiStatus(txid) {
    const token = await getEfiToken();
    return await efiRequest('GET', '/v2/cob/' + txid, null,
        { 'Authorization': 'Bearer ' + token });
}

// Painel admin
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'gelin2026';

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
    // Tenta inserir com buyer_phone + efi_txid; se falhar, cai no fallback
    try {
        await queryDB(
            'INSERT INTO purchases (id, tickets, quantity, total, buyer_cpf, buyer_name, buyer_phone, efi_txid, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [purchase.id, JSON.stringify(purchase.tickets), purchase.quantity, purchase.total, purchase.buyerCpf, purchase.buyerName, purchase.buyerPhone || '', purchase.efiTxid || null, purchase.status, new Date()]
        );
    } catch (e) {
        // Fallback: sem efi_txid (coluna pode nao existir em banco antigo)
        await queryDB(
            'INSERT INTO purchases (id, tickets, quantity, total, buyer_cpf, buyer_name, buyer_phone, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [purchase.id, JSON.stringify(purchase.tickets), purchase.quantity, purchase.total, purchase.buyerCpf, purchase.buyerName, purchase.buyerPhone || '', purchase.status, new Date()]
        );
    }
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
        buyerPhone: row.buyer_phone || '',
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
        buyerPhone: row.buyer_phone || '',
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

// Health check
app.get('/api/health', async (req, res) => {
    let efiOk = false;
    try {
        await getEfiToken();
        efiOk = true;
    } catch (e) {
        console.error('Health: token Efi falhou:', e.message);
    }
    res.json({ status: 'ok', message: 'Gelin Sorteio API', efi: efiOk, env: EFI_ENV, db: !!process.env.DATABASE_URL });
});

// Stats
app.get('/api/stats', async (req, res) => {
    try {
        const soldSet = await getSoldTickets();
        const pendingSet = await getPendingTickets();
        // Contar apenas confirmados (vendidos) pra barra de progresso
        const totalConfirmed = soldSet.size;
        res.json({
            success: true,
            totalTickets: TOTAL_TICKETS,
            sold: totalConfirmed,  // Apenas confirmados
            available: TOTAL_TICKETS - totalConfirmed,
            pendingCount: pendingSet.size,
            percentage: Math.round((totalConfirmed / TOTAL_TICKETS) * 100)
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
        const { quantity, buyer, buyerCpf } = req.body;
        // Aceita os dois formatos do front: { buyer: {...} } ou { buyerCpf: '...' }
        const b = buyer || {};
        const cpfRaw = b.cpf || buyerCpf || '';

        if (!quantity || quantity < MIN_TICKETS || quantity > 100) {
            return res.status(400).json({ success: false, error: 'Minimo ' + MIN_TICKETS + ' bilhete(s)' });
        }
        if (!formatCPF(cpfRaw)) {
            return res.status(400).json({ success: false, error: 'CPF obrigatorio' });
        }

        // Validar telefone (obrigatorio pro contato)
        const phoneDigits = formatCPF(b.phone); // remove nao-digitos
        if (!phoneDigits || phoneDigits.length < 10) {
            return res.status(400).json({ success: false, error: 'Dados invalidos. Verifique seu CPF e telefone.' });
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

        // Id da compra (nosso banco). O txid da Efi e derivado dele (32 chars alfanumericos,
        // sem underline - a Efi exige o padrao ^[a-zA-Z0-9]{26,35}$).
        const purchaseId = 'gelin_' + uuidv4();
        const txid = uuidv4().replace(/-/g, '').slice(0, 32);

        // ===== API PIX EFI =====
        const cpf = formatCPF(cpfRaw);
        const nome = (((b.name || '') + ' ' + (b.lastName || '')).trim().toUpperCase() || 'COMPRADOR GELIN SORTEIO').substring(0, 140);
        const charge = await createEfiPixCharge(txid, total.toFixed(2), cpf, nome);
        console.log('Efi charge created:', JSON.stringify(charge).substring(0, 400));

        const pixData = {
            copiaEcola: charge.pixCopiaECola || null,
            txid: charge.txid || txid,
            expiraEm: 1800
        };

        // Guarda como PENDENTE no banco
        const purchase = {
            id: purchaseId,
            tickets: selected,
            quantity: quantity,
            total: total,
            buyerCpf: cpf,
            buyerName: ((b.name || '') + ' ' + (b.lastName || '')).trim(),
            buyerPhone: b.phone || '',
            efiTxid: pixData.txid,
            status: 'pending',
            createdAt: new Date().toISOString()
        };
        await createPurchase(purchase);

        res.json({
            success: true,
            purchaseId: purchaseId,
            provider: 'efi',
            tickets: selected,
            total: total,
            pix: pixData
        });
    } catch (error) {
        console.error('Error buying:', error);
        if (error.status === 401) {
            return res.status(503).json({ success: false, error: 'PIX_INDISPONIVEL' });
        }
        if (error.body && error.body.nome === 'json_invalido') {
            return res.status(400).json({ success: false, error: 'Dados invalidos. Verifique seu CPF e telefone.' });
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

// Consulta status da cobranca na Efi (fonte da verdade).
// O front chama esse endpoint de tempos em tempos enquanto o comprador paga.
app.get('/api/check-charge/:id', async (req, res) => {
    try {
        const id = req.params.id; // nosso id da compra (gelin_...)
        const row = await queryDB('SELECT efi_txid FROM purchases WHERE id = $1', [id]);
        const txid = row.rows.length ? row.rows[0].efi_txid : null;
        if (!txid) {
            return res.json({ success: true, status: 'PENDING', provider: 'efi', note: 'efi_txid nao encontrado' });
        }
        const statusData = await checkEfiStatus(txid);
        const status = statusData.status || 'ATIVA';
        // Statuses Efi: ATIVA, PAGA, EXPIRADA, CANCELADA, REEMBOLSADA
        if (status === 'PAGA') {
            await confirmPurchaseInDB(id);
        } else if (status === 'EXPIRADA' || status === 'CANCELADA' || status === 'REEMBOLSADA') {
            await cancelPurchaseInDB(id);
        }
        res.json({ success: true, status: status, provider: 'efi' });
    } catch (error) {
        console.error('check-charge error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Lista todos os compradores (pra conferência no sorteio)
app.get('/api/admin/buyers', async (req, res) => {
    try {
        const senha = req.query.senha || '';
        if (senha !== ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, error: 'Senha incorreta' });
        }
        
        const status = req.query.status || 'confirmed'; // confirmed, pending, all
        
        // Mapear 'confirmed' para 'paid' (o status real no banco)
        const dbStatus = status === 'confirmed' ? 'paid' : status;
        
        let query;
        let params = [];
        
        if (dbStatus === 'all') {
            // 'all' mostra apenas confirmados (paid) e pendentes, esconde cancelados
            query = 'SELECT * FROM purchases WHERE status IN ($1, $2) ORDER BY created_at DESC';
            params = ['paid', 'pending'];
        } else {
            query = 'SELECT * FROM purchases WHERE status = $1 ORDER BY created_at DESC';
            params = [dbStatus];
        }
        
        const result = await queryDB(query, params);
        
        res.json({
            success: true,
            buyers: result.rows.map(r => ({
                id: r.id,
                tickets: JSON.parse(r.tickets),
                quantity: r.quantity,
                total: Number(r.total),
                cpf: r.buyer_cpf,
                name: r.buyer_name,
                phone: r.buyer_phone || '',
                status: r.status,
                createdAt: r.created_at,
                confirmedAt: r.confirmed_at
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== PAINEL ADMIN =====
// Lista compras pendentes (pra conferência)
app.get('/api/admin/pending', async (req, res) => {
    try {
        const senha = req.query.senha || '';
        if (senha !== ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, error: 'Senha incorreta' });
        }
        const result = await queryDB(
            'SELECT id, tickets, quantity, total, buyer_cpf, buyer_name, created_at FROM purchases WHERE status = $1 ORDER BY created_at DESC LIMIT 200',
            ['pending']
        );
        res.json({
            success: true,
            pending: result.rows.map(r => ({
                id: r.id,
                tickets: JSON.parse(r.tickets),
                quantity: r.quantity,
                total: Number(r.total),
                cpf: r.buyer_cpf,
                name: r.buyer_name,
                createdAt: r.created_at
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Confirma uma compra específica pelo ID
app.post('/api/admin/confirm', async (req, res) => {
    try {
        const { id, senha } = req.body;
        if (!senha || senha !== ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, error: 'Senha incorreta' });
        }
        const result = await queryDB(
            'SELECT * FROM purchases WHERE id = $1 AND status = $2',
            [id, 'pending']
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Compra não encontrada ou já confirmada' });
        }
        await confirmPurchaseInDB(id);
        console.log('Admin confirmou compra:', id);
        res.json({ success: true, message: 'Compra confirmada!' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Cancela uma compra (libera os bilhetes de volta)
app.post('/api/admin/cancel', async (req, res) => {
    try {
        const { id, senha } = req.body;
        if (!senha || senha !== ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, error: 'Senha incorreta' });
        }
        await cancelPurchaseInDB(id);
        console.log('Admin cancelou compra:', id);
        res.json({ success: true, message: 'Compra cancelada, bilhetes liberados.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Adiciona coluna buyer_phone na tabela purchases (se não existir)
app.post('/api/admin/add-phone-column', async (req, res) => {
    try {
        const { senha } = req.body;
        if (!senha || senha !== ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, error: 'Senha incorreta' });
        }
        await queryDB('ALTER TABLE purchases ADD COLUMN IF NOT EXISTS buyer_phone TEXT');
        res.json({ success: true, message: 'Coluna buyer_phone adicionada!' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Exclui TODAS as compras pendentes de uma vez (pra limpar testes)
app.post('/api/admin/clear-pending', async (req, res) => {
    try {
        const { senha } = req.body;
        if (!senha || senha !== ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, error: 'Senha incorreta' });
        }
        const result = await queryDB(
            'DELETE FROM purchases WHERE status = $1',
            ['pending']
        );
        const count = result.rowCount || 0;
        console.log('Admin excluiu pendentes:', count);
        res.json({ success: true, message: count + ' compra(s) pendente(s) excluída(s). Bilhetes liberados.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Confirmação manual de pagamento (QR Code estático do Nubank)
app.post('/api/confirm-manual', async (req, res) => {
    try {
        const { cpf, total } = req.body;
        
        if (!cpf || cpf.length !== 11) {
            return res.status(400).json({ success: false, error: 'CPF inválido' });
        }
        
        // Busca a compra pending mais recente desse CPF
        const result = await queryDB(
            'SELECT * FROM purchases WHERE buyer_cpf = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
            [formatCPF(cpf), 'pending']
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Compra não encontrada' });
        }
        
        const purchase = result.rows[0];
        
        // Confirma a compra
        await confirmPurchaseInDB(purchase.id);
        
        console.log('Pagamento manual confirmado:', purchase.id, 'CPF:', cpf);
        
        res.json({ 
            success: true, 
            message: 'Pagamento confirmado!',
            tickets: JSON.parse(purchase.tickets)
        });
        
    } catch (error) {
        console.error('Erro na confirmação manual:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook Efi (POST /webhook/efi)
// A Efi envia notificacoes de status aqui. No Render Free o webhook mTLS pode nao chegar,
// entao a confirmacao real vem da consulta ativa (/api/check-charge). Este handler e backup.
app.post('/webhook/efi', async (req, res) => {
    try {
        const event = req.body;
        // Log COMPLETO da primeira notificacao pra ver o formato real
        if (!global.__efiWebhookLogged) {
            global.__efiWebhookLogged = true;
            console.log('EFI WEBHOOK (payload completo):', JSON.stringify(event));
        } else {
            console.log('Efi webhook received:', JSON.stringify(event).substring(0, 200));
        }

        // O txid pode vir no topo ou em campos aninhados - procuramos nos lugares provaveis
        const txid = event.txid || (event.data && event.data.txid) || null;
        const status = event.status || (event.data && event.data.status) || '';

        if (txid) {
            const row = await queryDB('SELECT id FROM purchases WHERE efi_txid = $1', [txid]);
            if (row.rows.length > 0) {
                const purchaseId = row.rows[0].id;
                if (status === 'PAGA') {
                    await confirmPurchaseInDB(purchaseId);
                    console.log('Efi purchase CONFIRMED via webhook:', purchaseId);
                } else if (status === 'EXPIRADA' || status === 'CANCELADA' || status === 'REEMBOLSADA') {
                    await cancelPurchaseInDB(purchaseId);
                    console.log('Efi purchase CANCELED via webhook:', purchaseId);
                }
            }
        }

        // Responder 2xx rapido (a Efi considera 2xx como entrega ok)
        res.json({ success: true });
    } catch (err) {
        console.error('Efi webhook error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// EXPIRAÇÃO AUTOMÁTICA DE PENDENTES (30 minutos)
// ============================================
const PENDING_EXPIRY_MINUTES = 30;

async function expireOldPendingPurchases() {
    try {
        const cutoff = new Date(Date.now() - PENDING_EXPIRY_MINUTES * 60 * 1000);
        const result = await queryDB(
            'DELETE FROM purchases WHERE status = $1 AND created_at < $2',
            ['pending', cutoff]
        );
        const count = result.rowCount || 0;
        if (count > 0) {
            console.log('Expirados automaticamente:', count, 'compras pendentes');
        }
    } catch (error) {
        console.error('Erro ao expirar pendentes:', error);
    }
}

// Rodar a cada 5 minutos
setInterval(expireOldPendingPurchases, 5 * 60 * 1000);
// Rodar também ao iniciar
expireOldPendingPurchases();


// Endpoint pra adicionar compra manualmente
app.post('/api/admin/add-purchase', async (req, res) => {
    try {
        const { senha, cpf, name, phone, quantity, total } = req.body;
        
        if (senha !== ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, error: 'Senha incorreta' });
        }
        
        if (!cpf || cpf.length !== 11) {
            return res.status(400).json({ success: false, error: 'CPF inválido' });
        }
        
        // Gerar bilhetes únicos
        const tickets = [];
        while (tickets.length < quantity) {
            const ticket = Math.floor(Math.random() * TOTAL_TICKETS) + 1;
            if (!tickets.includes(ticket)) {
                tickets.push(ticket);
            }
        }
        
        // Gerar ID único
        const id = 'pay_' + Math.random().toString(36).substr(2, 16);
        const now = new Date().toISOString();
        
        // Inserir no banco
        await queryDB(
            `INSERT INTO purchases (id, tickets, quantity, total, buyer_cpf, buyer_name, buyer_phone, status, created_at, confirmed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'paid', $8, $8)`,
            [id, JSON.stringify(tickets), quantity, total, formatCPF(cpf), name, phone || '', now]
        );
        
        console.log('Compra adicionada manualmente:', id, 'CPF:', cpf);
        
        res.json({ 
            success: true, 
            message: 'Compra adicionada!',
            id: id,
            tickets: tickets
        });
        
    } catch (error) {
        console.error('Erro ao adicionar compra:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Initialize DB and start server
initDB().then(() => {
    app.listen(PORT, () => {
        console.log('Backend Gelinsorteio rodando na porta ' + PORT);
        console.log('API Pix Efi configurada:', !!(EFI_CLIENT_ID && EFI_CLIENT_SECRET && EFI_CERT_BASE64), '| env:', EFI_ENV);
        console.log('Chave Pix recebedora:', EFI_CHAVE_PIX ? 'ok' : 'FALTANDO (EFI_CHAVE_PIX)');
        console.log('Database configurado:', !!process.env.DATABASE_URL);
        console.log('Webhook: POST https://gelinsorteio-backend-v2.onrender.com/webhook/efi');
    });
}).catch(err => {
    console.error('Failed to initialize DB:', err);
    process.exit(1);
});
