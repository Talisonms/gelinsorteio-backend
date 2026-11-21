/* ============================================
   GELIN SORTEIO  APP.JS
   ============================================ */

// ============================================
   // CONFIGURAO
   // ============================================
const CONFIG = {
    // Total de bilhetes na rifa
    TOTAL_TICKETS: 20000,
    
    // Preo por bilhete (R$)
    TICKET_PRICE: 1,
    
    // NOME da campanha
    CAMPAIGN_NAME: 'Gelin Sorteio',
    
    // Descrio do prmio
    PRIZE_DESCRIPTION: 'iPhone 18 Pro Max 256GB ou R$ 7.000 no Pix',
    
    // ============================================
    // BACKEND API
    // ============================================
    // URL do backend (ajuste conforme onde voc hospedar)
    // Local: http://localhost:3000
    // Produo: https://seu-backend.com
    API_URL: 'http://localhost:3000',
    
    // true = usar backend (recomendado)
    // false = usar localStorage (modo demo)
    USE_BACKEND: false,
    
    // ============================================
    // MERCADO PAGO  COLOQUE SUAS CHAVES AQUI
    // ============================================
    MERCADO_PAGO_ACCESS_TOKEN: 'SEU_ACCESS_TOKEN_AQUI',
    
    // true = modo teste (pagamentos simulados)
    // false = modo produo (recebe dinheiro de verdade)
    MP_TEST_MODE: true,
    
    // ============================================
    // SEU PIX  PARA RECEBER O DINHEIRO
    // ============================================
    PIX_KEY: 'seu-cpf-ou-cnpj-aqui',
    PIX_NAME: 'Gelin Sorteio',
    PIX_CITY: 'SAO PAULO'
};

// ============================================
   // ESTADO DA RIFA
   // ============================================
let state = {
    soldTickets: [],      // Array de nmeros vendidos
    myTickets: [],        // Bilhetes comprados nesta sesso
    currentPurchase: null // Compra em andamento
};

// Carregar estado salvo
function loadState() {
    const saved = localStorage.getItem('gelinsorteio_state');
    if (saved) {
        const parsed = JSON.parse(saved);
        state.soldTickets = parsed.soldTickets || [];
        state.myTickets = parsed.myTickets || [];
    }
}

function saveState() {
    localStorage.setItem('gelinsorteio_state', JSON.stringify({
        soldTickets: state.soldTickets,
        myTickets: state.myTickets
    }));
}

// ============================================
   // FUNES DE API (BACKEND)
   // ============================================

// Busca estatsticas do backend
async function fetchStats() {
    if (!CONFIG.USE_BACKEND) {
        // Modo demo: usar localStorage
        const sold = state.soldTickets.length;
        const percent = Math.round((sold / CONFIG.TOTAL_TICKETS) * 100);
        return { sold, total: CONFIG.TOTAL_TICKETS, percent, available: CONFIG.TOTAL_TICKETS - sold };
    }
    
    try {
        const response = await fetch(`${CONFIG.API_URL}/api/stats`);
        if (!response.ok) throw new Error('Erro ao buscar stats');
        return await response.json();
    } catch (error) {
        console.error('Error fetching stats:', error);
        // Fallback para localStorage
        const sold = state.soldTickets.length;
        const percent = Math.round((sold / CONFIG.TOTAL_TICKETS) * 100);
        return { sold, total: CONFIG.TOTAL_TICKETS, percent, available: CONFIG.TOTAL_TICKETS - sold };
    }
}

// Compra bilhetes via backend
async function buyTicketsAPI(quantity, buyerCpf) {
    if (!CONFIG.USE_BACKEND) {
        // Modo demo: gerar localmente
        return generateTickets(quantity);
    }
    
    try {
        const response = await fetch(`${CONFIG.API_URL}/api/buy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quantity, buyerCpf })
        });
        
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Erro ao comprar');
        }
        
        return data.tickets; // Array de strings ["03847", "12903", ...]
    } catch (error) {
        console.error('Error buying tickets:', error);
        throw error;
    }
}

// Gera um nmero de bilhete aleatrio disponvel
function getRandomAvailableTicket() {
    const available = [];
    for (let i = 1; i <= CONFIG.TOTAL_TICKETS; i++) {
        if (!state.soldTickets.includes(i)) {
            available.push(i);
        }
        // Otimizao: se j temos o suficiente, para
        if (available.length >= 100) break;
    }
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
}

// Gera mltiplos bilhetes nicos
function generateTickets(quantity) {
    const tickets = [];
    for (let i = 0; i < quantity; i++) {
        const ticket = getRandomAvailableTicket();
        if (ticket === null) break;
        tickets.push(ticket);
    }
    return tickets;
}

// Formata nmero do bilhete (ex: 1 -> "00001")
function formatTicket(num) {
    return String(num).padStart(5, '0');
}

// ============================================
   // UI  ATUALIZAR PROGRESSO
   // ============================================
function updateProgressUI() {
    const sold = state.soldTickets.length;
    const percent = Math.round((sold / CONFIG.TOTAL_TICKETS) * 100);
    
    document.getElementById('progressFill').style.width = percent + '%';
    document.getElementById('progressPercent').textContent = percent + '%';
    document.getElementById('soldCount').textContent = sold.toLocaleString('pt-BR');
    
    // Se chegou a 100%, mostrar mensagem especial
    if (percent >= 100) {
        showToast(' Todos os bilhetes foram vendidos! Sorteio em andamento!', 'success');
    }
}

// ============================================
   // UI  MEUS BILHETES
   // ============================================
function updateMyTicketsUI() {
    const container = document.getElementById('myTickets');
    const list = document.getElementById('myTicketsList');
    
    // Protect against missing elements
    if (!container || !list) {
        return;
    }
    
    if (state.myTickets.length === 0) {
        container.style.display = 'none';
        return;
    }
    
    container.style.display = 'block';
    list.innerHTML = state.myTickets.map(t => 
        `<span class="ticket-chip">#${formatTicket(t)}</span>`
    ).join('');
}

// ============================================
   // TOAST NOTIFICATION
   // ============================================
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 4000);
}

// ============================================
   // MODAL
   // ============================================
function openModal() {
    document.getElementById('paymentModal').classList.add('active');
}

function closeModal() {
    document.getElementById('paymentModal').classList.remove('active');
    document.getElementById('modalContent').innerHTML = '';
}

// ============================================
   // FLUXO DE COMPRA
   // ============================================

// Inicia a compra
async function buyTickets(quantity) {
    
    // Efeito de clique no boto
    const btn = event.target;
    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 400);
    
    // Verificar se est cadastrado
    const buyer = getSavedBuyer();
    if (!buyer) {
        showToast('Cadastre-se antes de comprar!', 'info');
        openRegisterModal();
        return;
    }
    
    try {
        // Comprar via backend (ou local se USE_BACKEND = false)
        const tickets = await buyTicketsAPI(quantity, buyer.cpf);
        
        if (!tickets || tickets.length === 0) {
            showToast('No h bilhetes disponveis!', 'error');
            return;
        }
        
        const total = tickets.length * CONFIG.TICKET_PRICE;
        
        // Salvar localmente (pra mostrar na sesso)
        state.myTickets.push(...tickets.map(t => parseInt(t)));
        saveState();
        
        // Atualizar UI
        updateProgressUI();
        updateMyTicketsUI();
        
        // Mostrar modal com resumo
        showPaymentModal(tickets.length, total, tickets.map(t => parseInt(t)));
        
    } catch (error) {
        console.error('Error buying:', error);
        showToast(error.message || 'Erro ao comprar bilhetes', 'error');
    }
}

// Mostra modal de pagamento
async function showPaymentModal(quantity, total, tickets) {
    const content = document.getElementById('modalContent');
    
    content.innerHTML = `
        <h2 class="modal-title">Confirmar compra</h2>
        <p class="modal-subtitle">Revise seus dados antes de pagar.</p>
        
        <div class="modal-summary">
            <div class="modal-summary-row">
                <span>Quantidade</span>
                <span>${quantity} bilhete${quantity > 1 ? 's' : ''}</span>
            </div>
            <div class="modal-summary-row">
                <span>Nmeros</span>
                <span>${tickets.map(t => formatTicket(t)).join(', ')}</span>
            </div>
            <div class="modal-summary-row modal-summary-total">
                <span>Total</span>
                <span>R$ ${total.toFixed(2).replace('.', ',')}</span>
            </div>
        </div>
        
        <button class="btn btn-primary btn-block" onclick="createPixPayment(${quantity}, ${total}, '${JSON.stringify(tickets)}')">
            Gerar Pix
        </button>
    `;
    
    openModal();
}

// Cria pagamento Pix via Mercado Pago
async function createPixPayment(quantity, total, tickets) {
    const content = document.getElementById('modalContent');
    
    // Mostrar loading
    content.innerHTML = `
        <div class="pix-section">
            <div class="spinner" style="margin: 40px auto;"></div>
            <p style="color: var(--text-secondary); margin-top: 16px;">Gerando cdigo Pix...</p>
        </div>
    `;
    
    try {
        // Verificar se token est configurado
        if (CONFIG.MERCADO_PAGO_ACCESS_TOKEN === 'SEU_ACCESS_TOKEN_AQUI') {
            throw new Error('CONFIGURACAO_INCOMPLETA');
        }
        
        // Criar transao no Mercado Pago
        const response = await fetch('https://api.mercadopago.com/v1/payments', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.MERCADO_PAGO_ACCESS_TOKEN}`,
                'X-Idempotency-Key': Date.now().toString()
            },
            body: JSON.stringify({
                transaction_amount: total,
                description: `${CONFIG.CAMPAIGN_NAME} - ${quantity} bilhete(s)`,
                payment_method_id: 'pix',
                payer: {
                    email: 'comprador@gelinsorteio.com'
                },
                metadata: {
                    quantity: quantity,
                    tickets: tickets,
                    campaign: CONFIG.CAMPAIGN_NAME
                }
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.message || 'Erro ao criar pagamento');
        }
        
        // Extrair QR Code e cdigo copia-e-cola
        const qrCode = data.point_of_interaction.transaction_data.qr_code;
        const qrCodeBase64 = data.point_of_interaction.transaction_data.qr_code_base64;
        
        // Mostrar QR Code
        showPixQR(qrCode, qrCodeBase64, quantity, total, tickets);
        
    } catch (error) {
        if (error.message === 'CONFIGURACAO_INCOMPLETA') {
            // Modo demo: mostrar QR Code fake
            showDemoPix(quantity, total, tickets);
        } else {
            content.innerHTML = `
                <div class="pix-section">
                    <div class="pix-status error">
                         ${error.message}
                    </div>
                    <button class="btn btn-secondary btn-block" style="margin-top: 16px;" onclick="closeModal()">
                        Fechar
                    </button>
                </div>
            `;
        }
    }
}

// Mostra QR Code real
function showPixQR(qrCode, qrCodeBase64, quantity, total, tickets) {
    const content = document.getElementById('modalContent');
    
    let qrImage = '';
    if (qrCodeBase64) {
        qrImage = `<img src="data:image/png;base64,${qrCodeBase64}" alt="QR Code Pix">`;
    } else {
        // Gerar QR Code via API externa
        qrImage = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrCode)}" alt="QR Code Pix">`;
    }
    
    content.innerHTML = `
        <div class="pix-section">
            <h2 class="modal-title">Pague via Pix</h2>
            <p class="modal-subtitle">Escaneie o QR Code ou copie o cdigo abaixo.</p>
            
            <div class="pix-qr">${qrImage}</div>
            
            <div class="pix-code" onclick="copyPixCode(this)" title="Clique para copiar">
                ${qrCode}
            </div>
            
            <p class="pix-instructions">
                Abra o app do seu banco, escolha "Pagar com Pix",<br>
                escaneie o QR Code ou cole o cdigo acima.
            </p>
            
            <div class="pix-status pending" id="pixStatus">
                <div class="spinner"></div>
                Aguardando pagamento...
            </div>
            
            <!-- Boto para simular confirmao (modo demo) -->
            <button class="btn btn-secondary btn-block" style="margin-top: 16px;" onclick="confirmPayment(${quantity}, ${total}, '${JSON.stringify(tickets)}')">
                 J paguei (confirmao manual)
            </button>
        </div>
    `;
    
    // Iniciar polling para verificar pagamento (a cada 5 segundos)
    startPaymentPolling();
}

// Modo demo (sem Mercado Pago configurado)
function showDemoPix(quantity, total, tickets) {
    
    const modalEl = document.getElementById('modalContent');
    
    const demoData = '00020126580014BR.GOV.BCB.PIX0136' + CONFIG.PIX_KEY + '520400005303986540' + total.toFixed(2) + '5802BR5915' + CONFIG.PIX_NAME + '6009SAO PAULO62070503***6304ABCD';
    
    modalEl.innerHTML = '        <div class="pix-section">            <h2 class="modal-title">Pague via Pix</h2>            <p class="modal-subtitle">                <strong>Modo demonstracao</strong><br>                Configure seu Access Token do Mercado Pago em <code>app.js</code> para receber pagamentos reais.            </p>                        <div class="pix-qr">                <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(demoData) + '" alt="QR Code Pix">            </div>                        <div class="pix-code" onclick="copyPixCode(this)" title="Clique para copiar">                ' + demoData + '            </div>                        <p class="pix-instructions">                Abra o app do seu banco, escolha "Pagar com Pix",<br>                escaneie o QR Code ou cole o codigo acima.            </p>                        <div class="pix-status pending" id="pixStatus">                <div class="spinner"></div>                Aguardando pagamento...            </div>                        <button class="btn btn-primary btn-block" style="margin-top: 16px;" id="btnSimulatePayment">                 Simular pagamento confirmado            </button>        </div>';
    
    // Store data for the button handler
    window._demoPaymentData = { quantity: quantity, total: total, tickets: tickets };
    
    // Attach click handler directly
    document.getElementById('btnSimulatePayment').addEventListener('click', function() {
                confirmPayment(window._demoPaymentData.quantity, window._demoPaymentData.total, window._demoPaymentData.tickets);
    });
    
    }

// Polling para verificar status do pagamento
let pollingInterval = null;

function startPaymentPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    
    pollingInterval = setInterval(async () => {
        // Aqui voc pode fazer fetch na API do Mercado Pago
        // para verificar o status do pagamento
        // Por enquanto, deixamos o usurio confirmar manualmente
    }, 5000);
}

// Confirma pagamento (manual ou automtico)
function confirmPayment(quantity, total, tickets) {
    
    // Marcar bilhetes como vendidos
    state.soldTickets.push(...tickets);
    state.myTickets.push(...tickets);
    saveState();
        
    // Atualizar UI
    updateProgressUI();
        updateMyTicketsUI();
        
    // Mostrar resultado
    showSuccessModal(tickets, total);
    
    // Parar polling
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}

// Modal de sucesso
function showSuccessModal(tickets, total) {
        const modalEl = document.getElementById('modalContent');
    
    // Build ticket chips
    let chips = '';
    for (let i = 0; i < tickets.length; i++) {
        chips += '<span class="ticket-chip">#' + formatTicket(tickets[i]) + '</span>';
    }
    
    const totalStr = 'R$ ' + total.toFixed(2).replace('.', ',');
    
    modalEl.innerHTML = '<div class="ticket-result">' +
        '<div class="ticket-result-icon"></div>' +
        '<h2 class="ticket-result-title">Compra confirmada!</h2>' +
        '<p class="ticket-result-subtitle">Seus bilhetes estao garantidos. Boa sorte!</p>' +
        '<div class="tickets-bought">' + chips + '</div>' +
        '<p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 24px;">Total pago: <strong>' + totalStr + '</strong></p>' +
        '<button class="btn btn-primary btn-block" onclick="closeModal()">Concluir</button>' +
        '</div>';
    
    }

// Copiar cdigo Pix
function copyPixCode(element) {
    const text = element.textContent.trim();
    navigator.clipboard.writeText(text).then(() => {
        showToast(' Cdigo copiado!', 'success');
    }).catch(() => {
        // Fallback
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast(' Cdigo copiado!', 'success');
    });
}

// ============================================
   // CADASTRO
   // ============================================

// Mscara CPF
function maskCPF(input) {
    let value = input.value.replace(/\D/g, '');
    if (value.length > 11) value = value.slice(0, 11);
    
    // Formata: 000.000.000-00
    if (value.length > 9) {
        value = value.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2}).*/, '$1.$2.$3-$4');
    } else if (value.length > 6) {
        value = value.replace(/(\d{3})(\d{3})(\d{1,3}).*/, '$1.$2.$3');
    } else if (value.length > 3) {
        value = value.replace(/(\d{3})(\d{1,3}).*/, '$1.$2');
    }
    
    input.value = value;
}

// Mscara Telefone
function maskPhone(input) {
    let value = input.value.replace(/\D/g, '');
    if (value.length > 11) value = value.slice(0, 11);
    
    // Formata: (00) 00000-0000
    if (value.length > 7) {
        value = value.replace(/(\d{2})(\d{5})(\d{4}).*/, '($1) $2-$3');
    } else if (value.length > 2) {
        value = value.replace(/(\d{2})(\d{1,5}).*/, '($1) $2');
    } else if (value.length > 0) {
        value = value.replace(/(\d{0,2}).*/, '($1');
    }
    
    input.value = value;
}

// Abre modal de cadastro
function openRegisterModal() {
    document.getElementById('registerModal').classList.add('active');
}

// Fecha modal de cadastro
function closeRegisterModal() {
    document.getElementById('registerModal').classList.remove('active');
}

// Processa cadastro
async function handleRegister(event) {
    event.preventDefault();
    
    const name = document.getElementById('regName').value.trim();
    const lastName = document.getElementById('regLastName').value.trim();
    const cpf = document.getElementById('regCPF').value;
    const phone = document.getElementById('regPhone').value;
    
    try {
        // Se backend ativo, cadastrar no servidor
        if (CONFIG.USE_BACKEND) {
            const response = await fetch(`${CONFIG.API_URL}/api/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, lastName, cpf, phone })
            });
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error(data.error || 'Erro ao cadastrar');
            }
        }
        
        // Salvar localmente (pra usar na compra)
        const buyer = { name, lastName, cpf: cpf.replace(/\D/g, ''), phone };
        localStorage.setItem('gelinsorteio_buyer', JSON.stringify(buyer));
        
        closeRegisterModal();
        showToast(' Cadastro realizado! Agora voc pode comprar.', 'success');
        
        // Limpar formulrio
        document.getElementById('registerForm').reset();
        
    } catch (error) {
        console.error('Error registering:', error);
        showToast(error.message || 'Erro ao cadastrar', 'error');
    }
}

// Get buyer saved
function getSavedBuyer() {
    const saved = localStorage.getItem('gelinsorteio_buyer');
    return saved ? JSON.parse(saved) : null;
}

// ============================================
   // MEUS BILHETES
   // ============================================

// Abre modal de meus bilhetes
function openMyTicketsModal() {
    document.getElementById('myTicketsModal').classList.add('active');
    document.getElementById('myTicketsResult').style.display = 'none';
    document.getElementById('searchCPF').value = '';
    
    // Preencher com CPF salvo (se houver)
    const buyer = getSavedBuyer();
    if (buyer && buyer.cpf) {
        document.getElementById('searchCPF').value = formatCPFDisplay(buyer.cpf);
    }
}

// Fecha modal de meus bilhetes
function closeMyTicketsModal() {
    document.getElementById('myTicketsModal').classList.remove('active');
}

// Formata CPF para exibio
function formatCPFDisplay(cpf) {
    cpf = cpf.replace(/\D/g, '');
    return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2}).*/, '$1.$2.$3-$4');
}

// Busca bilhetes por CPF
async function searchMyTickets(event) {
    event.preventDefault();
    
    const cpf = document.getElementById('searchCPF').value;
    const resultDiv = document.getElementById('myTicketsResult');
    
    try {
        let data;
        
        if (CONFIG.USE_BACKEND) {
            const response = await fetch(`${CONFIG.API_URL}/api/my-tickets?cpf=${encodeURIComponent(cpf)}`);
            data = await response.json();
            
            if (!data.success) {
                throw new Error(data.error || 'Erro ao buscar');
            }
        } else {
            // Modo demo: buscar no localStorage
            throw new Error('Disponvel apenas com backend ativo');
        }
        
        // Mostrar resultado
        showMyTicketsResult(data);
        
    } catch (error) {
        console.error('Error searching tickets:', error);
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = `
            <div class="pix-status error">
                 ${error.message}
            </div>
        `;
    }
}

// Mostra resultado de meus bilhetes
function showMyTicketsResult(data) {
    const resultDiv = document.getElementById('myTicketsResult');
    
    if (data.totalTickets === 0) {
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = `
            <div class="pix-status pending">
                Nenhum bilhete encontrado para este CPF.
            </div>
        `;
        return;
    }
    
    let html = `
        <div class="my-tickets-result-header">
            <span class="my-tickets-buyer-name">${data.buyer.name} ${data.buyer.lastName || ''}</span>
            <span class="my-tickets-count">${data.totalTickets} bilhete${data.totalTickets > 1 ? 's' : ''}</span>
        </div>
    `;
    
    data.purchases.forEach(purchase => {
        const date = new Date(purchase.createdAt).toLocaleDateString('pt-BR');
        html += `
            <div class="my-tickets-purchase">
                <div class="my-tickets-purchase-header">
                    <span class="my-tickets-purchase-date">${date}</span>
                    <span class="my-tickets-purchase-total">R$ ${purchase.total.toFixed(2).replace('.', ',')}</span>
                </div>
                <div class="my-tickets-chips">
                    ${purchase.tickets.map(t => `<span class="my-tickets-chip">#${t}</span>`).join('')}
                </div>
            </div>
        `;
    });
    
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = html;
}

// ============================================
   // INICIALIZAO
   // ============================================
document.addEventListener('DOMContentLoaded', () => {
    loadState();
    updateProgressUI();
    updateMyTicketsUI();
    
    // Fechar modal com ESC
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });
    
    // Fechar modal clicando fora
    document.getElementById('paymentModal').addEventListener('click', (e) => {
        if (e.target.id === 'paymentModal') closeModal();
    });
});
