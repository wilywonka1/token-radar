// Token Launch Radar — dashboard. Reads window.RADAR (data.js, written by
// main.ts from the same board) and renders the ranked board, filters, a
// live-token view set apart from the ranking, and a detail drawer per
// protocol. No network: every byte shown is in data.js.
//
// The value model below is the same arithmetic lib/model.ts runs, in the
// same named functions, so the page recomputes every row it shows:
//   calibrateCategoryMultiples (in main.ts) winsorises mcap/TVL ratios of
//   the snapshot's trading protocols to [0.03, 2.5], takes each category's
//   median (at least 4 samples), shrinks it 25% toward the global median
//   and clamps it to [0.05, 1.50]. Each row carries its rounded multiple.
//   impliedValueFromSnapshot = round(TVL x category multiple
//     x momentumMultiplier x maturityMultiplier).
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var M = DATA.model;
  var state = { q: '', category: 'all', chain: 'all', scope: 'all', tab: 'pre', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function round4(n) { return Math.round(n * 1e4) / 1e4; }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) { return (n === null || n === undefined || !isFinite(n)) ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function fmtAge(d) { return (d === null || d === undefined) ? 'unknown' : d >= 365 ? (d / 365).toFixed(1) + 'y' : Math.max(0, Math.round(d)) + 'd'; }

  function momentumMultiplier(change7d) {
    var raw = (change7d === null || change7d === undefined || !isFinite(change7d)) ? 0 : change7d;
    var pct = clamp(raw, M.growth_floor, M.growth_cap);
    return round4(1 + (pct / 100) * M.growth_weight);
  }
  function maturityMultiplier(ageDays) {
    var days = (ageDays === null || ageDays === undefined) ? M.unknown_age_days : ageDays;
    return round4(M.maturity_base + (clamp(days, 0, M.maturity_days) / M.maturity_days) * M.maturity_range);
  }
  function impliedValueFromSnapshot(row) {
    return Math.max(1, Math.round(row.tvl_usd * row.category_multiple * momentumMultiplier(row.change_7d) * maturityMultiplier(row.age_days)));
  }

  // Farm plans: the same derivation main.ts writes into board.json.
  // Category picks the actions, the cheapest listed chain picks the gas,
  // TVL picks the capital tier, age picks the hold. No name is special-cased.
  function gasUsdForChain(chain) {
    var c = String(chain).toLowerCase();
    if (c === 'ethereum') return 9;
    if (c === 'solana') return 0.25;
    if (c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'zksync era' || c === 'linea' || c === 'scroll') return 0.8;
    if (c === 'binance' || c === 'bsc' || c === 'polygon' || c === 'avalanche' || c === 'fantom' || c === 'tron') return 1.2;
    if (c === 'bitcoin') return 3;
    return 2;
  }
  function preferredChain(p) {
    if (!p.chains || p.chains.length === 0) return 'its main chain';
    return p.chains.slice().sort(function (a, b) { return gasUsdForChain(a) - gasUsdForChain(b) || (a < b ? -1 : a > b ? 1 : 0); })[0];
  }
  function capitalForTier(p) {
    if (p.tvl_usd >= 2e9) return 300;
    if (p.tvl_usd >= 5e8) return 200;
    if (p.tvl_usd >= 1e8) return 125;
    if (p.tvl_usd >= 25e6) return 75;
    return 50;
  }
  function holdDaysForAge(age) {
    if (age === null || age === undefined) return 45;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function coreActionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase(); var n = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC as collateral in ' + n + ' on ' + chain + ', then borrow about $' + Math.round(capital * 0.4) + ' against it so both sides of the market see your wallet';
    if (c.indexOf('dex') >= 0 || c.indexOf('exchange') >= 0) return 'Swap about $' + Math.round(capital / 2) + ' through ' + n + ' on ' + chain + ', then add $' + capital + " to its busiest stablecoin pool and keep the LP position open";
    if (c.indexOf('perp') >= 0 || c.indexOf('derivat') >= 0 || c.indexOf('futures') >= 0) return 'Deposit $' + capital + ' of USDC margin in ' + n + ' on ' + chain + ' and open one small hedged position (long spot elsewhere, short here) so funding, not direction, is your risk';
    if (c.indexOf('bridge') >= 0 || c.indexOf('cross') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + n + ', then use the bridged funds in one app on the far side instead of bridging straight back';
    if (c.indexOf('restak') >= 0 || c.indexOf('staking') >= 0 || c.indexOf('stake') >= 0) return 'Stake $' + capital + " worth of the chain's staking asset through " + n + ' on ' + chain + ' and keep the receipt token in the same wallet, unstaked, for the full hold';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('vault') >= 0) return 'Deposit $' + capital + ' into one ' + n + ' vault on ' + chain + ' (pick the vault with the most depositors, not the highest advertised yield) and keep the vault shares';
    if (c.indexOf('rwa') >= 0 || c.indexOf('real world') >= 0) return 'Mint $' + capital + ' of ' + n + "'s yield-bearing asset on " + chain + ' after its onboarding check, and hold the asset rather than trading it on a secondary market';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + n + ' on ' + chain + ', then hold half and lend half in the protocol\'s own market if it has one';
    if (c.indexOf('prediction') >= 0) return 'Fund ' + n + ' with $' + capital + ' on ' + chain + ' and take one position in its most liquid market, sized so a total loss is acceptable';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + n + ' on ' + chain + ' for a position you actually hold elsewhere, and keep the policy to expiry';
    if (c.indexOf('yield') >= 0 || c.indexOf('farm') >= 0 || c.indexOf('liquidity') >= 0) return 'Provide $' + capital + ' of liquidity in ' + n + ' on ' + chain + ' (a stablecoin pair if one exists) and keep the position open through the weekly actions below';
    if (c.indexOf('launchpad') >= 0) return 'Register the wallet with ' + n + ' on ' + chain + ' and complete one $' + capital + ' participation or staking action it offers, keeping proof of the transaction';
    if (c.indexOf('chain') >= 0 || c.indexOf('payments') >= 0) return 'Move $' + capital + ' of real activity onto ' + n + ' via ' + chain + ': bridge in, make three ordinary payments or transfers, and keep a balance above $' + Math.round(capital / 5);
    return 'Deposit $' + capital + ' of USDC into ' + n + ' on ' + chain + ' through its main app and keep the position open through the weekly actions below';
  }
  function secondActionFor(p, chain) {
    var c = (p.category || '').toLowerCase(); var n = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0) return 'In week two, repay part of the borrow and re-borrow a smaller amount in ' + n + ' so the wallet shows two separate borrow events, not one';
    if (c.indexOf('dex') >= 0 || c.indexOf('exchange') >= 0) return 'In week two, make one swap in the opposite direction in ' + n + ' and add a small top-up to the pool, so volume and liquidity both count';
    if (c.indexOf('perp') >= 0 || c.indexOf('derivat') >= 0) return 'In week two, close the first hedge in ' + n + ', settle it, and open a fresh smaller one so the wallet has a completed trade cycle';
    if (c.indexOf('bridge') >= 0 || c.indexOf('cross') >= 0) return 'In week two, bridge a smaller second amount through ' + n + ' on a different route it offers, and spend or deposit it on the far side';
    if (c.indexOf('restak') >= 0 || c.indexOf('staking') >= 0 || c.indexOf('stake') >= 0) return 'In week two, claim any staking rewards in ' + n + ' and restake them once, so the wallet shows a claim and a second stake';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('vault') >= 0) return "In week two, add a small top-up deposit to the same " + n + " vault and vote or sign in wherever the vault lists its depositors' governance";
    return 'In week two, repeat the core action in ' + n + ' at a quarter of the first size and on a different day, so the wallet reads as a returning user of ' + chain;
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmStepsFor(p) {
    var chain = preferredChain(p);
    var gas = gasUsdForChain(chain);
    var gasText = gas < 1 ? 'about $' + gas.toFixed(2) : 'about $' + gas;
    var capital = capitalForTier(p);
    var hold = holdDaysForAge(p.age_days);
    var weeks = Math.max(3, Math.round(hold / 7));
    return [
      { text: 'Set up a fresh wallet for ' + p.name + ' only, fund it on ' + chain + ' with the capital below plus a gas buffer, and store its seed phrase offline on paper', cost: gasText + ' of gas for the first funding transaction', time: '10 minutes' },
      { text: coreActionFor(p, capital, chain), cost: '$' + capital + ' of capital plus ' + gasText + ' of gas', time: '20 minutes to set up' },
      { text: secondActionFor(p, chain), cost: 'about $' + Math.round(capital / 4) + ' of extra capital and ' + gasText + ' of gas', time: '15 minutes in week two' },
      { text: 'Repeat one qualifying action in ' + p.name + ' every week for ' + weeks + ' weeks (a deposit, swap, borrow, claim or vote), varying the day and keeping each transaction above $10 so it is not dust', cost: gasText + ' of gas per week, about $' + (gas * weeks).toFixed(2) + ' across the plan', time: '10 minutes a week' },
      { text: 'Hold the main position for at least ' + hold + ' days without withdrawing below half, so the wallet appears in more than one weekly snapshot of ' + p.name, cost: 'the $' + capital + ' stays in the position; price and smart-contract risk are the real cost', time: hold + ' days' },
      { text: 'Log every transaction hash, date and amount in a farm sheet, then check ' + p.name + "'s own points or rewards page weekly and claim only from a link that page itself publishes", cost: 'nothing to check; never pay a fee to claim an airdrop', time: '5 minutes a week, 15 minutes to unwind at the end' }
    ].map(stepText);
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('scope')) state.scope = params.get('scope');
    if (params.get('tab')) state.tab = params.get('tab');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.scope !== 'all') params.set('scope', state.scope);
    if (state.tab !== 'pre') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.scope === 'watch' && !r.on_watchlist) return false;
      if (state.scope === 'early' && r.on_watchlist) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'ring' }), el('span', { class: 'brand-name', text: 'Token Launch Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index, sealed' }),
        el('span', { text: 'Model ' + DATA.model_version })));
  }
  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: 'Which pre-token protocol is worth farming next?' }),
        el('p', { text: 'Every protocol that records no token is valued by one calibrated model: its TVL, priced at the multiple its own category\'s tokens actually trade at, adjusted for 7-day growth and for how long it has run with no token. The watchlist is the floor, not the ceiling — the radar also finds early protocols below $50M TVL.' })),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows ranked' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early finds below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Already trading, set aside' }), el('b', { text: String(DATA.live_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Global TVL multiple' }), el('b', { text: DATA.global_multiple + 'x' }))));
  }
  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, slug, category, chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    function select(id, label, values, current, onChange) {
      var s = el('select', { id: id, 'aria-label': label },
        el('option', { value: 'all', text: label === 'Category' ? 'All categories' : label === 'Chain' ? 'All chains' : 'Whole board' }),
        values.map(function (v) { return el('option', { value: v[0], text: v[1], selected: v[0] === current ? 'selected' : null }); }));
      s.addEventListener('change', function () { onChange(s.value); writeHash(); render(); });
      return s;
    }
    var catSel = select('category', 'Category', categories.map(function (c) { return [c, c]; }), state.category, function (v) { state.category = v; });
    var chainSel = select('chain', 'Chain', chains.map(function (c) { return [c, c]; }), state.chain, function (v) { state.chain = v; });
    var scopeSel = select('scope', 'Scope', [['watch', 'Watchlist only'], ['early', 'Early finds only']], state.scope, function (v) { state.scope = v; });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token board', onclick: function () { state.tab = 'pre'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Already trading', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('div', { class: 'field' }, el('label', { for: 'scope', text: 'Radar scope' }), scopeSel),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre' ? rows().length + ' rows shown' : DATA.live.length + ' trading protocols' }));
  }
  function sortHeader(key, label) {
    return el('th', { scope: 'col' }, el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } }, label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null));
  }
  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) return el('div', { class: 'panel' }, el('div', { class: 'empty' },
      el('h2', { text: 'No protocol matches that filter' }),
      el('p', { text: 'Clear the search or pick another category, chain or scope to see the board again.' }),
      el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.scope = 'all'; writeHash(); render(); } })));
    var max = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; })) || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr', { 'data-selected': state.selected === r.slug ? 'true' : 'false', tabindex: '0', onclick: function () { openDetail(r.slug); }, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } } },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' · ' + ((r.chains || []).slice(0, 3).join(', ') || 'chain n/a') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: 'x' + r.category_multiple.toFixed(2) }),
        el('td', null, el('div', { class: 'implied' }, el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })), el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }))),
        el('td', null, el('span', { class: 'badge ' + (r.on_watchlist ? 'watch' : 'early'), text: r.on_watchlist ? 'Watchlist' : 'Early find' })));
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' }, el('table', null,
      el('caption', { text: 'Pre-token protocols ranked by implied value. Records no token is DefiLlama\'s record, not proof none exists. Select any row for its model breakdown and farm plan.' }),
      el('thead', null, el('tr', null, sortHeader('implied', 'Rank'), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'), sortHeader('growth', '7d'), sortHeader('age', 'Age'), el('th', { scope: 'col', text: 'Cat. x' }), sortHeader('implied', 'Implied value'), el('th', { scope: 'col', text: 'Radar' }))),
      tbody)));
  }
  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'badge live', text: 'Already trading' })),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name + (r.symbol ? ' (' + r.symbol + ')' : '') }), el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' · ' + ((r.chains || []).slice(0, 3).join(', ') || 'chain n/a') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) })));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' }, el('table', null,
      el('caption', { text: 'Set aside, not ranked: these protocols already trade, so the market cap shown is the market\'s own figure, not a model output. Their mcap/TVL ratios are what calibrate the pre-token model.' }),
      el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap (actual)' }))),
      tbody)));
  }
  function modelPanel() {
    var entries = Object.keys(DATA.category_multiples).map(function (k) { return [k, DATA.category_multiples[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 16);
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How the value model works — calibrated from this snapshot' }),
      el('p', { class: 'sub', text: 'No hardcoded names and no fixed multiple. calibrateCategoryMultiples reads the protocols whose tokens already trade, winsorises their market-cap / TVL ratios, and takes a shrunk median per category. Momentum and maturity then adjust for the protocol\'s own record.' }),
      el('div', { class: 'formula', text: 'implied = round( TVL x category_multiple x momentum x maturity )\ncategory_multiple = clamp( 0.75 x median(winsorised mcap/TVL of trading peers) + 0.25 x global median, 0.05, 1.50 ), global = ' + DATA.global_multiple + 'x\nmomentum = 1 + clamp(change_7d, -40, +60)/100 x 0.5   ·   maturity = 0.70 + min(age_days, 1825)/1825 x 0.60' }),
      el('div', { class: 'mult-grid' }, entries.map(function (e) { return el('span', { class: 'mult' }, e[0] + ' ', el('b', { text: 'x' + Number(e[1]).toFixed(2) })); })),
      el('p', { class: 'sub', text: 'Age is days since DefiLlama first listed the protocol — how long it has run with no token recorded. An unknown age uses 365 days. Implied value is this entry\'s own claim about a hypothetical launch, not a prediction that one will happen.' }));
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });
  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var recomputed = impliedValueFromSnapshot(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.on_watchlist ? ' · Watchlist' : ' · Early find below the $50M floor') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Uncategorised') + ' on ' + ((row.chains || []).join(', ') || 'an unnamed chain') + ' · records no token' })),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value — the model, step by step' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL (snapshot)' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: row.category_samples >= 4 ? 'Category multiple (' + row.category_samples + ' trading peers)' : 'Category multiple (global median — this category has only ' + row.category_samples + ' trading peer(s))' }), el('b', { class: 'num', text: 'x' + row.category_multiple.toFixed(4) })),
        el('div', null, el('span', { text: '7-day growth ' + fmtPct(row.change_7d) + ' → momentum' }), el('b', { class: 'num', text: 'x' + momentumMultiplier(row.change_7d).toFixed(4) })),
        el('div', null, el('span', { text: 'Age with no token ' + fmtAge(row.age_days) + ' → maturity' }), el('b', { class: 'num', text: 'x' + maturityMultiplier(row.age_days).toFixed(4) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))),
      el('p', { class: 'sub', text: 'This page recomputes the row with impliedValueFromSnapshot as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ' — the same number board.json carries.' : ' — which differs from the board, so the data would be stale.') + ' Cheapest farm chain here: ' + preferredChain(row) + ' (gas ' + fmtUsd(gasUsdForChain(preferredChain(row))) + ' a transaction).' })));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan — concrete steps, costs and time' }),
      el('ol', { class: 'steps' }, farmStepsFor(row).map(function (s) {
        var at = s.indexOf(' Cost: ');
        return el('li', null, el('b', { text: at >= 0 ? s.slice(0, at) : s }), el('span', { class: 'cost', text: at >= 0 ? s.slice(at + 1) : '' }));
      }))));
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
    renderTableOnly();
  }
  function renderTableOnly() { /* selection highlight refreshes on next full render */ }
  function render() {
    var selected = state.selected;
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre' ? boardTable() : liveTable());
    if (state.tab === 'pre') shell.appendChild(modelPanel());
    shell.appendChild(el('p', { class: 'foot', text: 'Source: DefiLlama protocol index, sealed snapshot of ' + DATA.as_of + ' (' + DATA.source + '). A protocol shown as pre-token records no token in that snapshot; that is a record, not proof none exists. Implied values are this radar\'s model claims, not prices or promises.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    state.selected = selected;
  }
  readHash();
  render();
  if (state.selected) openDetail(state.selected);
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
