/*
 * Statement of Account report generator — grouped by COST DIMENSION.
 *
 * Usage:
 *   node generate-report.cjs                       # reads every .xlsx in ./inputs (one file = one cost dimension)
 *   node generate-report.cjs a.xlsx b.xlsx ...     # explicit dimension files
 *   node generate-report.cjs --out "report.pdf"    # custom output path
 *
 * Each input file is a "Statement of Account" export for one cost dimension.
 * The cost dimension (Material / Labor / Equipment / Overhead) is taken from the
 * file name. The report is grouped:
 *
 *   Material
 *       Project A  -> Statement of Account
 *       Project B  -> Statement of Account
 *   Labor
 *       Project C  -> Statement of Account
 *   Equipment / Overhead ...
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const puppeteer = require('puppeteer-core');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => fs.existsSync(p));

// Known cost dimensions in display order. Detected from the file name.
const DIMENSIONS = [
  { key: 'material', name: 'Material' },
  { key: 'labor', name: 'Labor', alt: ['labour'] },
  { key: 'equipment', name: 'Equipment' },
  { key: 'overhead', name: 'Overhead' },
];

function num(s) {
  s = String(s).trim().replace(/,/g, '');
  if (!s) return 0;
  if (s.startsWith('(') && s.endsWith(')')) return -(parseFloat(s.replace(/[()]/g, '')) || 0);
  return parseFloat(s) || 0;
}
const fmt = n =>
  (n < 0 ? '(' : '') +
  Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) +
  (n < 0 ? ')' : '');

function excelDate(v) {
  if (v === '' || v == null) return '';
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return String(v);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.d)}/${p(d.m)}/${d.y}`;
  }
  return String(v);
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// "dd/mm/yyyy" -> sortable integer yyyymmdd (0 if unparseable), for date-range filtering.
function tsFromDMY(s) {
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? parseInt(m[3] + m[2] + m[1], 10) : 0;
}

// Identify the cost dimension from the file name (Material / Labor / Equipment / Overhead).
function dimensionInfo(file) {
  const base = path.basename(file).replace(/\.xlsx$/i, '');
  const low = base.toLowerCase();
  for (let i = 0; i < DIMENSIONS.length; i++) {
    const d = DIMENSIONS[i];
    if (low.includes(d.key) || (d.alt || []).some(a => low.includes(a))) return { name: d.name, order: i };
  }
  return { name: base, order: DIMENSIONS.length };   // fallback: use file name, sort last
}

function parseWorkbook(file) {
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

  // Metadata labels may be offset into any column; read the next non-empty cell as the value.
  const LABELS = { 'account name': 'account', 'from date': 'from', 'to date': 'to',
                   'main cost center': 'mainCostCenter', 'cost center': 'costCenter', 'division': 'division' };
  const meta = {};
  let headerRow = -1;
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map(c => String(c).trim());
    cells.forEach((c, j) => {
      const key = LABELS[c.toLowerCase()];
      if (key && meta[key] === undefined) {
        const val = cells.slice(j + 1).find(x => x !== '');
        if (val !== undefined) meta[key] = /date/i.test(c) ? excelDate(rows[i][cells.indexOf(val, j + 1)]) : val;
      }
    });
    if (cells.includes('Date') && cells.includes('Voucher Type')) { headerRow = i; break; }
  }
  if (headerRow < 0) throw new Error(`No transaction table header found in ${path.basename(file)}`);

  // Locate columns by header name — layouts vary (e.g. Credit may sit in a different column).
  const col = {};
  rows[headerRow].forEach((c, j) => {
    const name = String(c).trim().toLowerCase().replace(/\.$/, '');
    if (name && !(name in col)) col[name] = j;
  });
  const idx = {
    date: col['date'] ?? 0,
    type: col['voucher type'] ?? 1,
    no: col['no'] ?? 2,
    cc: col['costcenter'] ?? 3,
    ref: col['ref no'] ?? 4,
    memo: col['memo'] ?? 5,
    debit: col['debit'] ?? 6,
    credit: col['credit'] ?? 7,
  };

  const txnsByProject = new Map();
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const proj = String(r[idx.cc]).trim();
    if (String(r[idx.memo]).trim() === 'Transactions') continue;
    if (!proj) continue;
    if (!txnsByProject.has(proj)) txnsByProject.set(proj, []);
    txnsByProject.get(proj).push({
      date: excelDate(r[idx.date]),
      type: String(r[idx.type]).trim(),
      no: String(r[idx.no]).trim(),
      ref: String(r[idx.ref]).trim(),
      memo: String(r[idx.memo]).trim(),
      debit: num(r[idx.debit]),
      credit: num(r[idx.credit]),
    });
  }
  return { meta, txnsByProject, file };
}

// Build a cost-dimension object from one or more parsed workbooks that share a dimension.
function buildDimension(parsedList) {
  const first = parsedList[0];
  const info = dimensionInfo(first.file);
  const merged = new Map();
  for (const p of parsedList) {
    for (const [name, txns] of p.txnsByProject) {
      if (!merged.has(name)) merged.set(name, []);
      merged.get(name).push(...txns);
    }
  }
  const projects = [];
  let dD = 0, dC = 0;
  for (const [name, txns] of merged) {
    let bal = 0, td = 0, tc = 0;
    for (const t of txns) { bal += t.debit - t.credit; t.balance = bal; td += t.debit; tc += t.credit; }
    projects.push({ name, txns, totalDebit: td, totalCredit: tc, net: td - tc });
    dD += td; dC += tc;
  }
  projects.sort((a, b) => b.txns.length - a.txns.length);
  return {
    name: info.name, order: info.order,
    account: first.meta.account || '', from: first.meta.from || '', to: first.meta.to || '',
    projects, grandD: dD, grandC: dC,
  };
}

function buildHTML(dimensions) {
  const RD = dimensions.reduce((s, d) => s + d.grandD, 0);
  const RC = dimensions.reduce((s, d) => s + d.grandC, 0);
  const totalProjects = dimensions.reduce((s, d) => s + d.projects.length, 0);
  const totalTxns = dimensions.reduce((s, d) => s + d.projects.reduce((a, p) => a + p.txns.length, 0), 0);

  const overviewRows = dimensions.map(d => {
    const tx = d.projects.reduce((a, p) => a + p.txns.length, 0);
    return `<tr>
      <td>${esc(d.name)}</td>
      <td class="num">${d.projects.length}</td>
      <td class="num">${tx}</td>
      <td class="amt">${fmt(d.grandD)}</td>
      <td class="amt">${fmt(d.grandC)}</td>
      <td class="amt ${d.grandD - d.grandC < 0 ? 'neg' : ''}">${fmt(d.grandD - d.grandC)}</td>
    </tr>`;
  }).join('');

  const dimensionSections = dimensions.map(d => {
    const summary = d.projects.map((p, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td dir="auto" class="pname">${esc(p.name)}</td>
        <td class="num">${p.txns.length}</td>
        <td class="amt">${fmt(p.totalDebit)}</td>
        <td class="amt">${fmt(p.totalCredit)}</td>
        <td class="amt ${p.net < 0 ? 'neg' : ''}">${fmt(p.net)}</td>
      </tr>`).join('');

    const projectSections = d.projects.map((p, i) => {
      const body = p.txns.map(t => `<tr>
          <td class="date">${esc(t.date)}</td>
          <td dir="auto">${esc(t.type)}</td>
          <td class="num">${esc(t.no)}</td>
          <td dir="auto">${esc(t.ref)}</td>
          <td dir="auto" class="memo">${esc(t.memo)}</td>
          <td class="amt">${t.debit ? fmt(t.debit) : ''}</td>
          <td class="amt">${t.credit ? fmt(t.credit) : ''}</td>
          <td class="amt ${t.balance < 0 ? 'neg' : ''}">${fmt(t.balance)}</td>
        </tr>`).join('');
      return `<section class="project">
        <h3><span class="pidx">${esc(d.name)} &middot; ${i + 1}.</span> <span dir="auto">${esc(p.name)}</span></h3>
        <div class="soa-label">Statement of Account</div>
        <table class="soa">
          <thead><tr><th>Date</th><th>Voucher Type</th><th>No</th><th>Ref No.</th><th>Memo</th>
            <th class="amt">Debit</th><th class="amt">Credit</th><th class="amt">Balance</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr class="totals"><td colspan="5">Total &mdash; ${p.txns.length} transaction(s)</td>
            <td class="amt">${fmt(p.totalDebit)}</td><td class="amt">${fmt(p.totalCredit)}</td>
            <td class="amt ${p.net < 0 ? 'neg' : ''}">${fmt(p.net)}</td></tr></tfoot>
        </table>
      </section>`;
    }).join('');

    return `<div class="dimension">
      <h1 class="dimtitle">${esc(d.name)}</h1>
      <table class="meta2">
        <tr><td>Account</td><td>${esc(d.account)}</td><td>Period</td><td>${esc(d.from)} &ndash; ${esc(d.to)}</td>
            <td>Projects</td><td>${d.projects.length}</td>
            <td>Net</td><td class="${d.grandD - d.grandC < 0 ? 'neg' : ''}">${fmt(d.grandD - d.grandC)}</td></tr>
      </table>
      <h2>Projects Summary</h2>
      <table class="summary">
        <thead><tr><th>#</th><th>Project</th><th class="num">Txns</th>
          <th class="amt">Total Debit</th><th class="amt">Total Credit</th><th class="amt">Net Balance</th></tr></thead>
        <tbody>${summary}</tbody>
        <tfoot><tr><td colspan="2">${esc(d.name)} Total</td>
          <td class="num">${d.projects.reduce((a, p) => a + p.txns.length, 0)}</td>
          <td class="amt">${fmt(d.grandD)}</td><td class="amt">${fmt(d.grandC)}</td>
          <td class="amt ${d.grandD - d.grandC < 0 ? 'neg' : ''}">${fmt(d.grandD - d.grandC)}</td></tr></tfoot>
      </table>
      ${projectSections}
    </div>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>
  @page { size: A4 landscape; margin: 14mm 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, "Tahoma", sans-serif; color: #1a1a1a; font-size: 9px; margin: 0; }
  .cover { page-break-after: always; padding: 40px 20px; }
  .cover h1 { font-size: 26px; margin: 0 0 4px; color: #14304f; }
  .cover .sub { font-size: 13px; color: #555; margin-bottom: 24px; }
  .meta { border-collapse: collapse; font-size: 12px; margin-bottom: 24px; }
  .meta td { padding: 4px 14px 4px 0; }
  .meta td:first-child { color: #666; font-weight: 600; }
  .dimension { page-break-before: always; }
  .dimension:first-of-type { page-break-before: avoid; }
  .dimtitle { font-size: 20px; color: #fff; background: #14304f; padding: 8px 14px; margin: 0 0 8px; border-radius: 3px; }
  .meta2 { border-collapse: collapse; font-size: 10px; margin-bottom: 12px; }
  .meta2 td { padding: 2px 8px; }
  .meta2 td:nth-child(odd) { color: #888; font-weight: 600; }
  h2 { font-size: 13px; color: #14304f; margin: 10px 0 4px; }
  h3 { font-size: 12px; color: #14304f; margin: 16px 0 2px; border-bottom: 2px solid #14304f; padding-bottom: 3px; page-break-after: avoid; }
  .pidx { color: #b8860b; }
  .soa-label { font-size: 8px; letter-spacing: 1px; text-transform: uppercase; color: #999; margin: 2px 0 5px; }
  .project { margin-bottom: 20px; }
  table.soa, table.summary, table.overview { border-collapse: collapse; width: 100%; }
  table.soa th, table.soa td { border: 0.5px solid #cfd6dd; padding: 2px 4px; vertical-align: top; }
  table.soa thead th { background: #14304f; color: #fff; font-weight: 600; text-align: left; }
  table.soa thead { display: table-header-group; }
  table.soa tbody tr:nth-child(even) { background: #f4f7fa; }
  .amt { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .date { white-space: nowrap; }
  .num { text-align: right; }
  .neg { color: #b00020; }
  .memo { max-width: 220px; }
  tr.totals td { background: #e8eef4; font-weight: 700; border-top: 1.5px solid #14304f; }
  table.summary, table.overview { font-size: 11px; margin-top: 4px; }
  table.summary th, table.summary td, table.overview th, table.overview td { border: 0.5px solid #cfd6dd; padding: 4px 8px; }
  table.summary thead th, table.overview thead th { background: #14304f; color: #fff; text-align: left; }
  table.summary .pname { max-width: 420px; }
  table.summary tfoot td, table.overview tfoot td { background: #e8eef4; font-weight: 700; }
</style></head><body>

  <div class="cover">
    <h1>Statement of Account Report</h1>
    <div class="sub">Grouped by Cost Dimension &rarr; Project &middot; ${dimensions.length} cost dimension(s)</div>
    <table class="meta">
      <tr><td>Cost Dimensions</td><td>${dimensions.map(d => esc(d.name)).join(', ')}</td></tr>
      <tr><td>Projects</td><td>${totalProjects}</td></tr>
      <tr><td>Transactions</td><td>${totalTxns}</td></tr>
      <tr><td>Total Debit</td><td>${fmt(RD)}</td></tr>
      <tr><td>Total Credit</td><td>${fmt(RC)}</td></tr>
      <tr><td>Net</td><td>${fmt(RD - RC)}</td></tr>
    </table>
    <h2>Cost Dimensions Overview</h2>
    <table class="overview">
      <thead><tr><th>Cost Dimension</th><th class="num">Projects</th><th class="num">Txns</th>
        <th class="amt">Total Debit</th><th class="amt">Total Credit</th><th class="amt">Net</th></tr></thead>
      <tbody>${overviewRows}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${totalProjects}</td><td class="num">${totalTxns}</td>
        <td class="amt">${fmt(RD)}</td><td class="amt">${fmt(RC)}</td>
        <td class="amt ${RD - RC < 0 ? 'neg' : ''}">${fmt(RD - RC)}</td></tr></tfoot>
    </table>
  </div>

  ${dimensionSections}
</body></html>`;
}

function collectInputs(argv) {
  const files = [];
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') { out = argv[++i]; continue; }
    files.push(argv[i]);
  }
  if (files.length === 0) {
    const dir = path.join(__dirname, 'inputs');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) if (/\.xlsx$/i.test(f) && !f.startsWith('~$')) files.push(path.join(dir, f));
    }
  }
  return { files, out: out || path.join(__dirname, 'Statement Of Account - Cost Dimensions Report.pdf') };
}

async function main() {
  const { files, out } = collectInputs(process.argv.slice(2));
  if (files.length === 0) {
    console.error('No input .xlsx files. Put one export per cost dimension in ./inputs or pass paths as arguments.');
    process.exit(1);
  }
  console.log(`Reading ${files.length} cost-dimension file(s):`);

  // group parsed workbooks by cost dimension
  const byDim = new Map();
  for (const f of files) {
    const parsed = parseWorkbook(f);
    const info = dimensionInfo(f);
    if (!byDim.has(info.name)) byDim.set(info.name, []);
    byDim.get(info.name).push(parsed);
    console.log(`   ${path.basename(f)}  ->  ${info.name}`);
  }

  const dimensions = [...byDim.values()].map(buildDimension).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  dimensions.forEach(d => console.log(`   ${d.name}: ${d.projects.length} projects, net ${fmt(d.grandD - d.grandC)}`));

  // Data for the interactive viewer (index.html) — filters run client-side over this.
  const data = {
    dimensions: dimensions.map(d => ({
      name: d.name, account: d.account, from: d.from, to: d.to,
      projects: d.projects.map(p => ({
        name: p.name,
        txns: p.txns.map(t => ({
          date: t.date, ts: tsFromDMY(t.date), type: t.type, no: t.no,
          ref: t.ref, memo: t.memo, debit: t.debit, credit: t.credit,
        })),
      })),
    })),
  };
  fs.writeFileSync(path.join(__dirname, 'report-data.js'), 'window.REPORT_DATA = ' + JSON.stringify(data) + ';\n', 'utf8');
  console.log('Data written to: report-data.js (interactive viewer at index.html)');

  const html = buildHTML(dimensions);
  const htmlPath = path.join(__dirname, 'report.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  console.log('Rendering PDF via', CHROME);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('file://' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await page.pdf({
    path: out, format: 'A4', landscape: true, printBackground: true,
    margin: { top: '14mm', bottom: '14mm', left: '10mm', right: '10mm' },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:7px;width:100%;text-align:center;color:#888;">' +
      'Statement of Account Report &nbsp;|&nbsp; Grouped by Cost Dimension &rarr; Project &nbsp;|&nbsp; ' +
      'Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
  });
  await browser.close();
  console.log('PDF written to:', out);
}
main().catch(e => { console.error(e); process.exit(1); });
