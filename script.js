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

// -------------------- Estado global --------------------
const state = {
  allRows: [], // todas as linhas sanitizadas
  filtered: [], // após filtros
  latestDate: null,
  latestRows: [], // snapshot com data_base = latestDate
  kpi: {},
  agingBuckets: {},
  byContraparte: {},
  byProduto: {},
  ltmSeries: [],
  // filtros selecionados (valores das dropdowns)
  filtroDataBase: null,
  filtroEmissora: "Todas",
  filtroProduto: "Todos",
  searchTerm: "",
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
    delimiter: ';',
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
  // Sanitiza cada linha
  state.allRows = rawRows.map((r, idx) => {
    return {
      id: buildId(r, idx),
      data_base: sanitiseDate(r.data_base),
      mes: r.mes?.trim() || "",
      empresa: r.empresa?.trim() || "",
      no_operacao: r.no_operacao?.trim() || "",
      banco: r.banco?.trim() || "",
      contraparte: r.contraparte?.trim() || "",
      produto: r.produto?.trim() || "",
      rating: r.rating?.trim() || "",
      indexador: r.indexador?.trim() || "",
      garantia: r.garantia?.replace(/\"/g, "").trim() || "",
      cdi_contratado: sanitisePct(r.cdi_contratado),
      data_aplicacao: sanitiseDate(r.data_aplicacao),
      data_vencimento: sanitiseDate(r.data_vencimento),
      data_carencia: sanitiseDate(r.data_carencia),
      aplicacao_inicial: sanitiseMoney(r.aplicacao_inicial),
      aplicacoes: sanitiseMoney(r.aplicacoes),
      resgates_liquidos: sanitiseMoney(r.resgates_liquidos),
      rendimento_bruto: sanitiseMoney(r.rendimento_bruto),
      irrf_previsto: sanitiseMoney(r.irrf_previsto),
      saldo_liquido_atual: sanitiseMoney(r.saldo_liquido_atual),
      cdi_mes: sanitisePct(r.cdi_mes),
      rentabilidade_esperada: sanitiseMoney(r.rentabilidade_esperada),
      benchmark_100_cdi: sanitiseMoney(r.benchmark_100_cdi),
      perf_vs_benchmark: sanitisePct(r.perf_vs_benchmark),
      alerta_benchmark: r.alerta_benchmark?.trim() || "",
      prazo_restante: parseInt(r.prazo_restante) || 0,
      dias_corridos: parseInt(r.dias_corridos) || 0,
      dias_liquidez: parseInt(r.dias_liquidez) || 0,
      aliquota_irrf: sanitisePct(r.aliquota_irrf),
    };
  });

  rebuildIndices();
  renderApp();
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
  const saldoBruto = state.latestRows.reduce((sum, r) => sum + r.saldo_liquido_atual, 0);
  const bloqueado = state.latestRows.filter(r => r.garantia !== 'Livre').reduce((sum, r) => sum + r.saldo_liquido_atual, 0);
  const liquidezD0 = state.latestRows.filter(r => !r.data_vencimento || (r.data_vencimento && (r.data_vencimento - new Date()) / (1000 * 60 * 60 * 24) <= 0)).reduce((sum, r) => sum + r.saldo_liquido_atual, 0);
  const rentPonderada = state.latestRows.filter(r => r.garantia === 'Livre').reduce((num, r) => num + r.saldo_liquido_atual * r.cdi_contratado, 0) / (state.latestRows.filter(r => r.garantia === 'Livre').reduce((s, r) => s + r.saldo_liquido_atual, 0) || 1);

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
      buckets['Vencido/D+0'] += r.saldo_liquido_atual;
    } else if (diff <= 30) {
      buckets['1‑30'] += r.saldo_liquido_atual;
    } else if (diff <= 90) {
      buckets['31‑90'] += r.saldo_liquido_atual;
    } else if (diff <= 180) {
      buckets['91‑180'] += r.saldo_liquido_atual;
    } else {
      buckets['>180'] += r.saldo_liquido_atual;
    }
  });
  state.agingBuckets = buckets;

  // Agrupamento por contraparte e produto
  const byContraparte = {};
  const byProduto = {};
  state.latestRows.forEach(r => {
    if (!byContraparte[r.contraparte]) byContraparte[r.contraparte] = 0;
    byContraparte[r.contraparte] += r.saldo_liquido_atual;
    if (!byProduto[r.produto]) byProduto[r.produto] = 0;
    byProduto[r.produto] += r.saldo_liquido_atual;
  });
  state.byContraparte = byContraparte;
  state.byProduto = byProduto;

  // LTM series (acumulado mês a mês)
  const byMes = {};
  rows.forEach(r => {
    if (!r.mes) return;
    if (!byMes[r.mes]) byMes[r.mes] = { somaRent: 0, somaSaldo: 0, cdiMes: [] };
    byMes[r.mes].somaRent += r.rendimento_bruto;
    byMes[r.mes].somaSaldo += r.saldo_liquido_atual;
    if (r.cdi_mes) byMes[r.mes].cdiMes.push(r.cdi_mes);
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
  '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981',
  '#06b6d4', '#f43f5e', '#84cc16', '#6366f1', '#14b8a6',
  '#e879f9', '#fb923c', '#22d3ee', '#a3e635', '#c084fc',
];

// -------------------- Chart.js defaults (dark theme) --------------------
Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.font.size = 12;

// -------------------- Renderização --------------------
function renderApp() {
  $('#app').classList.remove('hidden');
  renderKPIs();
  renderAgingChart();
  renderDonut('donut-contraparte-canvas', '#donut-contraparte', state.byContraparte, 'Contraparte');
  renderDonut('donut-produto-canvas', '#donut-produto', state.byProduto, 'Produto');
  renderMaturityAlerts();
  renderLTMChart();
  renderFilterBanner();
  renderTable();
}

function renderKPIs() {
  const container = $('#kpi-strip');
  container.innerHTML = '';
  const pctBloqueado = state.kpi.saldoBruto ? ((state.kpi.bloqueado / state.kpi.saldoBruto) * 100).toFixed(1) : '0.0';
  const icons = ['💰', '🔒', '⚡', '📈'];
  const accents = ['bg-blue-500/15', 'bg-red-500/15', 'bg-emerald-500/15', 'bg-purple-500/15'];
  const cards = [
    { label: 'Saldo Bruto Investido', value: state.kpi.saldoBruto, prefix: 'R$ ', suffix: '', extra: '' },
    { label: 'Bloqueado / Regulatório', value: state.kpi.bloqueado, prefix: 'R$ ', suffix: '', extra: `${pctBloqueado}% do total` },
    { label: 'Liquidez Imediata (D+0)', value: state.kpi.liquidezD0, prefix: 'R$ ', suffix: '', extra: '' },
    { label: 'Rentabilidade LTM', value: state.kpi.rentPonderada * 100, prefix: '', suffix: '%', extra: 'Média ponderada – Livre' },
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
        backgroundColor: ['#10b981', '#34d399', '#6ee7b7', '#a7f3d0', '#f59e0b'],
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
        if (filterKey === 'Contraparte') {
          state.filtroEmissora = selected;
        } else if (filterKey === 'Produto') {
          state.filtroProduto = selected;
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
        { label: 'Rentabilidade', data: rentData, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', tension: 0.35, fill: true, pointRadius: 3, pointBackgroundColor: '#10b981' },
        { label: 'CDI Acumulado', data: cdiData, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.06)', tension: 0.35, fill: true, pointRadius: 3, pointBackgroundColor: '#3b82f6' },
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

function renderFilterBanner() {
  const banner = $('#filter-banner');
  const text = $('#filter-text');
  const hasFilter = (state.filtroEmissora && state.filtroEmissora !== 'Todas') || (state.filtroProduto && state.filtroProduto !== 'Todos');
  if (hasFilter) {
    const parts = [];
    if (state.filtroEmissora !== 'Todas') parts.push(`Contraparte: ${state.filtroEmissora}`);
    if (state.filtroProduto !== 'Todos') parts.push(`Produto: ${state.filtroProduto}`);
    text.textContent = 'Filtro ativo — ' + parts.join(' · ');
    banner.classList.remove('hidden');
    banner.classList.add('flex');
  } else {
    banner.classList.add('hidden');
    banner.classList.remove('flex');
  }
}

function renderTable() {
  const headerRow = $('#table-header');
  const body = $('#table-body');
  const columns = ['no_operacao', 'empresa', 'contraparte', 'produto', 'garantia', 'saldo_liquido_atual', 'cdi_contratado', 'perf_vs_benchmark', 'data_vencimento', 'alerta_benchmark'];
  const colLabels = { no_operacao: 'Operação', empresa: 'Empresa', contraparte: 'Contraparte', produto: 'Produto', garantia: 'Garantia', saldo_liquido_atual: 'Saldo Líquido', cdi_contratado: 'CDI Contr.', perf_vs_benchmark: 'Perf. vs CDI', data_vencimento: 'Vencimento', alerta_benchmark: 'Status' };
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
  // Calcula latestRows sem filtro para obter a base
  const allLatest = state.allRows.filter(r => r.data_base && r.data_base.getTime() === state.latestDate?.getTime());
  const filtered = allLatest.filter(r => {
    const matchContraparte = state.filtroEmissora && state.filtroEmissora !== 'Todas' ? r.contraparte === state.filtroEmissora : true;
    const matchProduto = state.filtroProduto && state.filtroProduto !== 'Todos' ? r.produto === state.filtroProduto : true;
    return matchContraparte && matchProduto;
  });
  state.searchTerm = '';
  $('#search-input').value = '';
  rebuildIndices(filtered); // recompute KPIs based on cross-filtered snapshot
  renderApp();
}

function clearFilters() {
  state.filtroEmissora = 'Todas';
  state.filtroProduto = 'Todos';
  state.searchTerm = '';
  $('#search-input').value = '';
  rebuildIndices();
  renderApp();
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
$('#clear-filter').addEventListener('click', clearFilters);

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
