/* ============================================================
   Audit report viewer — all logic. Config/data/strings live in
   app.config.json; styling lives in styles.css. No business data
   or branding is hardcoded here.
   ============================================================ */

// Populate every [data-t] (text), [data-tp] (placeholder) and [data-ttitle]
// (title) node from the config, plus the side dropdown and brand assets.
function applyConfig(C) {
  const get = path => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), C);
  document.querySelectorAll('[data-t]').forEach(el => { const v = get(el.dataset.t); if (v != null) el.textContent = v; });
  document.querySelectorAll('[data-tp]').forEach(el => { const v = get(el.dataset.tp); if (v != null) el.setAttribute('placeholder', v); });
  document.querySelectorAll('[data-ttitle]').forEach(el => { const v = get(el.dataset.ttitle); if (v != null) el.title = v; });

  document.title = C.report.title;
  const logo = document.getElementById('lhLogo'); if (logo) logo.src = C.brand.logo;
  const side = document.getElementById('side');
  if (side) side.innerHTML = C.sides.map(s => `<option value="${s.value}">${s.label}</option>`).join('');
}

(async function () {
  const CONFIG = await fetch('app.config.json').then(r => r.json());
  applyConfig(CONFIG);

  const SB = CONFIG.supabase;
  const cfg = { url: SB.url, anonKey: SB.anonKey, ingestUrl: SB.functions.ingest, usersUrl: SB.functions.users };
  const RPC = SB.rpc;
  const DIMS = CONFIG.dimensions;
  const TBL = CONFIG.tables, MISC = CONFIG.misc, DM = CONFIG.docMeta;
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey);

  const fmt = n => (n < 0 ? '(' : '') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + (n < 0 ? ')' : '');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const dateToTs = v => v ? parseInt(v.replace(/-/g, ''), 10) : null;
  const tsToInput = ts => { const s = String(ts); return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : ''; };
  const setStatus = (txt, cls) => { const el = document.getElementById('status'); el.textContent = txt || ''; el.className = 'status' + (cls ? ' ' + cls : ''); };

  let DATA = { divisions: [] };
  let groupBy = 'dimension';   // 'dimension' | 'division'

  // ---------- load ----------
  async function loadData() {
    setStatus('Loading…');
    const { data, error } = await sb.rpc(RPC.report);
    if (error) { setStatus('Load error: ' + error.message, 'err'); return; }
    const dimsData = (data && data.dimensions) || [];
    const all = (data && data.transactions) || [];

    // group transactions: Division -> Cost Dimension -> Project
    const dimOrder = new Map(dimsData.map(d => [d.name, d]));
    const divNum = name => { const m = String(name).match(/(\d+)/); return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER; };
    const byDiv = new Map();
    for (const r of all) {
      const div = r.division || MISC.defaultDivision;
      if (!byDiv.has(div)) byDiv.set(div, new Map());
      const byDim = byDiv.get(div);
      if (!byDim.has(r.cost_dimension)) byDim.set(r.cost_dimension, new Map());
      const projs = byDim.get(r.cost_dimension);
      if (!projs.has(r.project)) projs.set(r.project, []);
      projs.get(r.project).push({
        date: r.txn_date ? r.txn_date.split('-').reverse().join('/') : '', ts: r.ts,
        type: r.voucher_type, no: r.voucher_no, ref: r.ref_no, memo: r.memo,
        debit: Number(r.debit), credit: Number(r.credit),
      });
    }
    const divisions = [...byDiv.entries()].map(([divName, byDim]) => ({
      name: divName, order: divNum(divName),
      dimensions: [...byDim.entries()].map(([dimName, projs]) => {
        const meta = dimOrder.get(dimName) || {};
        return {
          name: dimName, order: meta.sort_order ?? 99, account: meta.account || '', from: meta.period_from || '', to: meta.period_to || '',
          projects: [...projs.entries()].map(([pn, txns]) => ({ name: pn, txns })).sort((a, b) => b.txns.length - a.txns.length),
        };
      }).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    })).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

    DATA = { divisions };
    buildControls();
    render();
    if (!divisions.length) setStatus('No data yet — use “Upload” to add data.', '');
  }

  // ---------- controls ----------
  // Generic multi-select: builds the checkbox menu and reflects selection as count + chips.
  function buildMS(values, menuId, chkClass, countId, chipsId) {
    document.getElementById(menuId).innerHTML = values.length
      ? values.map(n => `<label><input type="checkbox" class="${chkClass}" value="${esc(n)}" checked> ${esc(n)}</label>`).join('')
      : `<div style="padding:8px;color:#888">${esc(MISC.noneLabel)}</div>`;
    document.querySelectorAll('.' + chkClass).forEach(c => c.addEventListener('change', () => { renderMS(chkClass, countId, chipsId); render(); }));
    renderMS(chkClass, countId, chipsId);
  }
  function renderMS(chkClass, countId, chipsId) {
    const all = [...document.querySelectorAll('.' + chkClass)];
    const checked = all.filter(c => c.checked);
    document.getElementById(countId).textContent =
      !all.length ? MISC.noneLabel : checked.length === all.length ? `All (${all.length})` : `${checked.length} ${MISC.selectedSuffix}`;
    const MAX = 4;
    let html = checked.slice(0, MAX).map(c => `<span class="chip">${esc(c.value)} <b data-unchk="${esc(c.value)}">✕</b></span>`).join('');
    if (checked.length > MAX) html += `<span class="chip more">+${checked.length - MAX}</span>`;
    const chips = document.getElementById(chipsId);
    chips.innerHTML = html;
    chips.querySelectorAll('[data-unchk]').forEach(x => x.addEventListener('click', () => {
      const cb = all.find(c => c.value === x.dataset.unchk);
      if (cb) { cb.checked = false; renderMS(chkClass, countId, chipsId); render(); }
    }));
  }

  function buildControls() {
    const allDivs = DATA.divisions.map(d => d.name);
    const allDims = [...new Set(DATA.divisions.flatMap(d => d.dimensions.map(x => x.name)))];
    buildMS(allDivs, 'divMenu', 'divchk', 'divCount', 'divChips');
    buildMS(allDims, 'dimMenu', 'dimchk', 'dimCount', 'dimChips');

    const allProjs = DATA.divisions.flatMap(d => d.dimensions.flatMap(x => x.projects));
    const projNames = [...new Set(allProjs.map(p => p.name))].sort();
    document.getElementById('projlist').innerHTML = projNames.map(n => `<option value="${esc(n)}">`).join('');
    const types = [...new Set(allProjs.flatMap(p => p.txns.map(t => t.type)))].filter(Boolean).sort();
    document.getElementById('vtype').innerHTML = `<option value="">${esc(MISC.allTypes)}</option>` + types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    let minTs = Infinity, maxTs = -Infinity;
    allProjs.forEach(p => p.txns.forEach(t => { if (t.ts) { minTs = Math.min(minTs, t.ts); maxTs = Math.max(maxTs, t.ts); } }));
    const f = document.getElementById('from'), t = document.getElementById('to');
    if (isFinite(minTs)) { f.min = t.min = tsToInput(minTs); f.max = t.max = tsToInput(maxTs); }
  }

  function currentFilters() {
    return {
      divs: new Set([...document.querySelectorAll('.divchk:checked')].map(c => c.value)),
      dims: new Set([...document.querySelectorAll('.dimchk:checked')].map(c => c.value)),
      q: document.getElementById('proj').value.trim().toLowerCase(),
      rsearch: document.getElementById('reportSearch').value.trim().toLowerCase(),
      nos: document.getElementById('vno').value.split(',').map(s => s.trim()).filter(Boolean),
      vtype: document.getElementById('vtype').value,
      side: document.getElementById('side').value,
      search: document.getElementById('search').value.trim().toLowerCase(),
      from: dateToTs(document.getElementById('from').value),
      to: dateToTs(document.getElementById('to').value),
    };
  }

  function buildNoMatch(tokens) {
    if (!tokens.length) return null;
    const singles = new Set(), ranges = [];
    tokens.forEach(tok => {
      const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) { let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a]; ranges.push([a, b]); }
      else tok.split(/\s+/).filter(Boolean).forEach(x => singles.add(x));
    });
    return no => { const s = String(no); if (singles.has(s)) return true; const n = Number(s); return Number.isFinite(n) && ranges.some(([a, b]) => n >= a && n <= b); };
  }

  function matchTxn(t, f, noMatch) {
    return (f.from == null || t.ts >= f.from) && (f.to == null || t.ts <= f.to) &&
      (!noMatch || noMatch(t.no)) && (!f.vtype || t.type === f.vtype) &&
      (!f.side || (f.side === 'debit' ? t.debit > 0 : t.credit > 0)) &&
      (!f.search || (t.memo + ' ' + t.ref + ' ' + t.type + ' ' + t.no).toLowerCase().includes(f.search));
  }

  function filtersSummary(f, gP, gT, net) {
    const L = CONFIG.text.labels, S = CONFIG.text.summary;
    const parts = [S.divisions + ': ' + ([...f.divs].join(', ') || MISC.noneLabel),
                   S.dimensions + ': ' + ([...f.dims].join(', ') || MISC.noneLabel)];
    if (f.q) parts.push(L.project + ': "' + f.q + '"');
    if (f.nos.length) parts.push(L.voucherNo + ': ' + f.nos.join(', '));
    if (f.vtype) parts.push(L.voucherType + ': ' + f.vtype);
    if (f.side) parts.push(L.side + ': ' + (CONFIG.sides.find(s => s.value === f.side) || {}).label);
    if (f.search) parts.push(L.search + ': "' + f.search + '"');
    if (f.from || f.to) parts.push(L.fromDate + '/' + L.toDate + ': ' + (f.from ? tsToInput(f.from) : '…') + ' → ' + (f.to ? tsToInput(f.to) : '…'));
    return parts.join('  ·  ') + `  ·  ${S.projects}: ${gP} · ${S.transactions}: ${gT} · ${S.net}: ${net}`;
  }

  // ---------- render ----------
  function soaHead() {
    return '<thead><tr>' + TBL.statement.map((h, i) => `<th${i >= 5 ? ' class="amt"' : ''}>${esc(h)}</th>`).join('') + '</tr></thead>';
  }
  function ptblHead() {
    return '<thead><tr>' + TBL.projectsSummary.map((h, i) => `<th${i === 2 ? ' class="num"' : i >= 3 ? ' class="amt"' : ''}>${esc(h)}</th>`).join('') + '</tr></thead>';
  }

  // Render one group block (a Division or a Cost Dimension) with its merged projects.
  function groupBlock(name, projectsMap, f, noMatch, meta) {
    const projHtml = [], summaryRows = [];
    let dD = 0, dC = 0, dT = 0;
    const projs = [...projectsMap.entries()].sort((a, b) => b[1].length - a[1].length);

    projs.forEach(([pname, allTxns]) => {
      if (f.q && !pname.toLowerCase().includes(f.q)) return;
      if (f.rsearch && !pname.toLowerCase().includes(f.rsearch)) return;
      const txns = allTxns.filter(t => matchTxn(t, f, noMatch)).sort((a, b) => (a.ts - b.ts));
      if (!txns.length) return;
      let bal = 0, td = 0, tc = 0;
      const rows = txns.map(t => {
        bal += t.debit - t.credit; td += t.debit; tc += t.credit;
        return `<tr><td class="date">${esc(t.date)}</td><td dir="auto">${esc(t.type)}</td>
          <td class="num">${esc(t.no)}</td><td dir="auto">${esc(t.ref)}</td><td dir="auto" class="memo">${esc(t.memo)}</td>
          <td class="amt">${t.debit ? fmt(t.debit) : ''}</td><td class="amt">${t.credit ? fmt(t.credit) : ''}</td>
          <td class="amt ${bal < 0 ? 'neg' : ''}">${fmt(bal)}</td></tr>`;
      }).join('');
      const net = td - tc;
      dD += td; dC += tc; dT += txns.length;
      const idx = summaryRows.length + 1;
      summaryRows.push(`<tr><td class="num">${idx}</td><td dir="auto" class="pname">${esc(pname)}</td>
        <td class="num">${txns.length}</td><td class="amt">${fmt(td)}</td><td class="amt">${fmt(tc)}</td>
        <td class="amt ${net < 0 ? 'neg' : ''}">${fmt(net)}</td></tr>`);
      projHtml.push(`<section class="project">
        <div class="ph"><span class="pidx">${esc(name)} · ${idx}.</span> <span dir="auto">${esc(pname)}</span></div>
        <div class="soa-label">${esc(MISC.statementOfAccount)}</div>
        <table class="soa">${soaHead()}
          <tbody>${rows}</tbody>
          <tfoot><tr class="totals"><td colspan="5">Total — ${txns.length} transaction(s)</td>
            <td class="amt">${fmt(td)}</td><td class="amt">${fmt(tc)}</td>
            <td class="amt ${net < 0 ? 'neg' : ''}">${fmt(net)}</td></tr></tfoot>
        </table></section>`);
    });

    if (!summaryRows.length) return null;
    const html = `<div class="dimension">
      <div class="dimhead"><span class="dimname">${esc(name)}</span>
        <button class="btn-export" data-group="${esc(name)}">${esc(MISC.exportToExcel)}</button></div>
      <div class="dimbody">
        <div class="dimmeta"><span>${esc(DM.account)}: ${esc(meta.account || '')}</span><span>${esc(DM.period)}: ${esc(meta.from || '')} – ${esc(meta.to || '')}</span><span>${esc(DM.projects)}: ${summaryRows.length}</span></div>
        <div class="ptitle">${esc(MISC.projectsSummaryTitle)}</div>
        <table class="ptbl">${ptblHead()}
          <tbody>${summaryRows.join('')}</tbody>
          <tfoot><tr><td colspan="2">${esc(name)} Total</td><td class="num">${dT}</td>
            <td class="amt">${fmt(dD)}</td><td class="amt">${fmt(dC)}</td>
            <td class="amt ${dD - dC < 0 ? 'neg' : ''}">${fmt(dD - dC)}</td></tr></tfoot>
        </table>
        ${projHtml.join('')}
      </div>
    </div>`;
    return { html, dD, dC, dT, projects: summaryRows.length };
  }

  // Collapse the data to a single grouping level (Division OR Cost Dimension).
  function buildGroups(f) {
    const index = new Map(), list = [];
    const get = (nm, order) => { if (!index.has(nm)) { const g = { name: nm, order, projects: new Map() }; index.set(nm, g); list.push(g); } return index.get(nm); };
    DATA.divisions.forEach(div => {
      if (!f.divs.has(div.name)) return;
      div.dimensions.forEach(dim => {
        if (!f.dims.has(dim.name)) return;
        const g = groupBy === 'division' ? get(div.name, div.order) : get(dim.name, dim.order);
        dim.projects.forEach(p => {
          if (!g.projects.has(p.name)) g.projects.set(p.name, []);
          const arr = g.projects.get(p.name);
          for (const t of p.txns) arr.push(t);
        });
      });
    });
    list.sort((a, b) => a.order - b.order || String(a.name).localeCompare(String(b.name)));
    return list;
  }

  function render() {
    const f = currentFilters();
    const noMatch = buildNoMatch(f.nos);
    const meta = (DATA.divisions[0] && DATA.divisions[0].dimensions[0]) || {};
    let gD = 0, gC = 0, gT = 0, gP = 0;
    const divSet = new Set(), dimSet = new Set();

    // distinct divisions / cost dimensions that actually have matching rows
    DATA.divisions.forEach(div => {
      if (!f.divs.has(div.name)) return;
      div.dimensions.forEach(dim => {
        if (!f.dims.has(dim.name)) return;
        const has = dim.projects.some(p =>
          (!f.q || p.name.toLowerCase().includes(f.q)) && (!f.rsearch || p.name.toLowerCase().includes(f.rsearch)) &&
          p.txns.some(t => matchTxn(t, f, noMatch)));
        if (has) { divSet.add(div.name); dimSet.add(dim.name); }
      });
    });

    const out = [];
    buildGroups(f).forEach(g => {
      const block = groupBlock(g.name, g.projects, f, noMatch, meta);
      if (!block) return;
      gD += block.dD; gC += block.dC; gT += block.dT; gP += block.projects;
      out.push(block.html);
    });

    document.getElementById('report').innerHTML = out.length ? out.join('') :
      (DATA.divisions.length ? '<div class="empty">No transactions match the current filters.</div>' : '');

    document.getElementById('s-div').textContent = divSet.size;
    document.getElementById('s-dims').textContent = dimSet.size;
    document.getElementById('s-proj').textContent = gP;
    document.getElementById('s-tx').textContent = gT.toLocaleString();
    document.getElementById('s-deb').textContent = fmt(gD);
    document.getElementById('s-cred').textContent = fmt(gC);
    const net = document.getElementById('s-net'); net.textContent = fmt(gD - gC); net.classList.toggle('neg', gD - gC < 0);
    setStatus('');

    // Header metadata reflects the active filters.
    const anyDim = meta;
    const ALL = MISC.allLabel;
    const tsToDMY = ts => { const s = String(ts); return s.length === 8 ? s.slice(6, 8) + '/' + s.slice(4, 6) + '/' + s.slice(0, 4) : ''; };
    const divsAll = f.divs.size === DATA.divisions.length;
    const allDimNames = new Set(DATA.divisions.flatMap(d => d.dimensions.map(x => x.name)));
    const dimsAll = f.dims.size === allDimNames.size;
    const sideLabel = (CONFIG.sides.find(s => s.value === f.side) || {}).label || ALL;
    const metaRows = [
      [DM.accountName, anyDim.account || ''],
      [DM.fromDate, f.from ? tsToDMY(f.from) : (anyDim.from || '')],
      [DM.toDate, f.to ? tsToDMY(f.to) : (anyDim.to || '')],
      [DM.division, divsAll ? ALL : ([...f.divs].join(', ') || ALL)],
      [DM.costDimension, dimsAll ? ALL : ([...f.dims].join(', ') || ALL)],
      [DM.voucherType, f.vtype || ALL],
      [DM.side, sideLabel],
    ];
    if (f.q || f.rsearch) metaRows.push([DM.project, [f.q, f.rsearch].filter(Boolean).join(', ')]);
    if (f.nos.length) metaRows.push([DM.voucherNo, f.nos.join(', ')]);
    document.getElementById('docMeta').innerHTML =
      metaRows.map(([l, v]) => `<tr><td class="lbl">${esc(l)}</td><td>${esc(v)}</td></tr>`).join('');

    document.getElementById('printHeader').innerHTML =
      '<h1>' + esc(MISC.statementOfAccount) + '</h1><div class="pf">' + esc(filtersSummary(f, gP, gT.toLocaleString(), fmt(gD - gC))) + '</div>';
  }

  // ---------- export to Excel ----------
  function rowsForGroup(projectsMap, f, noMatch) {
    const aoa = [TBL.excel.slice()];
    const projs = [...projectsMap.entries()].sort((a, b) => b[1].length - a[1].length);
    projs.forEach(([pname, allTxns]) => {
      if (f.q && !pname.toLowerCase().includes(f.q)) return;
      if (f.rsearch && !pname.toLowerCase().includes(f.rsearch)) return;
      const txns = allTxns.filter(t => matchTxn(t, f, noMatch)).sort((a, b) => (a.ts - b.ts)); let bal = 0;
      txns.forEach(t => { bal += t.debit - t.credit; aoa.push([pname, t.date, t.type, t.no, t.ref, t.memo, t.debit, t.credit, bal]); });
    });
    return aoa;
  }
  function exportGroup(name) {
    const f = currentFilters();
    const g = buildGroups(f).find(x => x.name === name); if (!g) return;
    const aoa = rowsForGroup(g.projects, f, buildNoMatch(f.nos));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name.slice(0, 31).replace(/[\\/?*\[\]:]/g, ' '));
    XLSX.writeFile(wb, name.replace(/[^\w]+/g, '_') + '.xlsx');
  }
  function exportAllExcel() {
    const f = currentFilters(), noMatch = buildNoMatch(f.nos), wb = XLSX.utils.book_new(), used = {}; let any = false;
    buildGroups(f).forEach(g => {
      const aoa = rowsForGroup(g.projects, f, noMatch);
      if (aoa.length > 1) {
        let nm = g.name.slice(0, 28).replace(/[\\/?*\[\]:]/g, ' ');
        if (used[nm]) nm = nm.slice(0, 25) + (++used[nm]); else used[nm] = 1;
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), nm); any = true;
      }
    });
    if (any) XLSX.writeFile(wb, CONFIG.report.exportFileName + '.xlsx'); else alert('No rows to export with the current filters.');
  }
  async function exportWord() {
    let logoData = '';
    try { const blob = await (await fetch(CONFIG.brand.logo)).blob(); logoData = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); }); } catch (e) {}
    const style = '<style>body{font-family:"Segoe UI",Arial,sans-serif;font-size:11px;}table{border-collapse:collapse;width:100%;margin-bottom:10px}th,td{border:1px solid #9aa7b5;padding:4px 6px}thead th{background:#14304f;color:#fff}</style>';
    const body = docEl.innerHTML.replace(/src="[^"]*logo[^"]*"/, 'src="' + logoData + '"');
    const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">' + style + '</head><body>' + body + '</body></html>';
    const blob = new Blob(['﻿' + html], { type: 'application/msword' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = CONFIG.report.exportFileName + '.doc'; a.click(); URL.revokeObjectURL(a.href);
  }
  document.getElementById('report').addEventListener('click', e => {
    const b = e.target.closest('.btn-export'); if (b) exportGroup(b.dataset.group);
  });

  // group-by toggle (Division vs Cost Dimension)
  document.querySelectorAll('.gb-btn').forEach(btn => btn.addEventListener('click', () => {
    groupBy = btn.dataset.group;
    document.querySelectorAll('.gb-btn').forEach(b => b.classList.toggle('active', b === btn));
    render();
  }));

  // ---------- multi-select dropdowns ----------
  [['divBox', 'divMenu'], ['dimBox', 'dimMenu']].forEach(([boxId, menuId]) => {
    const box = document.getElementById(boxId), menu = document.getElementById(menuId);
    box.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
    menu.addEventListener('click', e => e.stopPropagation());
  });
  document.addEventListener('click', () => { document.getElementById('divMenu').classList.remove('open'); document.getElementById('dimMenu').classList.remove('open'); });

  // ---------- in-browser Excel parsing ----------
  // Division from the Excel "Division" header (typo-tolerant). Empty when absent —
  // stored as '' in the DB (so re-uploads replace cleanly) and shown as the default label.
  function resolveDivision(meta) {
    return String(meta.division || '').trim().replace(/Divison/gi, 'Division');
  }
  function resolveDimension(meta, fname) {
    const candidates = [meta.costDimension || '', fname.replace(/\.xlsx$/i, '')];
    for (let i = 0; i < DIMS.length; i++) {
      const d = DIMS[i];
      if (candidates.some(c => { const low = c.toLowerCase(); return low.includes(d.key) || (d.alt || []).some(a => low.includes(a)); }))
        return { name: d.name, order: i };
    }
    const hdr = (meta.costDimension || '').trim();
    return { name: hdr && hdr.toLowerCase() !== 'all' ? hdr : fname.replace(/\.xlsx$/i, ''), order: DIMS.length };
  }
  const numv = s => { s = String(s).trim().replace(/,/g, ''); if (!s) return 0; if (s.startsWith('(') && s.endsWith(')')) return -(parseFloat(s.replace(/[()]/g, '')) || 0); return parseFloat(s) || 0; };
  function excelDateDMY(v) {
    if (v === '' || v == null) return '';
    if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); if (!d) return String(v); const p = n => String(n).padStart(2, '0'); return `${p(d.d)}/${p(d.m)}/${d.y}`; }
    return String(v);
  }
  const tsFromDMY = s => { const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? parseInt(m[3] + m[2] + m[1], 10) : 0; };
  const isoFromDMY = s => { const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

  function parseWorkbook(fname, wb) {
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const LABELS = { 'account name': 'account', 'from date': 'from', 'to date': 'to', 'cost dimesion': 'costDimension', 'cost dimension': 'costDimension', 'division': 'division' };
    const meta = {}; let hdr = -1;
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].map(c => String(c).trim());
      cells.forEach((c, j) => { const key = LABELS[c.toLowerCase()];
        if (key && meta[key] === undefined) { const idx = cells.slice(j + 1).findIndex(x => x !== '');
          if (idx >= 0) { const raw = rows[i][j + 1 + idx]; meta[key] = /date/i.test(c) ? excelDateDMY(raw) : String(raw).trim(); } } });
      if (cells.includes('Date') && cells.includes('Voucher Type')) { hdr = i; break; }
    }
    if (hdr < 0) throw new Error('No transaction table header (Date / Voucher Type) found.');
    const col = {}; rows[hdr].forEach((c, j) => { const n = String(c).trim().toLowerCase().replace(/\.$/, ''); if (n && !(n in col)) col[n] = j; });
    const ix = { date: col['date'] ?? 0, type: col['voucher type'] ?? 1, no: col['no'] ?? 2, cc: col['costcenter'] ?? 3, ref: col['ref no'] ?? 4, memo: col['memo'] ?? 5, debit: col['debit'] ?? 6, credit: col['credit'] ?? 7 };
    const out = [];
    for (let i = hdr + 1; i < rows.length; i++) {
      const r = rows[i]; const proj = String(r[ix.cc]).trim();
      if (String(r[ix.memo]).trim() === 'Transactions') continue;
      if (!proj) continue;
      const dmy = excelDateDMY(r[ix.date]);
      out.push({ seq: out.length, project: proj, date: dmy, ts: tsFromDMY(dmy), iso: isoFromDMY(dmy),
        type: String(r[ix.type]).trim(), no: String(r[ix.no]).trim(), ref: String(r[ix.ref]).trim(),
        memo: String(r[ix.memo]).trim(), debit: numv(r[ix.debit]), credit: numv(r[ix.credit]) });
    }
    return { meta, rows: out };
  }

  // ---------- upload flow ----------
  const modalBg = document.getElementById('modalBg'), fileInput = document.getElementById('file'),
        drop = document.getElementById('drop'), keyInput = document.getElementById('key'),
        doUpload = document.getElementById('doUpload'), msg = document.getElementById('msg');
  let picked = null;
  function openModal() { msg.textContent = ''; modalBg.classList.add('show'); }
  function closeModal() { modalBg.classList.remove('show'); picked = null; fileInput.value = ''; drop.textContent = MISC.dropPrompt; refreshUploadBtn(); }
  function refreshUploadBtn() { doUpload.disabled = !(picked && keyInput.value.trim()); }
  function setPicked(fl) { picked = fl; drop.textContent = fl ? fl.name : MISC.dropPrompt; refreshUploadBtn(); }
  document.getElementById('uploadBtn').addEventListener('click', openModal);
  document.getElementById('cancelUpload').addEventListener('click', closeModal);
  modalBg.addEventListener('click', e => { if (e.target === modalBg) closeModal(); });
  drop.addEventListener('click', () => fileInput.click());
  drop.textContent = MISC.dropPrompt;
  fileInput.addEventListener('change', () => setPicked(fileInput.files[0] || null));
  keyInput.addEventListener('input', refreshUploadBtn);
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hot'); }));
  drop.addEventListener('drop', e => { const fl = e.dataTransfer.files[0]; if (fl) setPicked(fl); });
  doUpload.addEventListener('click', async () => {
    if (!picked) return;
    doUpload.disabled = true; msg.style.color = '#555'; msg.textContent = 'Parsing…';
    try {
      const buf = await picked.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const { meta, rows } = parseWorkbook(picked.name, wb);
      const dim = resolveDimension(meta, picked.name);
      const division = resolveDivision(meta);
      const divLabel = division || MISC.defaultDivision;
      msg.textContent = `Parsed ${rows.length} rows → ${divLabel} / ${dim.name}. Uploading…`;
      const res = await fetch(cfg.ingestUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': cfg.anonKey },
        body: JSON.stringify({ secret: keyInput.value.trim(), division, dimension: dim.name, sort_order: dim.order, account: meta.account || '', from: meta.from || '', to: meta.to || '', rows }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
      msg.style.color = '#1a7f37'; msg.textContent = `Saved ${body.inserted} rows to ${divLabel} / ${body.dimension}.`;
      await loadData();
      setTimeout(closeModal, 900);
    } catch (e) { msg.style.color = '#b00020'; msg.textContent = 'Failed: ' + e.message; doUpload.disabled = false; }
  });

  // ---------- filter events ----------
  let t = null;
  const deb = () => { clearTimeout(t); t = setTimeout(render, 180); };
  ['proj', 'vno', 'search', 'reportSearch'].forEach(id => document.getElementById(id).addEventListener('input', deb));
  ['from', 'to', 'vtype', 'side'].forEach(id => document.getElementById(id).addEventListener('change', render));
  document.getElementById('apply').addEventListener('click', render);
  document.getElementById('moreFilters').addEventListener('click', () => document.getElementById('row2').classList.toggle('hidden'));
  document.getElementById('reset').addEventListener('click', () => {
    document.querySelectorAll('.divchk, .dimchk').forEach(c => c.checked = true);
    ['proj', 'vno', 'search', 'from', 'to', 'vtype', 'side', 'reportSearch'].forEach(id => document.getElementById(id).value = '');
    renderMS('divchk', 'divCount', 'divChips'); renderMS('dimchk', 'dimCount', 'dimChips'); render();
  });

  // ---------- report viewer toolbar ----------
  const docEl = document.getElementById('doc'), docwrap = document.getElementById('docwrap');
  document.getElementById('zoom').addEventListener('change', e => { docEl.style.zoom = e.target.value; });
  document.getElementById('vrefresh').addEventListener('click', () => loadData());
  document.getElementById('firstPage').addEventListener('click', () => docwrap.scrollTo({ top: 0, behavior: 'smooth' }));
  document.getElementById('lastPage').addEventListener('click', () => docwrap.scrollTo({ top: docwrap.scrollHeight, behavior: 'smooth' }));
  document.getElementById('prevPage').addEventListener('click', () => docwrap.scrollBy({ top: -docwrap.clientHeight * 0.9, behavior: 'smooth' }));
  document.getElementById('nextPage').addEventListener('click', () => docwrap.scrollBy({ top: docwrap.clientHeight * 0.9, behavior: 'smooth' }));
  const vfind = document.getElementById('vfind');
  function doFind() { const term = vfind.value.trim(); if (term && window.find) { if (!window.find(term)) { window.getSelection().removeAllRanges(); window.find(term); } } }
  document.getElementById('vfindNext').addEventListener('click', doFind);
  vfind.addEventListener('keydown', e => { if (e.key === 'Enter') doFind(); });

  const saveMenu = document.getElementById('saveMenu');
  document.getElementById('saveAs').addEventListener('click', e => { e.stopPropagation(); saveMenu.classList.toggle('open'); });
  document.addEventListener('click', () => saveMenu.classList.remove('open'));
  saveMenu.addEventListener('click', e => {
    const b = e.target.closest('[data-fmt]'); if (!b) return;
    saveMenu.classList.remove('open');
    if (b.dataset.fmt === 'pdf') window.print();
    else if (b.dataset.fmt === 'excel') exportAllExcel();
    else if (b.dataset.fmt === 'word') exportWord();
  });

  document.getElementById('themeToggle').addEventListener('click', () => {
    const dark = document.body.classList.toggle('dark');
    document.getElementById('themeToggle').textContent = dark ? '🌙' : '☀';
  });

  document.getElementById('print').addEventListener('click', () => window.print());
  window.addEventListener('beforeprint', () => { try { document.getElementById('printDate').textContent = 'Printed: ' + new Date().toLocaleDateString('en-GB'); } catch (e) {} });

  // ---------- admin ----------
  const adminBg = document.getElementById('adminBg'), adminKey = document.getElementById('adminKey'),
        adminBody = document.getElementById('adminBody'), adminMsg = document.getElementById('admin-msg'),
        userTable = document.getElementById('userTable');
  const setAdminMsg = (m, err) => { adminMsg.textContent = m; adminMsg.style.color = err ? '#b00020' : '#1a7f37'; };
  async function callUsers(action, extra) {
    const res = await fetch(cfg.usersUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': cfg.anonKey }, body: JSON.stringify({ secret: adminKey.value.trim(), action, ...extra }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    return body;
  }
  function renderUsers(users) {
    if (!users.length) { userTable.innerHTML = '<tbody><tr><td style="color:#888">No approved users yet.</td></tr></tbody>'; return; }
    userTable.innerHTML = '<thead><tr><th>Name</th><th>Phone</th><th></th></tr></thead><tbody>' +
      users.map(u => `<tr><td>${esc(u.label || '')}</td><td>+${esc(u.phone)}</td><td style="text-align:right"><button class="back" data-rm="${esc(u.phone)}" style="color:#b00020">Remove</button></td></tr>`).join('') + '</tbody>';
    userTable.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Remove +' + b.dataset.rm + '?')) return;
      try { await callUsers('remove', { phone: b.dataset.rm }); setAdminMsg('Removed.'); await refreshUsers(); } catch (e) { setAdminMsg(e.message, true); }
    }));
  }
  async function refreshUsers() { const { users } = await callUsers('list'); renderUsers(users); }
  const loginTable = document.getElementById('loginTable');
  function renderLogins(logins) {
    if (!logins.length) { loginTable.innerHTML = '<tbody><tr><td style="color:#888">No username accounts yet.</td></tr></tbody>'; return; }
    loginTable.innerHTML = '<thead><tr><th>Username</th><th>Name</th><th></th></tr></thead><tbody>' +
      logins.map(u => `<tr><td>${esc(u.username)}</td><td>${esc(u.label || '')}</td><td style="text-align:right"><button class="back" data-rmid="${esc(u.id)}" style="color:#b00020">Remove</button></td></tr>`).join('') + '</tbody>';
    loginTable.querySelectorAll('[data-rmid]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Remove this login account?')) return;
      try { await callUsers('remove_login', { id: b.dataset.rmid }); setAdminMsg('Removed.'); await refreshLogins(); } catch (e) { setAdminMsg(e.message, true); }
    }));
  }
  async function refreshLogins() { const { logins } = await callUsers('list_logins'); renderLogins(logins); }
  document.getElementById('addLogin').addEventListener('click', async () => {
    const username = document.getElementById('newUser').value.trim(), password = document.getElementById('newPass').value, label = document.getElementById('newUserLabel').value.trim();
    setAdminMsg('Creating…');
    try { const r = await callUsers('add_login', { username, password, label });
      setAdminMsg('Created login "' + r.username + '". They can sign in with that username + password.');
      document.getElementById('newUser').value = ''; document.getElementById('newPass').value = ''; document.getElementById('newUserLabel').value = '';
      await refreshLogins();
    } catch (e) { setAdminMsg(e.message, true); }
  });
  function openAdmin() { adminMsg.textContent = ''; adminBody.style.display = 'none'; adminBg.classList.add('show'); const saved = sessionStorage.getItem('adminKey'); if (saved) adminKey.value = saved; }
  function closeAdmin() { adminBg.classList.remove('show'); }
  document.getElementById('openAdmin').addEventListener('click', openAdmin);
  document.getElementById('adminBtn').addEventListener('click', openAdmin);
  document.getElementById('closeAdmin').addEventListener('click', closeAdmin);
  adminBg.addEventListener('click', e => { if (e.target === adminBg) closeAdmin(); });
  document.getElementById('unlockAdmin').addEventListener('click', async () => {
    setAdminMsg('Checking…');
    try { await refreshUsers(); await refreshLogins(); adminBody.style.display = ''; sessionStorage.setItem('adminKey', adminKey.value.trim()); setAdminMsg('Unlocked.'); }
    catch (e) { adminBody.style.display = 'none'; setAdminMsg(e.message, true); }
  });
  document.getElementById('addUser').addEventListener('click', async () => {
    const label = document.getElementById('newLabel').value.trim(), phone = document.getElementById('newPhone').value.trim();
    setAdminMsg('Adding…');
    try { const r = await callUsers('add', { phone, label }); setAdminMsg('Added +' + r.phone + (r.label ? ' (' + r.label + ')' : ''));
      document.getElementById('newLabel').value = ''; document.getElementById('newPhone').value = '+965'; await refreshUsers(); }
    catch (e) { setAdminMsg(e.message, true); }
  });

  // ---------- auth ----------
  const loginBg = document.getElementById('loginBg'), stepPhone = document.getElementById('step-phone'), stepCode = document.getElementById('step-code'),
        phoneIn = document.getElementById('phone-in'), codeIn = document.getElementById('code-in'), loginMsgEl = document.getElementById('login-msg');
  const loginMsg = (txt, err) => { loginMsgEl.textContent = txt; loginMsgEl.className = 'msg' + (err ? ' err' : ''); };
  const showLogin = () => loginBg.classList.remove('hidden');
  const hideLogin = () => loginBg.classList.add('hidden');
  const showStepPhone = () => { stepPhone.style.display = ''; stepCode.style.display = 'none'; loginMsg(''); };
  let phoneVal = '';
  async function afterAuth() {
    const { data: allowed, error } = await sb.rpc(RPC.access);
    if (error) { loginMsg('Could not verify access: ' + error.message, true); showLogin(); return; }
    if (!allowed) { loginMsg('This account is not approved for access yet. Contact the administrator.', true); await sb.auth.signOut(); showLogin(); return; }
    hideLogin(); await loadData();
  }
  const panePw = document.getElementById('pane-pw'), panePhone = document.getElementById('pane-phone'), tabPw = document.getElementById('tab-pw'), tabPhone = document.getElementById('tab-phone');
  tabPw.addEventListener('click', () => { tabPw.classList.add('active'); tabPhone.classList.remove('active'); panePw.style.display = ''; panePhone.style.display = 'none'; loginMsg(''); });
  tabPhone.addEventListener('click', () => { tabPhone.classList.add('active'); tabPw.classList.remove('active'); panePhone.style.display = ''; panePw.style.display = 'none'; loginMsg(''); });
  const userIn = document.getElementById('user-in'), passIn = document.getElementById('pass-in');
  document.getElementById('pwLogin').addEventListener('click', async () => {
    const username = userIn.value.trim().toLowerCase(), password = passIn.value;
    if (!username || !password) { loginMsg('Enter your username and password.', true); return; }
    loginMsg('Signing in…');
    const { error } = await sb.auth.signInWithPassword({ email: username + '@audit.local', password });
    if (error) { loginMsg('Invalid username or password.', true); return; }
    await afterAuth();
  });
  [userIn, passIn].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('pwLogin').click(); }));
  document.getElementById('sendCode').addEventListener('click', async () => {
    phoneVal = phoneIn.value.replace(/\s+/g, '').trim();
    if (!/^\+\d{8,15}$/.test(phoneVal)) { loginMsg('Enter a valid phone in international format, e.g. +96550000000.', true); return; }
    loginMsg('Sending code…');
    const { error } = await sb.auth.signInWithOtp({ phone: phoneVal });
    if (error) { loginMsg('Could not send code: ' + error.message, true); return; }
    stepPhone.style.display = 'none'; stepCode.style.display = ''; loginMsg('Code sent to ' + phoneVal); codeIn.focus();
  });
  document.getElementById('verifyCode').addEventListener('click', async () => {
    const token = codeIn.value.replace(/\D/g, '');
    if (token.length < 4) { loginMsg('Enter the code from the SMS.', true); return; }
    loginMsg('Verifying…');
    const { error } = await sb.auth.verifyOtp({ phone: phoneVal, token, type: 'sms' });
    if (error) { loginMsg('Invalid or expired code: ' + error.message, true); return; }
    loginMsg('Signed in.'); await afterAuth();
  });
  document.getElementById('changeNumber').addEventListener('click', showStepPhone);
  [phoneIn, codeIn].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById(el === phoneIn ? 'sendCode' : 'verifyCode').click(); }));
  document.getElementById('logout').addEventListener('click', async () => {
    await sb.auth.signOut(); DATA = { dimensions: [] };
    document.getElementById('report').innerHTML = ''; document.getElementById('dimMenu').innerHTML = ''; document.getElementById('dimChips').innerHTML = '';
    setStatus('Signed out.'); showStepPhone(); phoneIn.value = '+965'; codeIn.value = ''; showLogin();
  });

  const { data: { session } } = await sb.auth.getSession();
  if (session) await afterAuth(); else showLogin();
})();
