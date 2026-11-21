const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory database (resets on restart)
let db = {
    tickets: [],      // Array of sold ticket numbers
    purchases: [],    // Array of purchase objects
    buyers: []        // Array of buyer objects
};

// Helper: format CPF (remove non-digits)
function formatCPF(cpf) {
    return cpf.replace(/\D/g, '');
}

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Gelin Sorteio API' });
});

// Get stats
app.get('/api/stats', (req, res) => {
    const totalTickets = 20000;
    const sold = db.tickets.length;
    const available = totalTickets - sold;
    
    res.json({
        success: true,
        totalTickets,
        sold,
        available,
        percentage: Math.round((sold / totalTickets) * 100)
    });
});

// Get available tickets
app.get('/api/tickets/available', (req, res) => {
    const available = [];
    for (let i = 1; i <= 20000; i++) {
        if (!db.tickets.includes(i)) {
            available.push(i);
            if (available.length >= 100) break; // Limit to 100
        }
    }
    res.json({ success: true, tickets: available });
});

// Buy tickets
app.post('/api/buy', async (req, res) => {
    try {
        const { quantity, buyerEmail, buyerCpf } = req.body;
        
        if (!quantity || quantity < 1 || quantity > 100) {
            return res.status(400).json({ success: false, error: 'Quantidade invalida' });
        }
        
        // Generate random available tickets
        const tickets = [];
        const available = [];
        for (let i = 1; i <= 20000; i++) {
            if (!db.tickets.includes(i)) {
                available.push(i);
            }
        }
        
        if (available.length < quantity) {
            return res.status(400).json({ success: false, error: 'Bilhetes insuficientes' });
        }
        
        // Shuffle and pick
        for (let i = available.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [available[i], available[j]] = [available[j], available[i]];
        }
        
        const selected = available.slice(0, quantity);
        
        // Create purchase
        const purchase = {
            id: uuidv4(),
            tickets: selected,
            quantity,
            total: quantity * 1, // R$ 1 per ticket
            buyerEmail: buyerEmail || null,
            buyerCpf: buyerCpf ? formatCPF(buyerCpf) : null,
            status: 'pending',
            createdAt: new Date().toISOString()
        };
        
        db.purchases.push(purchase);
        db.tickets.push(...selected);
        
        res.json({
            success: true,
            purchaseId: purchase.id,
            tickets: selected,
            total: purchase.total
        });
    } catch (error) {
        console.error('Error buying:', error);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Get purchase by ID
app.get('/api/purchase/:id', (req, res) => {
    const purchase = db.purchases.find(p => p.id === req.params.id);
    if (!purchase) {
        return res.status(404).json({ success: false, error: 'Compra nao encontrada' });
    }
    res.json({ success: true, purchase });
});

// Get all purchases
app.get('/api/purchases', (req, res) => {
    res.json({ success: true, purchases: db.purchases });
});

// Register buyer
app.post('/api/register', (req, res) => {
    try {
        const { name, lastName, cpf, phone } = req.body;
        
        if (!name || !lastName || !cpf || !phone) {
            return res.status(400).json({ success: false, error: 'Dados incompletos' });
        }
        
        const formattedCpf = formatCPF(cpf);
        
        // Check if already registered
        let buyer = db.buyers.find(b => b.cpf === formattedCpf);
        
        if (buyer) {
            // Update existing
            buyer.name = name;
            buyer.lastName = lastName;
            buyer.phone = phone;
        } else {
            // Create new
            buyer = {
                id: uuidv4(),
                name,
                lastName,
                cpf: formattedCpf,
                phone,
                createdAt: new Date().toISOString()
            };
            db.buyers.push(buyer);
        }
        
        res.json({ success: true, buyer });
    } catch (error) {
        console.error('Error registering:', error);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Get my tickets by CPF
app.get('/api/my-tickets', (req, res) => {
    try {
        const { cpf } = req.query;
        
        if (!cpf) {
            return res.status(400).json({ success: false, error: 'CPF obrigatorio' });
        }
        
        const formattedCpf = formatCPF(cpf);
        
        // Find all purchases for this CPF
        const purchases = db.purchases.filter(p => p.buyerCpf === formattedCpf);
        const tickets = purchases.flatMap(p => p.tickets);
        
        res.json({
            success: true,
            cpf: formattedCpf,
            tickets,
            count: tickets.length
        });
    } catch (error) {
        console.error('Error getting my tickets:', error);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// Reset database (for testing)
app.post('/api/reset', (req, res) => {
    db = { tickets: [], purchases: [], buyers: [] };
    res.json({ success: true, message: 'Database reset' });
});

// Start server
app.listen(PORT, () => {
    console.log('Backend Gelinsorteio rodando na porta ' + PORT);
    console.log('Stats: http://localhost:' + PORT + '/api/stats');
    console.log('Buy: POST http://localhost:' + PORT + '/api/buy');
});
