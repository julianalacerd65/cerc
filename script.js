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
  filtroMes: '',
  filtroEmissora: 'Todas',
  filtroProduto: 'Todos',
  searchTerm: '',
  currentPage: 1,
  pageSize: 10,
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
    skipEmptyLines: 'greedy',
    complete: function (results) {
      if (results.errors.length) {
        console.warn('Avisos ao ler CSV:', results.errors);
        // If it's a completely fatal error and no data was parsed, show alert
        if (!results.data || results.data.length === 0) {
          alert('Erro ao ler CSV: ' + results.errors[0].message);
          return;
        }
      }
      // Filter out rows that are entirely null/empty due to malformed trailing lines
      const validRows = results.data.filter(r => Object.keys(r).some(k => r[k] !== null && r[k] !== ''));
      processRows(validRows);
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

  const hoje = new Date();

  // KPI simples
  const saldoBruto = state.latestRows.reduce((sum, r) => sum + r.saldo_bruto_atual, 0);
  const bloqueado = state.latestRows.filter(r => r.tipo_garantia !== 'Livre').reduce((sum, r) => sum + r.saldo_bruto_atual, 0);
  const liquidezD0 = state.latestRows.filter(r => !r.data_carencia || (r.data_carencia && (r.data_carencia - hoje) / (1000 * 60 * 60 * 24) <= 0)).reduce((sum, r) => sum + r.saldo_bruto_atual, 0);

  state.kpi = {
    saldoBruto,
    bloqueado,
    liquidezD0,
    rentLTM: 0,
    spreadLTM: 0,
  };

  // Liquidity buckets (soma saldo por carência e garantia)
  const buckets = {
    'Livre Hoje': 0,
    'Até 30d': 0,
    '30‑180d': 0,
    '> 180d': 0,
    'Bloqueado': 0,
  };
  state.latestRows.forEach(r => {
    if (r.tipo_garantia !== 'Livre') {
      buckets['Bloqueado'] += r.saldo_bruto_atual;
    } else {
      const diff = r.data_carencia ? Math.floor((r.data_carencia - hoje) / (1000 * 60 * 60 * 24)) : 0;
      if (!r.data_carencia || diff <= 0) {
        buckets['Livre Hoje'] += r.saldo_bruto_atual;
      } else if (diff <= 30) {
        buckets['Até 30d'] += r.saldo_bruto_atual;
      } else if (diff <= 180) {
        buckets['30‑180d'] += r.saldo_bruto_atual;
      } else {
        buckets['> 180d'] += r.saldo_bruto_atual;
      }
    }
  });
  state.liquidezBuckets = buckets;

  // Vencimento buckets (soma saldo por faixa de vencimento)
  const vencimentoBuckets = {
    'Até 30d': 0,
    '30-180d': 0,
    '> 180d': 0,
  };
  state.latestRows.forEach(r => {
    const diff = r.data_vencimento ? Math.floor((r.data_vencimento - hoje) / (1000 * 60 * 60 * 24)) : 0;
    if (!r.data_vencimento || diff <= 30) {
      vencimentoBuckets['Até 30d'] += r.saldo_bruto_atual;
    } else if (diff <= 180) {
      vencimentoBuckets['30-180d'] += r.saldo_bruto_atual;
    } else {
      vencimentoBuckets['> 180d'] += r.saldo_bruto_atual;
    }
  });
  state.vencimentoBuckets = vencimentoBuckets;

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
    if (!byMes[r.mes_label]) byMes[r.mes_label] = { somaRent: 0, somaSaldo: 0, cdiMes: 0 };
    if (r.tipo_garantia === 'Livre') {
      byMes[r.mes_label].somaRent += r.rentabilidade_mensal;
      byMes[r.mes_label].somaSaldo += r.saldo_bruto_atual;
    }
    if (r.taxa_cdi_mensal > byMes[r.mes_label].cdiMes) {
      byMes[r.mes_label].cdiMes = r.taxa_cdi_mensal;
    }
  });

  const sortedMeses = Object.keys(byMes).sort();
  const series = [];
  sortedMeses.forEach((mes, index) => {
    const startIndex = Math.max(0, index - 11);
    const windowMeses = sortedMeses.slice(startIndex, index + 1);
    
    let totalRent = 0;
    let sumSaldo = 0;
    let cdiCompound = 1;
    
    windowMeses.forEach(m => {
      totalRent += byMes[m].somaRent;
      sumSaldo += byMes[m].somaSaldo;
      cdiCompound *= (1 + byMes[m].cdiMes);
    });
    
    const mediaSaldo = sumSaldo / Math.max(1, windowMeses.length);
    const rentPct = mediaSaldo ? totalRent / mediaSaldo : 0;
    const cdiLTM = cdiCompound - 1;
    
    series.push({ mes, rentPct, cdiLTM });
  });
  state.ltmSeries = series;

  // Selected mes to fetch LTM for KPIs
  const targetMes = state.filtroMes || (state.latestDate ? `${state.latestDate.getFullYear()}-${String(state.latestDate.getMonth() + 1).padStart(2, '0')}` : null);
  const currentLtm = series.find(s => s.mes === targetMes) || series[series.length - 1] || { rentPct: 0, cdiLTM: 0 };
  state.kpi.rentLTM = currentLtm.rentPct;
  state.kpi.spreadLTM = currentLtm.rentPct - currentLtm.cdiLTM;
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
  
  const saldoLiquido = state.kpi.saldoBruto - state.kpi.bloqueado;
  const pctLiquido = state.kpi.saldoBruto ? ((saldoLiquido / state.kpi.saldoBruto) * 100).toFixed(1) : '0.0';
  
  const cdiLTM = state.kpi.spreadLTM + state.kpi.rentLTM;
  const pctCaixaCdi = cdiLTM ? ((state.kpi.rentLTM / cdiLTM) * 100).toFixed(1) : '0.0';

  const colors = ['#00689e', '#f59e0b', '#10b981', '#e0e0e0', '#e0e0e0'];
  const valueColors = ['#000000', '#f59e0b', '#10b981', '#000000', '#00689e'];

  const cards = [
    { label: 'SALDO BRUTO INVESTIDO', value: state.kpi.saldoBruto, prefix: 'R$ ', suffix: 'M', extra: '14 aplicações ativas - Base Mar/2026', extraIcon: '' },
    { label: 'BLOQUEADO / REGULATÓRIO', value: state.kpi.bloqueado, prefix: 'R$ ', suffix: 'M', extra: `${pctBloqueado}% do saldo bruto - LFTs Tesouro`, extraIcon: '🔒' },
    { label: 'SALDO LÍQUIDO TOTAL', value: saldoLiquido, prefix: 'R$ ', suffix: 'M', extra: `${pctLiquido}% do bruto`, extraIcon: '' },
    { label: 'RENTABILIDADE LTM', value: state.kpi.rentLTM * 100, prefix: '', suffix: '%', extra: '-0,66 p.p. vs mês ant.', extraIcon: '↓' },
    { label: 'CAIXA VS CDI LTM', value: parseFloat(pctCaixaCdi), prefix: '', suffix: '%', extra: `CDI LTM: ${(cdiLTM * 100).toFixed(2)}%`, extraIcon: '' },
  ];

  cards.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'kpi-card';
    div.style.setProperty('--kpi-color', colors[i]);
    div.style.setProperty('--kpi-value-color', valueColors[i]);

    let extraHtml = c.extra;
    if (i === 1) extraHtml = `<span>${c.extraIcon}</span> ${c.extra}`;
    if (i === 2) extraHtml = `<span class="text-green-500 font-bold">${c.extra}</span>`;
    if (i === 3) extraHtml = `<span class="bg-red-100 text-red-600 px-1 rounded text-[9px] font-bold">${c.extraIcon}</span> ${c.extra}`;
    if (i === 4) extraHtml = `<span class="text-orange-500 font-bold">${c.extra}</span>`;

    div.innerHTML = `
      <span class="kpi-label">${c.label}</span>
      <span class="kpi-value counted">${c.prefix}0${c.suffix}</span>
      <span class="kpi-extra">${extraHtml}</span>
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
      
      let val = current;
      if (c.prefix === 'R$ ') {
         val = current / 1e6;
      }
      
      span.textContent = c.prefix + val.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + c.suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function renderAgingChart() {
  destroyChart('aging');
  const ctx = $('#aging-canvas');
  const labels = Object.keys(state.liquidezBuckets);
  const data = Object.values(state.liquidezBuckets);
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
  const labels = Object.keys(state.vencimentoBuckets);
  const data = Object.values(state.vencimentoBuckets);
  chartInstances.fluxo = new Chart(ctx, {
    type: 'bar',
    data: { 
      labels, 
      datasets: [{ 
        label: 'Saldo (R$)', 
        data, 
        backgroundColor: ['#00689e', '#07b3af', '#0ae4d2'],
        borderRadius: 6,
        maxBarThickness: 48,
      }] 
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
    }
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
  const hoje = new Date();
  
  const upcoming = state.latestRows
    .filter(r => {
      if (!r.data_vencimento) return false;
      const days = Math.ceil((r.data_vencimento - hoje) / (1000 * 60 * 60 * 24));
      return days >= 0 && days <= 60;
    })
    .sort((a, b) => a.data_vencimento - b.data_vencimento);
    
  if (!upcoming.length) {
    list.innerHTML = '<li class="text-textMuted text-sm p-2">Nenhum vencimento nos próximos 60 dias.</li>';
    return;
  }
  
  upcoming.forEach(r => {
    const days = Math.ceil((r.data_vencimento - hoje) / (1000 * 60 * 60 * 24));
    
    const isCritical = days < 30; // red
    const isWarning = days >= 30 && days < 45; // yellow
    
    let colorHex = isCritical ? '#ef4444' : (isWarning ? '#f59e0b' : '#10b981');
    let bgClass = isCritical ? 'bg-white border-red-200' : (isWarning ? 'bg-white border-yellow-200' : 'bg-white border-green-200');
    
    const taxa = (r.taxa_cdi_contratada * 100).toFixed(1) + '%';
    const saldo = 'R$ ' + (r.saldo_bruto_atual / 1e6).toFixed(2).replace('.', ',') + 'M';
    
    const li = document.createElement('li');
    li.className = `flex justify-between items-center p-3 rounded-lg border ${bgClass} transition-colors text-sm shadow-sm mb-2 relative`;
    
    const vencText = r.data_vencimento ? r.data_vencimento.toLocaleDateString('pt-BR', {day: '2-digit', month: 'short', year: 'numeric'}) : '';
    
    li.innerHTML = `
      <div class="flex items-start gap-3">
        <div class="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style="background-color: ${colorHex};"></div>
        <div>
          <div class="font-bold text-[11px] text-textPrimary">
            ${r.produto} ${r.banco} — ${taxa} CDI
          </div>
          <div class="font-medium text-[10px] text-textMuted mt-0.5">
            Vence em ${days} dias - ${vencText}
          </div>
        </div>
      </div>
      <div class="font-bold text-[11px]" style="color: ${colorHex};">
        ${saldo}
      </div>
    `;
    list.appendChild(li);
  });
}

function renderLTMChart() {
  destroyChart('ltm');
  const ctx = $('#ltm-canvas');
  const labels = state.ltmSeries.map(s => s.mes);
  const rentData = state.ltmSeries.map(s => (s.rentPct * 100).toFixed(2));
  const cdiData = state.ltmSeries.map(s => (s.cdiLTM * 100).toFixed(2));
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
  
  headerRow.innerHTML = `
    <th class="pb-3 px-2 font-medium whitespace-nowrap">Produto</th>
    <th class="pb-3 px-2 font-medium whitespace-nowrap">Emissor</th>
    <th class="pb-3 px-2 font-medium whitespace-nowrap text-right">Taxa</th>
    <th class="pb-3 px-2 font-medium whitespace-nowrap text-right">Saldo Bruto</th>
    <th class="pb-3 px-2 font-medium whitespace-nowrap text-right">Saldo Líquido</th>
    <th class="pb-3 px-2 font-medium whitespace-nowrap text-right">Rent. Mês</th>
    <th class="pb-3 px-2 font-medium whitespace-nowrap">Vencimento</th>
    <th class="pb-3 px-2 font-medium whitespace-nowrap text-center">Prazo Rest.</th>
    <th class="pb-3 px-2 font-medium whitespace-nowrap">Liquidez</th>
    <th class="pb-3 px-2 font-medium whitespace-nowrap">Rating</th>
    <th class="pb-3 px-2 font-medium whitespace-nowrap text-center">Dias p/ IRRF</th>
  `;

  let visible = state.latestRows.filter(r => {
    if (!state.searchTerm) return true;
    const term = state.searchTerm;
    return (r.emissor?.toLowerCase().includes(term) || r.produto?.toLowerCase().includes(term) || r.banco?.toLowerCase().includes(term));
  });

  // Sort default by data_vencimento ASC
  visible.sort((a, b) => {
    const valA = a.data_vencimento ? a.data_vencimento.getTime() : Infinity;
    const valB = b.data_vencimento ? b.data_vencimento.getTime() : Infinity;
    return valA - valB;
  });

  // Pagination logic
  const total = visible.length;
  const start = (state.currentPage - 1) * state.pageSize;
  const end = Math.min(start + state.pageSize, total);
  
  const pageRows = visible.slice(start, end);

  // Update DOM for pagination
  $('#page-total').textContent = total;
  $('#page-total-2').textContent = total;
  
  $('#btn-prev-page').disabled = state.currentPage === 1;
  $('#btn-next-page').disabled = end >= total;

  body.innerHTML = '';
  if (!pageRows.length) {
    body.innerHTML = `<tr><td colspan="11" class="py-4 text-center text-textMuted">Nenhuma operação encontrada para os filtros aplicados.</td></tr>`;
    return;
  }
  
  const hoje = new Date();

  pageRows.forEach(r => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-surface2 transition-colors group cursor-default text-sm';
    
    // Destaque Condicional
    let isVencimentoProximo = false;
    let isResgatavel = false;
    
    const diasVenc = r.data_vencimento ? Math.ceil((r.data_vencimento - hoje) / (1000 * 60 * 60 * 24)) : Infinity;
    
    if (diasVenc < 15) isVencimentoProximo = true;
    if (r.dias_carencia_restante <= 0 && r.tipo_garantia === 'Livre') isResgatavel = true;
    
    if (isResgatavel) {
      tr.classList.add('bg-accentRed/5');
      tr.classList.remove('hover:bg-surface2');
      tr.classList.add('hover:bg-accentRed/10');
    } else if (isVencimentoProximo) {
      tr.classList.add('bg-accentOrange/5');
      tr.classList.remove('hover:bg-surface2');
      tr.classList.add('hover:bg-accentOrange/10');
    }
    
    const isBloqueado = r.tipo_garantia !== 'Livre';
    const padlock = isBloqueado ? '<span class="text-xs ml-1" title="Bloqueado">🔒</span>' : '';
    
    const taxaFmt = (r.taxa_cdi_contratada * 100).toFixed(1) + '%';
    const brutoFmt = r.saldo_bruto_atual.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const liquidoFmt = (r.saldo_liquido_atual || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    
    // Rentabilidade Mês
    const rentPct = r.saldo_bruto_atual ? (r.rentabilidade_mensal / r.saldo_bruto_atual) * 100 : 0;
    const rentFmt = rentPct.toFixed(3) + '%';
    
    const vencFmt = r.data_vencimento ? r.data_vencimento.toLocaleDateString('pt-BR') : '-';
    
    tr.innerHTML = `
      <td class="py-2 px-2 whitespace-nowrap font-medium">${r.produto}</td>
      <td class="py-2 px-2 whitespace-nowrap">${r.emissor}</td>
      <td class="py-2 px-2 whitespace-nowrap text-right font-medium">${taxaFmt}</td>
      <td class="py-2 px-2 whitespace-nowrap text-right font-medium">${brutoFmt}${padlock}</td>
      <td class="py-2 px-2 whitespace-nowrap text-right">${liquidoFmt}</td>
      <td class="py-2 px-2 whitespace-nowrap text-right text-accentTeal">${rentFmt}</td>
      <td class="py-2 px-2 whitespace-nowrap">${vencFmt}</td>
      <td class="py-2 px-2 whitespace-nowrap text-center">${r.dias_carencia_restante !== null ? r.dias_carencia_restante : '-'}</td>
      <td class="py-2 px-2 whitespace-nowrap"><span class="px-1.5 py-0.5 rounded text-[9px] font-bold ${r.tipo_garantia === 'Livre' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}">${r.classificacao_liquidez || '-'}</span></td>
      <td class="py-2 px-2 whitespace-nowrap">${r.rating || '-'}</td>
      <td class="py-2 px-2 whitespace-nowrap text-center">${r.dias_para_irrf_menor !== null ? r.dias_para_irrf_menor : '-'}</td>
    `;
    body.appendChild(tr);
  });
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
  state.currentPage = 1;
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
  state.currentPage = 1;
  renderTable();
});
$('#clear-filter-btn').addEventListener('click', clearFilters);

$('#btn-prev-page').addEventListener('click', () => {
  if (state.currentPage > 1) {
    state.currentPage--;
    renderTable();
  }
});

$('#btn-next-page').addEventListener('click', () => {
  state.currentPage++;
  renderTable();
});

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
