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
    API_URL: 'https://gelinsorteio-backend-v2.onrender.com',
    
    // true = usar backend (recomendado)
    // false = usar localStorage (modo demo)
    USE_BACKEND: true,
    
    // ============================================
    // ASAAS - Pix automatico (chave fica no backend)
    // O backend cria a cobranca e confirma sozinho.
    // ============================================
    PAYMENT_PROVIDER: 'asaas'
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
    if (CONFIG.USE_BACKEND) {
        try {
            const response = await fetch(CONFIG.API_URL + '/api/stats');
            if (!response.ok) throw new Error('Erro ao buscar stats');
            const data = await response.json();
            if (data.success) {
                return {
                    sold: data.sold,
                    total: data.totalTickets,
                    percent: data.percentage,
                    available: data.available
                };
            }
        } catch (error) {
            console.error('Error fetching stats:', error);
        }
    }
    
    // Fallback: localStorage
    const sold = state.soldTickets.length;
    const percent = Math.round((sold / CONFIG.TOTAL_TICKETS) * 100);
    return { sold, total: CONFIG.TOTAL_TICKETS, percent, available: CONFIG.TOTAL_TICKETS - sold };
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
async function updateProgressUI() {
    const stats = await fetchStats();
    const sold = stats.sold;
    const percent = stats.percent;
    
    document.getElementById('progressFill').style.width = percent + '%';
    document.getElementById('progressPercent').textContent = percent + '%';
    document.getElementById('soldCount').textContent = sold.toLocaleString('pt-BR');
    
    // Se chegou a 100%, mostrar mensagem especial
    if (percent >= 100) {
        showToast('Todos os bilhetes foram vendidos! Sorteio em andamento!', 'success');
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
        // Com Asaas: o backend reserva os bilhetes e cria a cobranca Pix.
        // Os bilhetes so viram "seus" depois que o Pix confirmar (onPaymentConfirmed).
        const total = quantity * CONFIG.TICKET_PRICE;
        showPaymentModal(quantity, total, []);
        
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
                <span>${tickets.slice(0, 5).map(t => formatTicket(t)).join(', ')}${tickets.length > 5 ? ' ... +' + (tickets.length - 5) + ' mais' : ''}</span>
            </div>
            <p style="color: var(--text-secondary); font-size: 0.8rem; margin-top: 8px;">Veja todos os numeros em "Meus bilhetes" apos a compra.</p>
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
// Cria cobranca Pix via backend (Asaas) e mostra QR Code
async function createPixPayment(quantity, total, tickets) {
    const content = document.getElementById('modalContent');

    content.innerHTML =
        '<div class="pix-section">' +
        '<div class="spinner" style="margin: 40px auto;"></div>' +
        '<p style="color: var(--text-secondary); margin-top: 16px;">Gerando codigo Pix...</p>' +
        '</div>';

    try {
        const buyer = getSavedBuyer();
        const response = await fetch(CONFIG.API_URL + '/api/buy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quantity: quantity, buyer: buyer })
        });

        const data = await response.json();

        if (!data.success) {
            if (data.error === 'PIX_INDISPONIVEL') {
                throw new Error('Pagamento Pix ainda nao esta disponivel. Tente em instantes.');
            }
            throw new Error(data.error || 'Erro ao criar pagamento');
        }

        // Guarda a compra pendente na memoria
        window._currentPurchase = {
            purchaseId: data.purchaseId,
            quantity: quantity,
            total: data.total,
            tickets: data.tickets
        };

        // Mostra QR Code real do Asaas
        showAsaasPix(data.pix, data.total, data.tickets);

    } catch (error) {
        console.error('Error creating pix:', error);
        content.innerHTML =
            '<div class="pix-section">' +
            '<div class="pix-status error">' + error.message + '</div>' +
            '<button class="btn btn-secondary btn-block" style="margin-top: 16px;" onclick="closeModal()">Fechar</button>' +
            '</div>';
    }
}

// Mostra QR Code do Asaas e inicia confirmacao automatica
function showAsaasPix(pix, total, tickets) {
    const content = document.getElementById('modalContent');

    let qrImage = '';
    if (pix.qrCodeBase64) {
        qrImage = '<img src="data:image/png;base64,' + pix.qrCodeBase64 + '" alt="QR Code Pix">';
    } else if (pix.copyPaste || pix.qrCode) {
        qrImage = '<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(pix.copyPaste || pix.qrCode) + '" alt="QR Code Pix">';
    } else {
        qrImage = '<p style="color: var(--text-secondary);">QR Code indisponivel. Use o copia e cola abaixo.</p>';
    }

    content.innerHTML =
        '<div class="pix-section">' +
        '<h2 class="modal-title">Pague via Pix</h2>' +
        '<p class="modal-subtitle">Escaneie o QR Code ou use o copia e cola abaixo.</p>' +
        '<div class="pix-qr">' + qrImage + '</div>' +
        '<p style="color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 8px;">Valor: <strong style="color: #FFD700;">R$ ' + total.toFixed(2).replace('.', ',') + '</strong></p>' +
        '<div class="pix-code" onclick="copyPixCode(this)" title="Clique para copiar">' + (pix.copyPaste || pix.qrCode || '') + '</div>' +
        '<p class="pix-instructions">' +
        'Abra o app do seu banco, escolha "Pagar com Pix",<br>' +
        'escaneie o QR Code ou cole o codigo acima.<br>' +
        '<strong style="color:#FF1493;">Seus bilhetes sao liberados automaticamente apos o pagamento.</strong>' +
        '</p>' +
        '<div class="pix-status pending" id="pixStatus">' +
        '<div class="spinner"></div>' +
        'Aguardando pagamento... (confirma automatico)' +
        '</div>' +
        '</div>';

    startPaymentPolling();
}


// Polling: consulta o backend a cada 4s ate o Pix confirmar (automatico)
let pollingInterval = null;

function startPaymentPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    const purchaseId = window._currentPurchase ? window._currentPurchase.purchaseId : null;
    if (!purchaseId) return;

    pollingInterval = setInterval(async () => {
        try {
            const r = await fetch(CONFIG.API_URL + '/api/check-charge/' + purchaseId);
            const data = await r.json();
            if (data.success && (data.status === 'PAID' || data.status === 'RECEIVED' || data.status === 'CONFIRMED')) {
                stopPaymentPolling();
                onPaymentConfirmed();
            } else if (data.success && (data.status === 'CANCELED' || data.status === 'OVERDUE')) {
                stopPaymentPolling();
                const st = document.getElementById('pixStatus');
                if (st) {
                    st.className = 'pix-status error';
                    st.innerHTML = 'Pagamento expirado ou cancelado. Tente novamente.';
                }
            }
        } catch (e) {
            console.error('polling error', e);
        }
    }, 4000);
}

function stopPaymentPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}

// Chamado quando o backend confirma que o Pix caiu (liberou os bilhetes)
function onPaymentConfirmed() {
    const p = window._currentPurchase;
    if (!p) return;

    // Atualiza UI local
    state.myTickets.push(...p.tickets.map(t => parseInt(t)));
    saveState();
    updateProgressUI();
    updateMyTicketsUI();

    // Mostra sucesso
    showSuccessModal(p.tickets.map(t => parseInt(t)), p.total);

    window._currentPurchase = null;
}

// Modal de sucesso
function showSuccessModal(tickets, total) {
        const modalEl = document.getElementById('modalContent');
    
    // Build ticket chips (show max 10, rest as +X)
    let chips = '';
    const maxShow = 10;
    for (let i = 0; i < Math.min(tickets.length, maxShow); i++) {
        chips += '<span class="ticket-chip">#' + formatTicket(tickets[i]) + '</span>';
    }
    if (tickets.length > maxShow) {
        chips += '<span class="ticket-chip ticket-chip-more">+' + (tickets.length - maxShow) + ' mais</span>';
    }
    
    const totalStr = 'R$ ' + total.toFixed(2).replace('.', ',');
    
    modalEl.innerHTML = '<div class="ticket-result">' +
        '<div class="success-celebration">' +
        '<div class="emoji-row">\uD83C\uDF89\uD83D\uDD25\uD83C\uDF88</div>' +
        '<h3>Parabens por adquirir seus bilhetes!</h3>' +
        '<p>Boa sorte no sorteio! \uD83C\uDF89</p>' +
        '</div>' +
        '<h2 class="ticket-result-title">Compra confirmada!</h2>' +
        '<p class="ticket-result-subtitle">Seus bilhetes estao garantidos.</p>' +
        '<div class="tickets-bought">' + chips + '</div>' +
        '<p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 8px;">Total pago: <strong>' + totalStr + '</strong></p>' +
        '<p style="color: #FFD700; font-size: 0.85rem; margin-bottom: 24px;"><a href="#" onclick="openMyTicketsModal(); return false;" style="color: #FFD700;">Ver todos os meus bilhetes</a></p>' +
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
let registerCallback = null;

function openRegisterModal(callback) {
    registerCallback = callback || null;
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
// Mostra resultado de meus bilhetes
function showMyTicketsResult(data) {
    const resultDiv = document.getElementById('myTicketsResult');
    
    // O backend retorna: { success, cpf, tickets: [...] }
    const tickets = data.tickets || [];
    
    if (tickets.length === 0) {
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = `
            <div class="pix-status pending">
                Nenhum bilhete encontrado para este CPF.
            </div>
        `;
        return;
    }
    
    // Buscar dados do comprador (se estiver salvo localmente)
    const buyer = getSavedBuyer();
    const buyerName = buyer ? buyer.name + ' ' + (buyer.lastName || '') : 'Comprador';
    
    let html = `
        <div class="my-tickets-result-header">
            <span class="my-tickets-buyer-name">${buyerName}</span>
            <span class="my-tickets-count">${tickets.length} bilhete${tickets.length > 1 ? 's' : ''}</span>
        </div>
        <div class="my-tickets-purchase">
            <div class="my-tickets-chips">
                ${tickets.map(t => `<span class="my-tickets-chip">#${t}</span>`).join('')}
            </div>
        </div>
    `;
    
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
    
    // Auto-refresh progress every 30 seconds (picks up other people's purchases)
    setInterval(updateProgressUI, 30000);
    
    // Fechar modal com ESC
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });
    
    // Fechar modal clicando fora
    document.getElementById('paymentModal').addEventListener('click', (e) => {
        if (e.target.id === 'paymentModal') closeModal();
    });
});

// ============================================
// LOGIN
// ============================================
function openLoginModal() {
    document.getElementById('loginModal').classList.add('active');
    document.getElementById('loginCPF').value = '';
}

function closeLoginModal() {
    document.getElementById('loginModal').classList.remove('active');
}

function handleLogin() {
    var cpf = document.getElementById('loginCPF').value;
    if (!cpf || cpf.replace(/\D/g, '').length < 11) {
        showToast('Digite um CPF valido');
        return;
    }
    
    // Save buyer to localStorage
    var buyer = { cpf: cpf, name: '', lastName: '', phone: '' };
    localStorage.setItem('gelinsorteio_buyer', JSON.stringify(buyer));
    
    closeLoginModal();
    
    // Open my tickets modal with the CPF pre-filled
    openMyTicketsModal();
    setTimeout(function() {
        document.getElementById('searchCPF').value = cpf;
        searchMyTickets();
    }, 300);
    
    showToast('Logado com sucesso!');
}

// Close login modal when clicking outside
document.addEventListener('click', function(e) {
    var loginModal = document.getElementById('loginModal');
    if (e.target === loginModal) {
        closeLoginModal();
    }
});


// ============================================
// COMPARTILHAR RIFA
// ============================================
function shareRifa() {
    const shareData = {
        title: 'Gelin Sorteio',
        text: 'Participe da rifa Gelin Sorteio! Compre seus bilhetes e concorra a um iPhone 18 Pro Max ou R$ 7.000 no Pix!',
        url: window.location.href
    };
    
    if (navigator.share) {
        // Use native share API (mobile)
        navigator.share(shareData)
            .then(() => console.log('Compartilhado com sucesso!'))
            .catch((error) => console.log('Erro ao compartilhar:', error));
    } else {
        // Fallback: copy to clipboard (desktop)
        const textToCopy = `${shareData.text}\n${shareData.url}`;
        navigator.clipboard.writeText(textToCopy)
            .then(() => {
                showShareToast('Link copiado! Compartilhe com seus amigos 📋');
            })
            .catch((error) => {
                // Last resort: window.prompt
                prompt('Copie o link da rifa:', shareData.url);
            });
    }
}

function showShareToast(message) {
    // Create toast element
    let toast = document.getElementById('shareToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'shareToast';
        toast.className = 'share-toast';
        document.body.appendChild(toast);
    }
    
    toast.textContent = message;
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}
