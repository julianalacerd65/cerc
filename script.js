// script.js
// Dashboard Tesouraria Executiva – CERC (Português)
// Dependencies: PapaParse, Chart.js (CDNs already loaded in index.html)

// -------------------- Utilidades de sanitização --------------------
function sanitiseMoney(s) {
  // Converte string como "1.234,56" → número float 1234.56
  if (!s) return 0;
  return parseFloat(s.replace(/\./g, "").replace(/,/g, ".")) || 0;
}
function sanitisePct(s) {
  // Converte "5,25%" → 0.0525
  if (!s) return 0;
  return parseFloat(s.replace(/%/g, "").replace(/\./g, "").replace(/,/g, ".")) / 100 || 0;
}
function sanitiseDate(s) {
  // Formato esperado DD/MM/AAAA → Date object ou null
  if (!s) return null;
  const parts = s.split("/");
  if (parts.length !== 3) return null;
  const [d, m, a] = parts.map(Number);
  const date = new Date(a, m - 1, d);
  return isNaN(date) ? null : date;
}
function buildId(row, idx) {
  // Usa no_operacao se houver, senão cria hash simples
  if (row.no_operacao && row.no_operacao.trim() !== "") return row.no_operacao;
  // fallback: hash do banco + índice
  const str = `${row.banco || ""}-${idx}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return `id_${Math.abs(hash)}`;
}

// -------------------- Tabela IOF (regressiva em dias) --------------------
const IOF_TABLE = {
  1:96,2:93,3:90,4:86,5:83,6:80,7:76,8:73,9:70,10:66,
  11:63,12:60,13:56,14:53,15:50,16:46,17:43,18:40,19:36,
  20:33,21:30,22:26,23:23,24:20,25:16,26:13,27:10,28:6,29:3
};
// Faixas de IRRF (dias mínimos para cada alíquota)
const IRRF_BRACKETS = [180, 360, 720, Infinity]; // 22.5%, 20%, 17.5%, 15%
const IRRF_RATES    = [22.5, 20, 17.5, 15];

function calcDiasParaIrrfMenor(diasDecorridos) {
  // Retorna quantos dias faltam para cair na próxima faixa menor de IRRF
  for (let i = 0; i < IRRF_BRACKETS.length - 1; i++) {
    if (diasDecorridos < IRRF_BRACKETS[i]) {
      return IRRF_BRACKETS[i] - diasDecorridos;
    }
  }
  return 0; // já está na alíquota mínima (15%)
}

function calcClassificacaoLiquidez(dataCarencia, tipoGarantia) {
  const hoje = new Date();
  if (tipoGarantia && tipoGarantia !== 'Livre') return 'Bloqueado';
  if (!dataCarencia) return 'Livre Hoje';
  const diffMs = dataCarencia - hoje;
  const dias = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (dias <= 0)  return 'Livre Hoje';
  if (dias <= 30) return 'Até 30 dias';
  if (dias <= 180) return '30-180 dias';
  return 'Acima 180 dias';
}

// -------------------- Estado global --------------------
const state = {
  allRows:    [],   // todas as linhas sanitizadas (todos os meses)
  latestDate: null, // data_base mais recente disponível
  latestRows: [],   // snapshot: apenas linhas do mês selecionado
  kpi:        {},
  liquidezBuckets: {},
  vencimentoBuckets: {},
  byEmissor:  {},
  byProduto:  {},
  byRating:   {},
  ltmSeries:  [],
  // filtros
  filtroDataBase:  null,   // Date | null → null = mais recente
  filtroEmissores: [],     // [] = todos
  filtroProdutos:  [],     // [] = todos
  searchTerm: '',
};

// -------------------- UI Helpers --------------------
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function showModal() {
  $('#url-modal').style.display = 'flex';
}
function hideModal() {
  $('#url-modal').style.display = 'none';
}

function setStatus(message) {
  // opcional: exibir toast ou console log
  console.log(message);
}

// -------------------- Carregamento de CSV --------------------
function loadCsv(url) {
  setStatus('Carregando CSV...');
  Papa.parse(url, {
    download: true,
    header: true,
    dynamicTyping: false,
    skipEmptyLines: true,
    complete: function (results) {
      if (results.errors.length) {
        alert('Erro ao ler CSV: ' + results.errors[0].message);
        console.error(results.errors);
        return;
      }
      processRows(results.data);
    },
    error: function (err) {
      alert('Falha ao baixar CSV: ' + err.message);
    },
  });
}

// -------------------- Processamento e cálculo --------------------
function processRows(rawRows) {
  const hoje = new Date();

  state.allRows = rawRows.map((r, idx) => {
    // --- Datas ---
    const data_base      = sanitiseDate(r['data_base']);
    const data_inicial   = sanitiseDate(r['data_inicial']);
    const data_vencimento = sanitiseDate(r['data_vencimento']);
    const data_carencia  = sanitiseDate(r['data_carencia']);

    // --- Tipo de garantia (trim necessário pois campo tem espaço no CSV) ---
    const tipo_garantia = (r['tipo_garantia'] || '').trim();

    // --- Campos financeiros ---
    const saldo_bruto_atual    = sanitiseMoney(r['saldo_bruto_atual']);
    const saldo_liquido_atual  = sanitiseMoney(r['saldo_liquido_atual']);
    const taxa_cdi_contratada  = sanitisePct(r['taxa_cdi_contratada']);   // ex: 96% → 0.96
    const taxa_cdi_mensal      = sanitisePct(r['taxa_cdi_mensal']);       // ex: 0,97% → 0.0097
    const rentabilidade_mensal = sanitiseMoney(r['rentabilidade_mensal']); // valor em R$

    // --- Campos derivados calculados no frontend ---
    const diasDecorridos = data_inicial
      ? Math.floor((hoje - data_inicial) / (1000 * 60 * 60 * 24))
      : 0;
    const dias_carencia_restante = data_carencia
      ? Math.max(0, Math.ceil((data_carencia - hoje) / (1000 * 60 * 60 * 24)))
      : 0;
    const classificacao_liquidez = calcClassificacaoLiquidez(data_carencia, tipo_garantia);
    const dias_para_irrf_menor   = calcDiasParaIrrfMenor(diasDecorridos);

    // Label do mês para agrupamento LTM (ex: "2024-01")
    const mes_label = data_base
      ? `${data_base.getFullYear()}-${String(data_base.getMonth() + 1).padStart(2, '0')}`
      : '';

    return {
      id:                    buildId(r, idx),
      data_base,
      mes_label,
      empresa:               (r['empresa']     || '').trim(),
      no_operacao:           (r['no_operacao']  || '').trim(),
      banco:                 (r['banco']        || '').trim(),
      emissor:               (r['emissor']      || '').trim(),
      produto:               (r['produto']      || '').trim(),
      rating:                (r['Rating']       || r['rating'] || '').trim(), // CSV usa 'Rating' (maiúsculo)
      indexador:             (r['indexador']    || '').trim(),
      tipo_garantia,
      taxa_cdi_contratada,   // 0..1 (ex 0.96 para 96%)
      taxa_cdi_mensal,       // 0..1 (ex 0.0097 para 0,97%)
      data_inicial,
      data_vencimento,
      data_carencia,
      aplicacao_inicial:     sanitiseMoney(r['aplicacao_inicial']),
      saldo_mes_anterior:    sanitiseMoney(r['saldo_mes_anterior']),
      aplicacoes_no_mes:     sanitiseMoney(r['aplicacoes_no_mes']),
      resgates_liquido:      sanitiseMoney(r['resgates_liquido']),
      iof_mes:               sanitiseMoney(r['iof_mes']),
      irrf_mes:              sanitiseMoney(r['irrf_mes']),
      rendimentos:           sanitiseMoney(r['rendimentos']),       // R$ gerado no mês
      rentabilidade_mensal,  // alias (mesmo campo)
      saldo_bruto_atual,
      irrf_final_previsto:   sanitiseMoney(r['irrf_final_previsto']),
      saldo_liquido_atual,
      // Derivados
      dias_carencia_restante,
      classificacao_liquidez,
      dias_para_irrf_menor,
    };
  });

  populateFilters();
  rebuildIndices();
  renderApp();
}

function populateFilters() {
  const allMeses = [...new Set(state.allRows.map(r => r.mes_label).filter(Boolean))].sort().reverse();
  const allEmissores = [...new Set(state.allRows.map(r => r.emissor).filter(Boolean))].sort();
  const allProdutos = [...new Set(state.allRows.map(r => r.produto).filter(Boolean))].sort();

  const mesSelect = $('#filter-mes');
  const emissorSelect = $('#filter-emissor');
  const produtoSelect = $('#filter-produto');

  mesSelect.innerHTML = '<option value="">Mais recente</option>';
  allMeses.forEach(m => mesSelect.add(new Option(m, m)));
  
  emissorSelect.innerHTML = '<option value="Todas">Todos</option>';
  allEmissores.forEach(e => emissorSelect.add(new Option(e, e)));
  
  produtoSelect.innerHTML = '<option value="Todos">Todos</option>';
  allProdutos.forEach(p => produtoSelect.add(new Option(p, p)));
}

function rebuildIndices(overrideLatestRows) {
  const rows = state.allRows;

  // Determina data_base mais recente (sempre de allRows)
  const dates = rows.map(r => r.data_base).filter(d => d);
  if (dates.length) {
    state.latestDate = new Date(Math.max(...dates.map(d => d.getTime())));
  } else {
    state.latestDate = null;
  }

  // Snapshot latestRows (usa override quando cross-filter está ativo)
  if (overrideLatestRows) {
    state.latestRows = overrideLatestRows;
  } else {
    state.latestRows = rows.filter(r => r.data_base && r.data_base.getTime() === state.latestDate?.getTime());
  }

  // KPI simples
  const saldoBruto = state.latestRows.reduce((sum, r) => sum + r.saldo_bruto_atual, 0);
  const bloqueado = state.latestRows.filter(r => r.tipo_garantia !== 'Livre').reduce((sum, r) => sum + r.saldo_bruto_atual, 0);
  const liquidezD0 = state.latestRows.filter(r => !r.data_vencimento || (r.data_vencimento && (r.data_vencimento - new Date()) / (1000 * 60 * 60 * 24) <= 0)).reduce((sum, r) => sum + r.saldo_bruto_atual, 0);
  const rentPonderada = state.latestRows.filter(r => r.tipo_garantia === 'Livre').reduce((num, r) => num + r.saldo_bruto_atual * r.taxa_cdi_contratada, 0) / (state.latestRows.filter(r => r.tipo_garantia === 'Livre').reduce((s, r) => s + r.saldo_bruto_atual, 0) || 1);

  state.kpi = {
    saldoBruto,
    bloqueado,
    liquidezD0,
    rentPonderada,
  };

  // Aging buckets (soma saldo por faixa de vencimento — todos os ativos)
  const buckets = {
    'Vencido/D+0': 0,
    '1‑30': 0,
    '31‑90': 0,
    '91‑180': 0,
    '>180': 0,
  };
  const hoje = new Date();
  state.latestRows.forEach(r => {
    const diff = r.data_vencimento ? Math.floor((r.data_vencimento - hoje) / (1000 * 60 * 60 * 24)) : 0;
    if (!r.data_vencimento || diff <= 0) {
      buckets['Vencido/D+0'] += r.saldo_bruto_atual;
    } else if (diff <= 30) {
      buckets['1‑30'] += r.saldo_bruto_atual;
    } else if (diff <= 90) {
      buckets['31‑90'] += r.saldo_bruto_atual;
    } else if (diff <= 180) {
      buckets['91‑180'] += r.saldo_bruto_atual;
    } else {
      buckets['>180'] += r.saldo_bruto_atual;
    }
  });
  state.agingBuckets = buckets;

  // Agrupamento por emissor, produto e rating
  const byEmissor = {};
  const byProduto = {};
  const byRating = {};
  state.latestRows.forEach(r => {
    if (!byEmissor[r.emissor]) byEmissor[r.emissor] = 0;
    byEmissor[r.emissor] += r.saldo_bruto_atual;
    
    if (!byProduto[r.produto]) byProduto[r.produto] = 0;
    byProduto[r.produto] += r.saldo_bruto_atual;
    
    const rtg = r.rating || 'N/A';
    if (!byRating[rtg]) byRating[rtg] = 0;
    byRating[rtg] += r.saldo_bruto_atual;
  });
  state.byEmissor = byEmissor;
  state.byProduto = byProduto;
  state.byRating = byRating;

  // LTM series (acumulado mês a mês)
  const byMes = {};
  rows.forEach(r => {
    if (!r.mes_label) return;
    if (!byMes[r.mes_label]) byMes[r.mes_label] = { somaRent: 0, somaSaldo: 0, cdiMes: [] };
    byMes[r.mes_label].somaRent += r.rentabilidade_mensal;
    byMes[r.mes_label].somaSaldo += r.saldo_bruto_atual;
    if (r.taxa_cdi_mensal) byMes[r.mes_label].cdiMes.push(r.taxa_cdi_mensal);
  });
  const series = [];
  Object.keys(byMes).sort().forEach(mes => {
    const data = byMes[mes];
    const rentPct = data.somaSaldo ? data.somaRent / data.somaSaldo : 0;
    const cdiMedian = data.cdiMes.length ? data.cdiMes.sort()[Math.floor(data.cdiMes.length / 2)] : 0;
    series.push({ mes, rentPct, cdiMedian });
  });
  state.ltmSeries = series;
}

// -------------------- Referências a charts (para destruir antes de recriar) --------------------
let chartInstances = {};
function destroyChart(key) {
  if (chartInstances[key]) { chartInstances[key].destroy(); chartInstances[key] = null; }
}

// -------------------- Palette de cores para donuts --------------------
const PALETTE = [
  '#00689e', '#07b3af', '#0ae4d2', '#1a8bb2', '#33a3cc',
  '#4dcce6', '#004f7a', '#058c8a', '#08b5a6', '#2699bf',
  '#17709b', '#209dbf', '#36d9cf', '#0b5978', '#118a88',
];

// -------------------- Chart.js defaults (light theme) --------------------
Chart.defaults.color = '#666666';
Chart.defaults.borderColor = '#e0e0e0';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.font.size = 12;

// -------------------- Renderização --------------------
function renderApp() {
  $('#app').classList.remove('hidden');
  renderKPIs();
  renderAgingChart();
  renderFluxoChart();
  
  renderDonut('donut-emissor-canvas', '#donut-emissor', state.byEmissor, 'Emissor');
  renderDonut('donut-produto-canvas', '#donut-produto', state.byProduto, 'Produto');
  renderDonut('donut-rating-canvas', '#donut-rating', state.byRating, 'Rating');
  
  renderMaturityAlerts();
  renderLTMChart();
  renderTable();
}

function renderKPIs() {
  const container = $('#kpi-strip');
  container.innerHTML = '';
  const pctBloqueado = state.kpi.saldoBruto ? ((state.kpi.bloqueado / state.kpi.saldoBruto) * 100).toFixed(1) : '0.0';
  const icons = ['💰', '🔒', '⚡', '📈', '📊'];
  const accents = ['bg-accentBlue/15', 'bg-accentOrange/15', 'bg-accentTeal/15', 'bg-accentCyan/15', 'bg-accentBlue/15'];
  const cards = [
    { label: 'Saldo Bruto Investido', value: state.kpi.saldoBruto, prefix: 'R$ ', suffix: '', extra: '' },
    { label: 'Bloqueado / Regulatório', value: state.kpi.bloqueado, prefix: 'R$ ', suffix: '', extra: `${pctBloqueado}% do total` },
    { label: 'Liquidez Imediata (D+0)', value: state.kpi.liquidezD0, prefix: 'R$ ', suffix: '', extra: '' },
    { label: 'Rentabilidade LTM', value: state.kpi.rentPonderada * 100, prefix: '', suffix: '%', extra: 'Média ponderada – Livre' },
    { label: 'Rent vs CDI (Spread)', value: 0, prefix: '', suffix: '%', extra: 'Spread sobre CDI' },
  ];
  cards.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'kpi-card glass';
    div.innerHTML = `
      <div class="kpi-icon ${accents[i]}">${icons[i]}</div>
      <span class="kpi-label">${c.label}</span>
      <span class="kpi-value counted">${c.prefix}0${c.suffix}</span>
      ${c.extra ? `<span class="kpi-extra">${c.extra}</span>` : ''}
    `;
    container.appendChild(div);
    // count-up animation
    const span = div.querySelector('.kpi-value');
    const target = parseFloat(c.value);
    const duration = 1200;
    let start = null;
    const step = (ts) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3); // ease-out cubic
      const current = target * ease;
      span.textContent = c.prefix + (c.suffix === '%' ? current.toFixed(2) : current.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + c.suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function renderAgingChart() {
  destroyChart('aging');
  const ctx = $('#aging-canvas');
  const labels = Object.keys(state.agingBuckets);
  const data = Object.values(state.agingBuckets);
  chartInstances.aging = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Saldo (R$)',
        data,
        backgroundColor: ['#0ae4d2', '#07b3af', '#00689e', '#004f7a', '#003655'],
        borderRadius: 6,
        borderSkipped: false,
        maxBarThickness: 48,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => 'R$ ' + ctx.parsed.y.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) } },
      },
      scales: {
        y: { beginAtZero: true, ticks: { callback: v => 'R$ ' + (v / 1e6).toFixed(1) + 'M' } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderFluxoChart() {
  destroyChart('fluxo');
  const ctx = $('#fluxo-canvas');
  if (!ctx) return;
  chartInstances.fluxo = new Chart(ctx, {
    type: 'bar',
    data: { labels: ['< 30d', '31-90d', '> 90d'], datasets: [{ label: 'Fluxo (Mock)', data: [0, 0, 0], backgroundColor: '#07b3af' }] },
    options: { responsive: true, maintainAspectRatio: false }
  });
}

function renderDonut(canvasId, containerId, dataMap, filterKey) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  const labels = Object.keys(dataMap);
  const values = Object.values(dataMap);
  chartInstances[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]),
        borderWidth: 0,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 10, padding: 8, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => {
          const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
          const pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
          return `R$ ${ctx.parsed.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} (${pct}%)`;
        }}},
      },
      onClick: (e, elements) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        const selected = labels[idx];
        if (filterKey === 'Emissor') {
          state.filtroEmissora = selected;
          $('#filter-emissor').value = selected;
        } else if (filterKey === 'Produto') {
          state.filtroProduto = selected;
          $('#filter-produto').value = selected;
        }
        applyFiltersAndRender();
      },
    },
  });
}

function renderMaturityAlerts() {
  const list = $('#alerts-list');
  list.innerHTML = '';
  const upcoming = state.latestRows
    .filter(r => r.data_vencimento && (r.data_vencimento - new Date()) / (1000 * 60 * 60 * 24) > 0)
    .sort((a, b) => a.data_vencimento - b.data_vencimento)
    .slice(0, 10);
  if (!upcoming.length) {
    list.innerHTML = '<li class="text-textMuted text-sm">Nenhum vencimento próximo.</li>';
    return;
  }
  upcoming.forEach(r => {
    const days = Math.ceil((r.data_vencimento - new Date()) / (1000 * 60 * 60 * 24));
    const cls = days <= 30 ? 'alert-pill--red' : days <= 90 ? 'alert-pill--amber' : 'alert-pill--green';
    const li = document.createElement('li');
    li.className = `alert-pill ${cls}`;
    li.innerHTML = `<strong>${days}d</strong> ${r.empresa} · ${r.produto} · ${r.data_vencimento.toLocaleDateString('pt-BR')}`;
    list.appendChild(li);
  });
}

function renderLTMChart() {
  destroyChart('ltm');
  const ctx = $('#ltm-canvas');
  const labels = state.ltmSeries.map(s => s.mes);
  const rentData = state.ltmSeries.map(s => (s.rentPct * 100).toFixed(2));
  const cdiData = state.ltmSeries.map(s => (s.cdiMedian * 100).toFixed(2));
  chartInstances.ltm = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Rentabilidade', data: rentData, borderColor: '#0ae4d2', backgroundColor: 'rgba(10,228,210,0.08)', tension: 0.35, fill: true, pointRadius: 3, pointBackgroundColor: '#0ae4d2' },
        { label: 'CDI Acumulado', data: cdiData, borderColor: '#00689e', backgroundColor: 'rgba(0,104,158,0.06)', tension: 0.35, fill: true, pointRadius: 3, pointBackgroundColor: '#00689e' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { boxWidth: 10, padding: 16 } } },
      scales: {
        y: { ticks: { callback: v => v + '%' } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderTable() {
  const headerRow = $('#table-header');
  const body = $('#table-body');
  const columns = ['no_operacao', 'empresa', 'emissor', 'produto', 'tipo_garantia', 'saldo_bruto_atual', 'taxa_cdi_contratada', 'data_vencimento'];
  const colLabels = { no_operacao: 'Operação', empresa: 'Empresa', emissor: 'Emissor', produto: 'Produto', tipo_garantia: 'Garantia', saldo_bruto_atual: 'Saldo Bruto', taxa_cdi_contratada: 'CDI Contr.', data_vencimento: 'Vencimento' };
  headerRow.innerHTML = '';
  columns.forEach(col => {
    const th = document.createElement('th');
    th.textContent = colLabels[col] || col;
    th.dataset.col = col;
    th.addEventListener('click', () => sortTableBy(col));
    headerRow.appendChild(th);
  });
  // rows filtered by search
  let rows = state.latestRows;
  if (state.searchTerm) {
    rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(state.searchTerm)));
  }
  body.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    columns.forEach(col => {
      const td = document.createElement('td');
      let val = r[col];
      if (val instanceof Date) val = val.toLocaleDateString('pt-BR');
      if (typeof val === 'number') {
        if (col.includes('cdi') || col.includes('perf')) {
          val = (val * 100).toFixed(2) + '%';
        } else if (col.includes('saldo') || col.includes('aplicacao')) {
          val = val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        }
      }
      td.textContent = val ?? '';
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}

function sortTableBy(col) {
  state.latestRows.sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    if (av instanceof Date && bv instanceof Date) return av - bv;
    return String(av).localeCompare(String(bv));
  });
  renderTable();
}

function applyFiltersAndRender() {
  // Filtra de acordo com mês, emissor, produto
  // Se filtroMes não estiver setado, pega do mês mais recente
  const targetMes = state.filtroMes || (state.latestDate ? `${state.latestDate.getFullYear()}-${String(state.latestDate.getMonth() + 1).padStart(2, '0')}` : null);
  
  const allLatest = targetMes ? state.allRows.filter(r => r.mes_label === targetMes) : state.allRows;
  
  const filtered = allLatest.filter(r => {
    const matchEmissor = state.filtroEmissora && state.filtroEmissora !== 'Todas' ? r.emissor === state.filtroEmissora : true;
    const matchProduto = state.filtroProduto && state.filtroProduto !== 'Todos' ? r.produto === state.filtroProduto : true;
    return matchEmissor && matchProduto;
  });
  state.searchTerm = '';
  $('#search-input').value = '';
  rebuildIndices(filtered); // recompute KPIs based on cross-filtered snapshot
  renderApp();
}

function clearFilters() {
  state.filtroMes = '';
  state.filtroEmissora = 'Todas';
  state.filtroProduto = 'Todos';
  state.searchTerm = '';
  $('#filter-mes').value = '';
  $('#filter-emissor').value = 'Todas';
  $('#filter-produto').value = 'Todos';
  $('#search-input').value = '';
  applyFiltersAndRender();
}

// -------------------- Eventos UI --------------------
$('#connect-btn').addEventListener('click', () => {
  const url = $('#csv-url-input').value.trim();
  if (!url) { alert('Informe a URL do CSV'); return; }
  localStorage.setItem('cerc_csv_url', url);
  hideModal();
  loadCsv(url);
});
$('#cancel-btn').addEventListener('click', hideModal);
$('#reset-url').addEventListener('click', () => {
  localStorage.removeItem('cerc_csv_url');
  showModal();
});
$('#export-csv').addEventListener('click', () => {
  const rows = state.latestRows;
  const csv = Papa.unparse(rows, { delimiter: ';' });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', 'cerc_export.csv');
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});
$('#search-input').addEventListener('input', (e) => {
  state.searchTerm = e.target.value.toLowerCase();
  renderTable();
});
$('#clear-filter-btn').addEventListener('click', clearFilters);

['#filter-mes', '#filter-emissor', '#filter-produto'].forEach(id => {
  $(id).addEventListener('change', (e) => {
    if (id === '#filter-mes') state.filtroMes = e.target.value;
    if (id === '#filter-emissor') state.filtroEmissora = e.target.value;
    if (id === '#filter-produto') state.filtroProduto = e.target.value;
    applyFiltersAndRender();
  });
});

// -------------------- Inicialização --------------------
window.addEventListener('load', () => {
  const storedUrl = localStorage.getItem('cerc_csv_url');
  if (storedUrl) {
    loadCsv(storedUrl);
  } else {
    showModal();
  }
});

// Fim do script
