/* PepaPay Merchant Dashboard v2 — Backend bridge
 * Loaded AFTER the inline design script; overrides window.* functions and
 * mutates the design's data arrays in place so renderers see live API data.
 *
 *   Phase 1: real OTP login (replaces fake "123456")
 *   Phase 2: hydrate TX / CUSTOMERS / BRANCHES / TEAM / TICKETS / SERVICES
 *   Phase 3+4: wire submit handlers to new endpoints
 */
(function () {
  'use strict';

  const TOKEN_KEY    = 'pp_merchant_token';
  const AUTHED_KEY   = 'pp_authed';
  const PROFILE_KEY  = 'pp_merchant_profile';

  // ============================================================================
  // mApi — fetch wrapper with bearer token + JSON
  // ============================================================================
  async function mApi(path, opts) {
    opts = opts || {};
    const token = localStorage.getItem(TOKEN_KEY) || '';
    const headers = Object.assign({}, opts.headers || {});
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const r = await fetch(path, Object.assign({}, opts, { headers }));
    // 401 = token expired or wrong — kick the user to the login screen instead
    // of silently leaving every hydrated array empty (which surfaces as
    // "GHS 0.00" and missing data in the merchant dashboard).
    if (r.status === 401) {
      try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
      try { sessionStorage.removeItem(AUTHED_KEY); } catch (_) {}
      if (typeof window.showLogin === 'function') {
        try { window.showLogin(); } catch (_) {}
      }
      const err = new Error('Session expired — please sign in again.');
      err.status = 401;
      throw err;
    }
    let data = null;
    try { data = await r.json(); } catch (_) { /* no body */ }
    if (!r.ok) {
      const err = new Error(
        (data && (data.message || data.detail)) ||
        ('HTTP ' + r.status)
      );
      err.status = r.status;
      err.body = data;
      throw err;
    }
    return data;
  }
  window.mApi = mApi;

  // ============================================================================
  // Phase 1 — OTP login (replaces design's fake-123456 flow)
  // ============================================================================
  function getLoginIdentifier() {
    const ch = (window.LOGIN && window.LOGIN.channel) || 'email';
    if (ch === 'email') {
      const v = (document.getElementById('emailInput') || {}).value || '';
      return { channel: 'email', identifier: v.trim() };
    }
    const v = (document.getElementById('phoneInput') || {}).value || '';
    const digits = v.replace(/\D/g, '');
    const e164 = digits.startsWith('233') ? '+' + digits
               : digits.length === 9      ? '+233' + digits
               : digits.length === 10     ? '+233' + digits.slice(1)
               : '+233' + digits;
    return { channel: 'phone', identifier: e164 };
  }

  window.loginRequestOtp = async function () {
    const { channel, identifier } = getLoginIdentifier();
    if (channel === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
        window.toast('Enter a valid email address', 'err');
        return;
      }
    } else {
      if (identifier.replace(/\D/g, '').length < 11) {
        window.toast('Enter a valid Ghana mobile number', 'err');
        return;
      }
    }
    try {
      const resp = await mApi('/api/v1/merchant/auth/request-otp', {
        method: 'POST',
        body: { identifier, channel },
      });
      document.getElementById('stepIdentify').classList.remove('show');
      document.getElementById('stepOtp').classList.add('show');
      const destEl = document.getElementById('otpDest');
      if (destEl) destEl.textContent = identifier;
      document.getElementById('otpError').textContent = '';
      document.querySelectorAll('#loginView .otp-digit').forEach(i => { i.value = ''; i.classList.remove('filled'); });
      setTimeout(() => { const f = document.querySelector('#loginView .otp-digit'); if (f) f.focus(); }, 60);
      window.LOGIN = window.LOGIN || {};
      window.LOGIN._identifier = identifier;
      window.LOGIN._channel    = channel;
      if (typeof window.loginStartResendTimer === 'function') window.loginStartResendTimer();
      const demoCode = resp && resp.demo_code;
      if (demoCode) {
        window.toast('Code sent (demo: ' + demoCode + ')', 'info');
        const info = document.querySelector('#stepOtp .otp-info b');
        if (info) info.textContent = demoCode;
      } else {
        window.toast('Code sent', 'info', identifier);
      }
    } catch (e) {
      window.toast('Failed to send OTP: ' + e.message, 'err');
    }
  };

  window.loginVerifyOtp = async function () {
    const code = Array.from(document.querySelectorAll('#loginView .otp-digit')).map(i => i.value).join('');
    const errEl = document.getElementById('otpError');
    if (code.length !== 6) { errEl.textContent = 'Enter all 6 digits.'; return; }
    const identifier = (window.LOGIN && window.LOGIN._identifier) || '';
    try {
      const resp = await mApi('/api/v1/merchant/auth/verify-otp', {
        method: 'POST',
        body: { identifier, code },
      });
      const token = resp && (resp.access_token || resp.token);
      if (!token) { errEl.textContent = 'Token could not be issued.'; return; }
      localStorage.setItem(TOKEN_KEY, token);
      if (resp.profile) localStorage.setItem(PROFILE_KEY, JSON.stringify(resp.profile));
      try { sessionStorage.setItem(AUTHED_KEY, '1'); } catch (_) {}
      window.toast('Signed in successfully', 'ok', 'Redirecting…');
      setTimeout(() => { window.showApp(); }, 400);
    } catch (e) {
      errEl.textContent = e.status === 401 ? 'Code is invalid or expired.' : ('Verification failed: ' + e.message);
      document.querySelectorAll('#loginView .otp-digit').forEach(i => { i.classList.remove('filled'); });
      const first = document.querySelector('#loginView .otp-digit'); if (first) first.focus();
    }
  };

  // ============================================================================
  // Cross-portal SSO (?session_token=...)
  // ============================================================================
  (function _acceptSso() {
    const params = new URLSearchParams(location.search);
    const tok = params.get('session_token');
    if (!tok) return;
    localStorage.setItem(TOKEN_KEY, tok);
    try { sessionStorage.setItem(AUTHED_KEY, '1'); } catch (_) {}
    const impBy = params.get('imp_by');
    if (impBy) sessionStorage.setItem('pp_imp_by', impBy);
    params.delete('session_token');
    params.delete('imp_by');
    const newUrl = location.pathname + (params.toString() ? '?' + params.toString() : '');
    history.replaceState({}, '', newUrl);
  })();

  // ============================================================================
  // Sign-out
  // ============================================================================
  const _origSignOut = window.signOut;
  window.signOut = function () {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(PROFILE_KEY);
      sessionStorage.removeItem(AUTHED_KEY);
      sessionStorage.removeItem('pp_imp_by');
    } catch (_) {}
    if (typeof _origSignOut === 'function') _origSignOut();
    else window.showLogin();
  };

  // ============================================================================
  // Phase 2 — Hydrate design data arrays from real API
  // ============================================================================
  function mapTxChannel(c) {
    return ({
      mobile_app: 'qr', qr: 'qr', card: 'visa', momo_collect: 'mtn',
      mtn: 'mtn', telecel: 'tg', at_money: 'at', bank: 'bank',
      cash: 'cash', payment_link: 'link', link: 'link', ussd: 'qr',
    })[c] || 'qr';
  }
  function mapTxStatus(s) {
    return s === 'success' ? 'ok' : s === 'pending' ? 'warn' : s === 'failed' || s === 'reversed' ? 'err' : 'ok';
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate())
         + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function relativeDay(iso) {
    if (!iso) return '—';
    const today = new Date(2026, 4, 18);
    const d = new Date(iso);
    const days = Math.floor((today - d) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short' });
  }
  function mapTransactions(apiItems, branchNameById) {
    return (apiItems || []).map(t => ({
      id:      'TX-' + (t.id || '').slice(0, 8),
      date:    fmtDateTime(t.created_at),
      customer: t.customer_name || 'Walk-in',
      phone:    t.customer_phone || '—',
      channel:  mapTxChannel(t.channel),
      amount:   Number(t.amount || 0),
      branch:   branchNameById[t.branch_id] || 'Main',
      status:   mapTxStatus(t.status),
      method:   (t.description || '').replace(/^In-person\s+/i, '') || 'Mobile Money',
      currency: t.currency || 'GHS',
      kind:     t.kind,
    }));
  }
  function mapCustomers(apiList, defaultBranch) {
    return (apiList || []).map(c => ({
      name: c.name || 'Walk-in', phone: c.phone || '—',
      visits: c.payment_count || 0, spend: Number(c.total_paid || 0),
      last: relativeDay(c.last_seen_at), points: c.loyalty_points || 0,
      branch: defaultBranch, id: c.id, email: c.email,
    }));
  }
  function mapBranches(apiList) {
    return (apiList || []).map(b => ({
      // revenue:1 (not 0) — Overview's scopedShare = scopedRevenue / total. With
      // every branch=0 the math becomes 0/0 = NaN, producing "GHS NaN.undefined"
      // in the wallet balance label. 1 each makes scopedShare a sensible
      // proportion of selected vs. total branches.
      name: b.name, region: b.region || 'Greater Accra',
      address: b.address || '—', manager: 'Vacant', staff: 0, revenue: 1,
      services: ['QR'],
      status: b.status === 'active' ? 'active' : b.status === 'pending_approval' ? 'pending' : b.status === 'rejected' ? 'rejected' : 'active',
      id: b.id, contact_phone: b.contact_phone,
    }));
  }
  function mapTeam(apiList) {
    const roleLabel = { owner:'Owner', admin:'Admin', manager:'Branch Manager', finance:'Finance', cashier:'Cashier', employee:'Cashier', viewer:'Viewer' };
    return (apiList || []).map(e => ({
      name: e.full_name || e.name || 'Member',
      role: roleLabel[e.role] || (e.role || 'Cashier'),
      email: e.email || '—',
      branch: e.branch_name || 'All branches',
      status: e.status === 'active' ? 'Active' : e.status === 'invited' ? 'Invited' : (e.status || 'Active'),
      id: e.id, phone: e.phone, last_login_at: e.last_login_at,
    }));
  }
  function mapTickets(apiList) {
    const typeFor = cat => /feature|idea/i.test(cat || '') ? 'Feature' : 'Problem';
    const statusLabel = { open:'In progress', awaiting_merchant:'In progress', awaiting_support:'Under review', resolved:'Resolved', closed:'Resolved' };
    return (apiList || []).map(t => ({
      id: 'PP-' + (t.id || '').slice(0, 6).toUpperCase(),
      type: typeFor(t.category), subject: t.subject,
      created: (t.created_at || '').slice(0, 10),
      status: statusLabel[t.status] || 'In progress',
      priority: (t.priority || 'normal').charAt(0).toUpperCase() + (t.priority || 'normal').slice(1),
      api_id: t.id,
    }));
  }
  function replaceArray(target, items) {
    if (!Array.isArray(target)) return;
    target.length = 0;
    items.forEach(x => target.push(x));
  }

  // ----- Date range helpers --------------------------------------------
  // merchant-v2.html STATE has txDateFrom/To and dispFrom/To hardcoded to a
  // 2026-05-07..2026-05-14 demo window that excludes today's records. We
  // recompute these from STATE.dateRange (today | 7 | 30 | custom) at hydrate
  // and on every date-range tab change so Transactions / Disputes / Balance
  // all honour the same date filter.
  // LOCAL date helpers — fmtDateTime stores `t.date` in local time, so the
  // bounds must be local too. Using toISOString().slice(0,10) was UTC which
  // could drop transactions made in the same calendar day for users in
  // non-UTC timezones (Turkey UTC+3, etc).
  function _ppLocalISO(d) {
    const p = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function _ppToday() { return _ppLocalISO(new Date()); }
  function _ppShift(days) {
    const d = new Date(); d.setDate(d.getDate() - days);
    return _ppLocalISO(d);
  }
  function _ppDateBounds() {
    const range = (window.STATE && window.STATE.dateRange) || 'today';
    if (range === 'today')  return { from: _ppToday(),  to: _ppToday() };
    if (range === '7')      return { from: _ppShift(6), to: _ppToday() };
    if (range === '30')     return { from: _ppShift(29), to: _ppToday() };
    if (range === 'custom') return { from: window.STATE.customStart, to: window.STATE.customEnd };
    return { from: _ppToday(), to: _ppToday() };
  }
  function _ppApplyDateBoundsToFilters() {
    if (!window.STATE) return;
    const b = _ppDateBounds();
    window.STATE.txDateFrom = b.from;
    window.STATE.txDateTo   = b.to;
    window.STATE.dispFrom   = b.from;
    window.STATE.dispTo     = b.to;
  }

  // ----- Real wallet balance -------------------------------------------
  // merchant-v2.html overview hardcodes `const TOTAL_WALLET = 124580.40`.
  // Compute net = successful collections - settled outgoing transfers within
  // the selected date range, then overwrite `.wallet-balance` after render.
  // NOTE: mapTxStatus normalises 'success' -> 'ok', so we match 'ok' (not
  // 'Successful'). Same for transfers: bridge keeps raw backend status.
  function _ppInRange(dateStr, b) {
    const d = String(dateStr || '').slice(0, 10);
    if (!d) return false;
    if (b.from && d < b.from) return false;
    if (b.to   && d > b.to)   return false;
    return true;
  }
  // Sum successful collections. The 2nd arg toggles between
  //   "wallet" mode  → excludes channel='cash' (physical cash never lands in
  //                    the digital wallet, so Available Balance ignores it)
  //   "revenue" mode → includes EVERY channel (revenue = all earned income
  //                    regardless of how it was collected)
  function _ppSumTx(filterFn, mode) {
    return (window.TX || []).reduce((s, t) => {
      if (!t || t.status !== 'ok') return s;
      if (mode === 'wallet' && t.channel === 'cash') return s;
      if (filterFn && !filterFn(t)) return s;
      return s + (Number(t.amount) || 0);
    }, 0);
  }
  function _ppSumOutgoing(filterFn) {
    const reducer = (s, t) => {
      if (!t) return s;
      if (filterFn && !filterFn(t)) return s;
      return s + (Number(t.amount) || 0);
    };
    return (window.PAYOUTS || []).reduce(reducer, 0)
         + (window.APPROVALS || []).reduce(reducer, 0);
  }
  function _ppComputeBalance() {
    // Available balance = digital wallet net for the active date range.
    // Cash sales are recorded in transactions and counted toward Revenue but
    // NOT toward the wallet — physical cash sits at the counter, not in the
    // PepaPay wallet. Pass mode='wallet' so _ppSumTx skips channel='cash'.
    const b = _ppDateBounds();
    const inRange = (t) => _ppInRange(t.date, b);
    const inn = _ppSumTx(inRange, 'wallet');
    const out = _ppSumOutgoing(inRange);
    if (inn === 0 && out === 0 && ((window.TX || []).length || (window.PAYOUTS || []).length || (window.APPROVALS || []).length)) {
      return _ppSumTx(null, 'wallet') - _ppSumOutgoing(null);
    }
    return inn - out;
  }
  function _ppRefreshWalletBalance() {
    const el = document.querySelector('.wallet-balance');
    if (!el) return;
    const bal = _ppComputeBalance();
    const parts = Math.abs(bal).toFixed(2).split('.');
    const whole = (bal < 0 ? '-' : '') + Number(parts[0]).toLocaleString('en-US');
    el.innerHTML = 'GHS ' + whole + '<span style="color:#9DB1C7">.' + parts[1] + '</span>';
  }

  // Override the 3 Overview KPI cards (Total revenue / Transactions / Active
  // customers). views.overview computes them from mock branch revenues, which
  // with a single live branch (revenue=1) and certain date ranges produces
  // NaN. Replace with REAL counts from the hydrated arrays so the user always
  // sees meaningful numbers.
  function _ppRefreshOverviewKpis() {
    const b = _ppDateBounds();
    const inRange = (t) => _ppInRange(t.date, b);
    const txInRange = (window.TX || []).filter(t => t && t.status === 'ok' && inRange(t));
    let revenue = txInRange.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    let txCount = txInRange.length;
    const phoneSet = new Set();
    txInRange.forEach(t => { if (t.phone && t.phone !== '—') phoneSet.add(t.phone); });
    let custCount = phoneSet.size;

    // Same defensive fallback: if the date range catches nothing, show
    // all-time so the user never sees zeros for clearly-populated data.
    if (txCount === 0 && (window.TX || []).some(t => t && t.status === 'ok')) {
      const allOk = (window.TX || []).filter(t => t && t.status === 'ok');
      revenue = allOk.reduce((s, t) => s + (Number(t.amount) || 0), 0);
      txCount = allOk.length;
      const allPhones = new Set();
      allOk.forEach(t => { if (t.phone && t.phone !== '—') allPhones.add(t.phone); });
      custCount = allPhones.size;
    }

    // The first .kpi card on overview is Total revenue, second is Transactions,
    // third is Active customers. Use the .label text as a defensive matcher.
    const cards = document.querySelectorAll('#mainView .card.kpi, main .card.kpi, .grid .card.kpi');
    cards.forEach(card => {
      const labelEl = card.querySelector('.label');
      const valueEl = card.querySelector('.value');
      if (!labelEl || !valueEl) return;
      const label = (labelEl.textContent || '').trim().toLowerCase();
      if (label === 'total revenue') {
        valueEl.textContent = 'GHS ' + revenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      } else if (label === 'transactions') {
        valueEl.textContent = txCount.toLocaleString('en-US');
      } else if (label === 'active customers') {
        valueEl.textContent = custCount.toLocaleString('en-US');
      }
    });
  }
  // Wrap setView so overview's hardcoded balance is overwritten *in the same
  // JS task* as the template render — no setTimeout, so the browser never
  // paints the stale 124,580.40 value between the two mutations.
  // Wrap setDateRange so date-bound filters and the balance widget update
  // together when the user switches Today / 7 / 30 / Custom.
  (function () {
    function _install() {
      if (typeof window.setView !== 'function') { setTimeout(_install, 50); return; }
      if (!window.setView._ppWrapped) {
        const _origView = window.setView;
        const wrappedView = function (v) {
          const r = _origView.apply(this, arguments);
          if (v === 'overview') {
            _ppRefreshWalletBalance();
            _ppRefreshOverviewKpis();
          }
          return r;
        };
        wrappedView._ppWrapped = true;
        window.setView = wrappedView;
      }
      if (typeof window.setDateRange === 'function' && !window.setDateRange._ppWrapped) {
        const _origRange = window.setDateRange;
        const wrappedRange = function (r) {
          // Update bounds BEFORE setView re-renders so Transactions/Disputes
          // see the new range. setView itself triggers the balance repaint.
          if (window.STATE) window.STATE.dateRange = r;
          _ppApplyDateBoundsToFilters();
          return _origRange.apply(this, arguments);
        };
        wrappedRange._ppWrapped = true;
        window.setDateRange = wrappedRange;
      }
    }
    _install();
  })();

  // ---- Phase 4d mappers: Phase 3 lists → design array shapes ----
  function _fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toISOString().slice(0, 10); } catch (_) { return (iso || '').slice(0, 10); }
  }
  function _relativeTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const diff = Date.now() - t;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' h ago';
    const d = Math.floor(h / 24);
    if (d === 1) return 'Yesterday';
    if (d < 7) return d + ' days ago';
    if (d < 30) return Math.floor(d / 7) + ' weeks ago';
    return Math.floor(d / 30) + ' months ago';
  }
  function mapInvoices(apiList) {
    const statusLabel = { draft: 'Draft', sent: 'Sent', paid: 'Paid', overdue: 'Overdue', void: 'Void' };
    return (apiList || []).map(i => ({
      id: i.number || ('INV-' + (i.id || '').slice(0, 6)),
      customer: i.customer_name || 'Customer',
      email: i.customer_email || '',
      issued: i.issue_date || _fmtDate(i.created_at),
      due: i.due_date || '',
      amount: Number(i.total || 0),
      status: statusLabel[i.status] || 'Sent',
      branch: 'Accra HQ',
      api_id: i.id,
    }));
  }
  function mapLinks(apiList) {
    return (apiList || []).map(l => ({
      id: l.id, name: l.name || 'Payment link',
      url: 'pepa.link/' + (l.slug || ''),
      amount: l.amount_mode === 'open' ? 'Customer chooses' : ('GHS ' + Number(l.amount || 0).toFixed(2)),
      mode: l.amount_mode === 'open' ? 'Open' : 'Fixed',
      uses: l.uses_count || 0,
      collected: Number(l.collected || 0),
      branch: 'Accra HQ',
      created: _fmtDate(l.created_at),
      active: l.active !== false,
      slug: l.slug,
    }));
  }
  function mapDisputes(apiList) {
    const statusLabel = { open: 'Open', under_review: 'Open', won: 'Won', lost: 'Lost', refunded: 'Refunded' };
    return (apiList || []).map(d => ({
      id: d.case_ref || ('DSP-' + (d.id || '').slice(0, 6)),
      tx: d.transaction_ref || '',
      customer: d.customer_name || 'Customer',
      phone: d.customer_phone || '—',
      reason: d.reason || '',
      amount: Number(d.amount || 0),
      status: statusLabel[d.status] || 'Open',
      branch: 'Accra HQ',
      opened: _fmtDate(d.opened_at || d.created_at),
      api_id: d.id,
    }));
  }
  function mapBeneficiaries(apiList) {
    const channelLabel = { bank: 'Bank', mtn: 'MTN MoMo', telecel: 'Telecel Cash', at: 'AT Money', qr: 'PepaPay', biz: 'PepaPay' };
    return (apiList || []).map(b => ({
      id: b.id,
      name: b.name,
      dest: channelLabel[b.channel] || (b.channel || 'Bank'),
      number: b.destination || '',
      channel: b.channel || 'bank',
      type: b.beneficiary_type || 'individual',
    }));
  }
  function mapApprovals(apiList) {
    return (apiList || []).filter(a => a.status === 'pending').map(a => ({
      id: a.reference || a.id,
      api_id: a.id,
      date: (a.created_at || '').slice(0, 16).replace('T', ' '),
      requester: a.requested_by_name || 'Owner',
      dest: a.dest_label || '',
      name: a.note || (a.dest_type + ' transfer'),
      amount: Number(a.amount || 0),
      reason: 'Requires PIN approval',
      type: a.dest_type === 'payroll' ? 'payroll' : (a.dest_type === 'bulk' ? 'bulk' : undefined),
      items: a.items || undefined,
    }));
  }
  function mapNotifications(apiList) {
    return (apiList || []).map(n => ({
      id: n.id,
      icon: n.icon || 'sys',
      category: n.category || 'system',
      title: n.title || '',
      body: n.body || '',
      time: _relativeTime(n.created_at),
      read: !!n.read,
    }));
  }
  function mapPayouts(apiList) {
    return (apiList || []).map(p => ({
      id: p.reference || p.id,
      date: (p.settled_at || p.created_at || '').slice(0, 16).replace('T', ' '),
      dest: p.dest_label || '',
      name: p.note || p.dest_label || 'Payout',
      amount: Number(p.amount || 0),
      status: 'ok',
      branch: 'Accra HQ',
    }));
  }
  function mapActivities(apiResp) {
    const items = (apiResp && apiResp.items) ? apiResp.items : (Array.isArray(apiResp) ? apiResp : []);
    return items.map(a => ({
      who: a.actor_name || 'System',
      action: (a.action || '').replace(/\./g, ' '),
      detail: a.detail || '',
      time: (a.created_at || '').slice(0, 16).replace('T', ' '),
      ip: a.ip_address || '—',
    }));
  }
  function mapKycDocs(apiList) {
    // M10 /kyc/uploads returns rows per doc_type
    const grouped = {};
    (apiList || []).forEach(u => {
      const key = u.doc_type || 'misc';
      if (!grouped[key]) {
        grouped[key] = { key, name: _kycLabel(key), kind: _kycKind(key), files: [], status: _kycStatus(u.status) };
      }
      grouped[key].files.push({
        name: u.file_name || 'document',
        size: u.size_bytes ? (u.size_bytes < 1024*1024 ? Math.round(u.size_bytes/1024)+' KB' : (u.size_bytes/(1024*1024)).toFixed(2)+' MB') : '—',
        uploaded: _fmtDate(u.created_at),
        api_id: u.id,
      });
    });
    return Object.values(grouped);
  }
  function _kycLabel(t) {
    const m = {
      biz_cert: 'Business Certificate', business_cert: 'Business Certificate',
      reg_form: 'Registration forms', registration: 'Registration forms',
      license: 'Business operating license', operating_license: 'Business operating license',
      bank_letter: 'Bank confirmation letter', tin: 'TIN certificate (GRA)',
    };
    return m[t] || (t || 'Document').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  function _kycKind(t) {
    if (/license/.test(t)) return 'license';
    if (/reg/.test(t)) return 'reg';
    if (/biz/.test(t)) return 'biz';
    return 'biz';
  }
  function _kycStatus(s) {
    return ({ approved: 'Approved', pending_ops: 'Pending review', rejected: 'Rejected', expired: 'Expired' })[s] || 'Pending review';
  }
  function mapKycOwners(apiList) {
    return (apiList || []).map(o => ({
      key: o.key, name: o.name, role: o.role || 'Director',
      frontFile: o.front_file_name ? { name: o.front_file_name, size: o.front_file_size || '—', uploaded: _fmtDate(o.created_at) } : null,
      backFile:  o.back_file_name  ? { name: o.back_file_name,  size: o.back_file_size  || '—', uploaded: _fmtDate(o.created_at) } : null,
      isPep: !!o.is_pep, pepRelation: o.pep_relation || '', pepPosition: o.pep_position || '',
    }));
  }
  function mapKycExtras(apiList) {
    return (apiList || []).map(e => ({
      key: e.key, name: e.name || 'Extra document', category: e.category || 'misc',
      files: [], status: 'Pending review',
    }));
  }
  function mapPayroll(apiList) {
    return (apiList || []).map(r => ({
      name: r.name, role: r.role || 'Employee',
      branch: r.branch || 'All branches',
      bank: r.bank || '—', number: r.number || '—',
      salary: Number(r.salary || 0),
      employee_id: r.employee_id,
    }));
  }

  let _hydrating = false;
  async function hydrateAll() {
    if (_hydrating) return;
    _hydrating = true;
    try {
      const [me, txResp, customers, branches, employees, tickets, services,
             invoices, links, disputes, beneficiaries, approvals, notifications, payouts, audit,
             kycUploads, kycOwners, kycExtras, payroll] = await Promise.all([
        mApi('/api/v1/merchant/me').catch(() => null),
        mApi('/api/v1/merchant/transactions?limit=200').catch(() => ({ items: [] })),
        mApi('/api/v1/merchant/customers').catch(() => []),
        mApi('/api/v1/merchant/branches').catch(() => []),
        mApi('/api/v1/merchant/employees').catch(() => []),
        mApi('/api/v1/merchant/support/tickets').catch(() => []),
        mApi('/api/v1/merchant/services').catch(() => []),
        mApi('/api/v1/merchant/invoices').catch(() => []),
        mApi('/api/v1/merchant/payment-links').catch(() => []),
        mApi('/api/v1/merchant/disputes').catch(() => []),
        mApi('/api/v1/merchant/beneficiaries').catch(() => []),
        mApi('/api/v1/merchant/approvals').catch(() => []),
        mApi('/api/v1/merchant/notifications?limit=50').catch(() => []),
        mApi('/api/v1/merchant/payouts').catch(() => []),
        mApi('/api/v1/merchant/audit-log').catch(() => ({ items: [] })),
        mApi('/api/v1/merchant/kyc/uploads').catch(() => []),
        mApi('/api/v1/merchant/kyc/owners').catch(() => []),
        mApi('/api/v1/merchant/kyc/extras').catch(() => []),
        mApi('/api/v1/merchant/payroll/roster').catch(() => []),
      ]);

      if (me && me.merchant) {
        const brandName = (me.merchant.legal_name && me.merchant.legal_name.trim())
                          || me.merchant.mid || 'Merchant';
        const brandEl = document.querySelector('.sidebar .brand-name');
        // The static HTML hardcodes `Bentil <span>Foods</span>` (text + green
        // span). Replacing only firstChild leaves the stale " Foods" suffix
        // (=> "BIZ-676E7F Foods"). Rewrite the whole element instead.
        if (brandEl) brandEl.textContent = brandName;
        const whoB = document.querySelector('.side-footer .who b');
        if (whoB) whoB.textContent = me.full_name || me.email || '—';
        const whoSmall = document.querySelector('.side-footer .who small');
        if (whoSmall) whoSmall.textContent = (me.role || '').replace(/\b\w/g, c => c.toUpperCase()) + ' · ' + brandName;
        const inits = (me.full_name || me.email || '?').split(/[\s@.]/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
        document.querySelectorAll('.profile-avatar, .side-footer .avatar').forEach(el => el.textContent = inits);
      }

      const branchNameById = {};
      (branches || []).forEach(b => { branchNameById[b.id] = b.name; });
      const defaultBranchName = (branches[0] && branches[0].name) || 'Main';

      replaceArray(window.BRANCHES, mapBranches(branches));
      if (Array.isArray(window.ALL_BRANCH_NAMES)) {
        window.ALL_BRANCH_NAMES.length = 0;
        window.BRANCHES.forEach(b => window.ALL_BRANCH_NAMES.push(b.name));
      }
      if (window.STATE && window.STATE.selectedBranches && window.STATE.selectedBranches.add) {
        window.STATE.selectedBranches = new Set(window.ALL_BRANCH_NAMES);
      }

      replaceArray(window.TX,            mapTransactions((txResp || {}).items || txResp, branchNameById));
      replaceArray(window.CUSTOMERS,     mapCustomers(customers, defaultBranchName));
      replaceArray(window.TEAM,          mapTeam(employees));
      replaceArray(window.TICKETS,       mapTickets(tickets));
      replaceArray(window.INVOICES,      mapInvoices(invoices));
      replaceArray(window.LINKS,         mapLinks(links));
      replaceArray(window.DISPUTES,      mapDisputes(disputes));
      replaceArray(window.BENEFICIARIES, mapBeneficiaries(beneficiaries));
      replaceArray(window.APPROVALS,     mapApprovals(approvals));
      replaceArray(window.NOTIFICATIONS, mapNotifications(notifications));
      replaceArray(window.PAYOUTS,       mapPayouts(payouts));
      replaceArray(window.ACTIVITIES,    mapActivities(audit));
      replaceArray(window.KYC_DOCS,           mapKycDocs(kycUploads));
      replaceArray(window.KYC_OWNERS,         mapKycOwners(kycOwners));
      replaceArray(window.KYC_EXTRA,          mapKycExtras(kycExtras));
      replaceArray(window.PAYROLL_EMPLOYEES,  mapPayroll(payroll));
      if (typeof window.updateApprovalsCount === 'function') window.updateApprovalsCount();
      if (typeof window.updateNotifBadge === 'function')     window.updateNotifBadge();

      // Sidebar nav badges (Transactions "128", Disputes & Refunds "3") were
      // hardcoded in the HTML. Replace with real counts; hide when 0.
      function _setNavBadge(view, n) {
        const item = document.querySelector('.nav-item[data-view="' + view + '"]');
        if (!item) return;
        const b = item.querySelector('.badge');
        if (!b) return;
        if (!n) { b.style.display = 'none'; return; }
        b.textContent = String(n);
        b.style.display = '';
      }
      _setNavBadge('transactions', (window.TX || []).length);
      _setNavBadge('disputes',     (window.DISPUTES || []).filter(d => {
        const s = (d.status || '').toLowerCase();
        return s !== 'refunded' && s !== 'resolved' && s !== 'closed';
      }).length);

      // STATE.txDateFrom/To and STATE.dispFrom/To are hardcoded to a stale
      // 2026-05-07..2026-05-14 demo window — that excludes every record made
      // since. Sync them with STATE.dateRange so Transactions, Disputes, and
      // Balance all see the same filter.
      _ppApplyDateBoundsToFilters();

      // Overview wallet balance is hardcoded in merchant-v2.html as
      //   const TOTAL_WALLET = 124580.40;
      // Replace it with: sum(successful collections) - sum(settled transfers).
      // Re-applies after each setView('overview') via the wrap below.
      _ppRefreshWalletBalance();

      if (Array.isArray(services) && window.STATE && window.STATE.servicesEnabled) {
        const codeToLabel = {
          qr_pay: 'PepaPay QR', pos_terminal: 'POS terminal', payment_link: 'Payment links',
          invoices: 'Invoices', ussd_payment: 'USSD payments', bulk_payout: 'Bulk payouts',
          recurring: 'Recurring billing', online_checkout: 'Online checkout', momo_collect: 'PepaPay QR',
        };
        services.forEach(s => {
          const label = codeToLabel[s.code] || s.name;
          if (label && label in window.STATE.servicesEnabled) {
            window.STATE.servicesEnabled[label] = !!s.enabled;
          }
        });
      }

      if (typeof window.setView === 'function' && window.STATE && window.STATE.view) {
        window.setView(window.STATE.view);
      }
      // setView wrap already repaints `.wallet-balance` synchronously after the
      // overview template renders, so no extra timer here — the hardcoded
      // 124,580.40 never reaches a paint.
      window._ppHydrated = true;
    } catch (e) {
      console.error('[PepaPay merchant-v2] hydration failed', e);
    } finally {
      _hydrating = false;
      // Release the CSS gate (body:not(.pp-hydrated) #appView { visibility:hidden })
      // ONLY after hydration is done. If we released it on a fixed 450ms timer,
      // a slow API would let the hardcoded 124,580.40 wallet value reach a paint
      // before the bridge overwrote it.
      document.body.classList.add('pp-hydrated');
    }
  }
  window.mHydrate = hydrateAll;

  // ---------- Auto-refresh: no more F5 ----------------------------------
  // 1) Refetch immediately when the tab becomes visible (user switches back
  //    from another tab, or wakes the device). Catches cross-portal changes
  //    instantly — e.g. a cash recorded on /mobile appears as soon as the
  //    user clicks the /merchant tab.
  // 2) Background poll every 30s while the tab is visible. Hidden tabs skip
  //    the poll so we don't burn battery / quota.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && localStorage.getItem(TOKEN_KEY) && !_hydrating) {
      hydrateAll();
    }
  });
  setInterval(function () {
    if (!document.hidden && localStorage.getItem(TOKEN_KEY) && !_hydrating) {
      hydrateAll();
    }
  }, 30000);

  const _origShowApp = window.showApp;
  window.showApp = function () {
    if (typeof _origShowApp === 'function') _origShowApp();
    setTimeout(hydrateAll, 50);
    setTimeout(() => {
      if (window.hydrateNotifications) window.hydrateNotifications();
      if (window.hydrateApprovals)    window.hydrateApprovals();
    }, 350);
    // pp-hydrated is now added by hydrateAll's finally — see below.
    // Safety net: if hydrateAll never runs (e.g. network completely down),
    // release the gate after 5s so the user is never stuck on a blank screen.
    setTimeout(() => { document.body.classList.add('pp-hydrated'); }, 5000);
  };

  if (localStorage.getItem(TOKEN_KEY)) {
    try { sessionStorage.setItem(AUTHED_KEY, '1'); } catch (_) {}
  }
  document.addEventListener('DOMContentLoaded', () => {
    const isAuthed = !!localStorage.getItem(TOKEN_KEY);
    const loginView = document.getElementById('loginView');
    const loginVisible = loginView && loginView.style.display !== 'none';
    if (isAuthed) {
      if (loginVisible) {
        window.showApp();
      } else {
        // Inline boot at the bottom of merchant-v2.html already called the
        // LEXICAL showApp(), bypassing our window.showApp wrap. Trigger
        // hydration directly so live data lands.
        hydrateAll();
      }
    } else {
      // Login screen is outside #appView and not gated — release immediately
      // so any auth UI inside #appView (none currently) wouldn't be blocked.
      document.body.classList.add('pp-hydrated');
    }
    // Safety net only — hydrateAll's finally normally adds pp-hydrated as soon
    // as the data lands. If everything fails (e.g. network completely down),
    // release the gate after 5s so the user isn't stuck on a blank screen.
    setTimeout(() => { document.body.classList.add('pp-hydrated'); }, 5000);
  });

  // ============================================================================
  // Phase 4 — bind submit handlers to real backend endpoints
  // ============================================================================
  const toast = (...a) => (window.toast || console.log)(...a);
  const closeAll = () => (window.closeAll || (() => {}))();
  const setView  = (n) => (window.setView  || (() => {}))(n);
  const openModal = (id) => (window.openModal || (() => {}))(id);
  function readVal(id) { const el = document.getElementById(id); return el ? (el.value || '').trim() : ''; }
  function readNum(id) { const v = readVal(id); return v ? parseFloat(v.replace(/,/g,'')) || 0 : 0; }

  // ---- Transfer ----
  window.submitTransfer = async function () {
    const amt = readNum('xferAmount');
    if (!(amt > 0)) { toast('Enter an amount', 'warn'); return; }
    const destType = (window.STATE && window.STATE._xferDest) || 'bank';
    let destLabel = 'Transfer recipient';
    if (destType === 'bank') {
      const bank = readVal('xferBank'); const acct = readVal('xferAcct');
      destLabel = (bank || 'Bank') + ' · ' + (acct || '—');
    } else if (destType === 'branch') {
      const sel = document.querySelector('#xferDestForm select');
      destLabel = 'Branch transfer · ' + (sel ? sel.value : '—');
    } else {
      const inp = document.querySelector('#xferDestForm input[type="tel"], #xferDestForm input[placeholder*="Phone"], #xferDestForm input');
      destLabel = (destType === 'momo' ? 'MoMo · ' : '@') + (inp ? inp.value : '—');
    }
    try {
      await mApi('/api/v1/merchant/transfers', {
        method:'POST',
        body: { dest_type: destType, dest_label: destLabel, amount: amt, note: readVal('xferNote') || null },
      });
      closeAll();
      toast('Transfer pending approval · ' + (window.fmt ? window.fmt(amt) : 'GHS ' + amt), 'ok', 'Approve from the Approvals tab');
      if (window.hydrateApprovals) await window.hydrateApprovals();
      if (window.STATE && window.STATE.view === 'transfers' && window.setTransferTab) window.setTransferTab('approvals');
    } catch (e) {
      toast('Transfer error: ' + e.message, 'err');
    }
  };

  // ---- Invoice ----
  window.submitInvoice = async function () {
    const lines = Array.from(document.querySelectorAll('#invLines .inv-line')).map(row => {
      const desc = (row.querySelector('.li-desc') || {}).value || '';
      const qty  = parseFloat((row.querySelector('.li-qty')   || {}).value) || 0;
      const price= parseFloat((row.querySelector('.li-price') || {}).value) || 0;
      return { description: desc, qty, unit_price: price };
    }).filter(l => l.qty > 0 && l.unit_price >= 0);
    if (!lines.length) { toast('Add at least one line', 'warn'); return; }
    const recipients = (window.STATE && window.STATE.invRecipients) || [];
    const channels = [];
    if (document.getElementById('invChEmail') && document.getElementById('invChEmail').checked) channels.push('email');
    if (document.getElementById('invChWA')    && document.getElementById('invChWA').checked)    channels.push('whatsapp');
    if (document.getElementById('invChSMS')   && document.getElementById('invChSMS').checked)   channels.push('sms');
    if (document.getElementById('invChLink')  && document.getElementById('invChLink').checked)  channels.push('link');
    try {
      const r = await mApi('/api/v1/merchant/invoices', {
        method:'POST',
        body: {
          customer_name: readVal('invCust') || 'Customer',
          customer_phone: readVal('invPhone') || null,
          recipients,
          number: readVal('invNo') || null,
          issue_date: readVal('invIssue') || null,
          due_date: readVal('invDue') || null,
          note: readVal('invNote') || null,
          channels: channels.length ? channels : ['email'],
          lines,
        },
      });
      try { await mApi('/api/v1/merchant/invoices/' + r.id + '/send', { method:'POST' }); } catch (_) {}
      closeAll();
      toast('Invoice sent · ' + r.number, 'ok', window.fmt ? window.fmt(r.total) : 'GHS ' + r.total);
      if (window.STATE && window.STATE.view === 'invoices') setView('invoices');
    } catch (e) {
      toast('Invoice error: ' + e.message, 'err');
    }
  };

  // ---- Payment Link ----
  window.submitLink = async function () {
    const name = readVal('lnkName');
    if (!name) { toast('Link name is required', 'warn'); return; }
    const mode = (document.querySelector('input[name="amtType"]:checked') || {}).value || 'fixed';
    const amt  = mode === 'fixed' ? readNum('lnkAmt') : null;
    try {
      const r = await mApi('/api/v1/merchant/payment-links', {
        method:'POST',
        body: {
          name, description: readVal('lnkDesc') || null,
          amount: amt, amount_mode: mode,
          slug: readVal('lnkSlug') || null,
          max_uses: parseInt(readVal('lnkMax')) || null,
          expires_at: readVal('lnkExp') || null,
          collect_info: readVal('lnkCollect') || null,
        },
      });
      const url = 'pepa.link/' + r.slug;
      try { await navigator.clipboard.writeText(url); } catch (_) {}
      closeAll();
      toast('Link created', 'ok', 'Copied: ' + url);
      if (window.STATE && window.STATE.view === 'links') setView('links');
    } catch (e) {
      toast('Link error: ' + e.message, 'err');
    }
  };

  // ---- PIN approval ----
  // mapApprovals stores the human-readable reference (AP-XXXXX) on `.id` and
  // the actual database UUID on `.api_id`. The HTML's onclick captures `.id`
  // into STATE._pendingApproval, so the URL path becomes /approvals/AP-XXXXX/...
  // which fails Pydantic UUID validation ("Request validation failed").
  // Resolve to the real UUID via window.APPROVALS lookup before hitting the API.
  function _ppApprovalUuid(ref) {
    var arr = window.APPROVALS || [];
    var it = arr.find(function (a) { return a && (a.id === ref || a.api_id === ref); });
    return (it && it.api_id) || ref;
  }
  window.submitPinApproval = async function () {
    const v = (document.getElementById('pinInput').value || '').trim();
    const err = document.getElementById('pinError');
    if (v.length !== 4 || !/^\d{4}$/.test(v)) { err.textContent = 'Enter the 4-digit code.'; return; }
    const ref = window.STATE && window.STATE._pendingApproval;
    if (!ref) { err.textContent = 'No transfer awaiting approval.'; return; }
    const id = _ppApprovalUuid(ref);
    try {
      await mApi('/api/v1/merchant/approvals/' + id + '/approve', { method:'POST', body: { pin: v } });
      // DO NOT splice from window.APPROVALS or call hydrateApprovals alone:
      // that drops the just-approved transfer from APPROVALS but leaves
      // PAYOUTS stale (it doesn't yet contain the now-settled transfer).
      // The balance widget then double-counts the removal and jumps up.
      // Full mHydrate refreshes BOTH /approvals AND /payouts so the wallet
      // math stays consistent.
      err.textContent = '';
      const m2 = document.getElementById('approveConfirmModal'); if (m2) m2.classList.remove('show');
      const anyOpen = document.querySelectorAll('.modal.show, .slideover.show').length > 0;
      if (!anyOpen) document.getElementById('overlay').classList.remove('show');
      toast('Transfer approved and sent', 'ok');
      if (window.mHydrate) await window.mHydrate();
      if (window.updateApprovalsCount) window.updateApprovalsCount();
      const slide = document.getElementById('approvalsSlide');
      if (slide && slide.classList.contains('show') && window.renderApprovalsList) window.renderApprovalsList();
      if (window.STATE && window.STATE.view === 'transfers') setView('transfers');
    } catch (e) {
      err.textContent = e.message || 'Approval failed.';
    }
  };
  window.submitReject = async function () {
    const reason = (document.getElementById('rejectReason').value || '').trim();
    if (!reason) { toast('Enter a rejection reason', 'warn'); return; }
    const ref = window.STATE && window.STATE._pendingApproval;
    if (!ref) return;
    const id = _ppApprovalUuid(ref);
    try {
      await mApi('/api/v1/merchant/approvals/' + id + '/reject', { method:'POST', body: { reason } });
      // Same reason as submitPinApproval: do a full mHydrate so APPROVALS,
      // PAYOUTS and audit-log stay in sync. A rejected transfer leaves the
      // wallet (no longer committed) — full refresh keeps balance correct.
      const m2 = document.getElementById('rejectApprovalModal'); if (m2) m2.classList.remove('show');
      const anyOpen = document.querySelectorAll('.modal.show, .slideover.show').length > 0;
      if (!anyOpen) document.getElementById('overlay').classList.remove('show');
      toast('Transfer rejected', 'info');
      if (window.mHydrate) await window.mHydrate();
      if (window.updateApprovalsCount) window.updateApprovalsCount();
      if (window.STATE && window.STATE.view === 'transfers') setView('transfers');
    } catch (e) {
      toast('Rejection failed: ' + e.message, 'err');
    }
  };

  // ---- PIN change ----
  window.submitChangePin = async function () {
    const cur = readVal('pinCurrent'); const nw = readVal('pinNew'); const conf = readVal('pinConfirm');
    const err = document.getElementById('pinChangeError');
    const setErr = msg => err && (err.textContent = msg);
    if (!/^\d{4}$/.test(cur)) return setErr('Current PIN must be 4 digits.');
    if (!/^\d{4}$/.test(nw))  return setErr('New PIN must be 4 digits.');
    if (nw === cur)           return setErr('New PIN must differ from the current one.');
    if (nw !== conf)          return setErr('PIN confirmation does not match.');
    if (/^(\d)\1{3}$/.test(nw)) return setErr('Avoid repeating digits like 1111.');
    if (['0123','1234','2345','3456','4567','5678','6789','9876','8765','4321'].includes(nw)) return setErr('Choose a less predictable PIN.');
    try {
      await mApi('/api/v1/merchant/settings/pin', { method:'PATCH', body: { current_pin: cur, new_pin: nw } });
      closeAll();
      toast('PIN changed', 'ok');
    } catch (e) {
      setErr(e.message || 'Could not change PIN.');
    }
  };

  // ---- Loyalty tiers ----
  window.saveTiers = async function () {
    const mode = (window.STATE && window.STATE.tierMode) || 'spend';
    const get  = id => parseFloat(document.getElementById(id).value || '0') || 0;
    const t    = { Teal: 0, Bronze: get('tBronze'), Silver: get('tSilver'), Gold: get('tGold') };
    if (!(t.Bronze < t.Silver && t.Silver < t.Gold)) { toast('Thresholds must be ascending: Bronze < Silver < Gold', 'warn'); return; }
    try {
      await mApi('/api/v1/merchant/settings/loyalty-tiers', { method:'PATCH', body: { mode, thresholds: t } });
      if (window.STATE) { if (mode === 'visits') window.STATE.tierVisits = t; else window.STATE.tierSpend = t; }
      closeAll();
      toast('Tier thresholds saved', 'ok');
      if (window.STATE && window.STATE.view === 'customers') setView('customers');
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
    if (window.mHydrate) window.mHydrate();
  };

  // ---- Segments ----
  window.saveSegmentRules = async function () {
    const num = id => Math.max(1, parseInt(document.getElementById(id).value, 10) || 1);
    const next = { newMonths: num('segNew'), activeMonths: num('segActive'), dormantMonths: num('segDormant') };
    if (next.activeMonths >= next.dormantMonths) { toast('Dormant must be greater than Active', 'warn'); return; }
    try {
      await mApi('/api/v1/merchant/settings/segment-rules', { method:'PATCH', body: next });
      if (window.STATE) window.STATE.segmentRules = next;
      toast('Segment rules saved', 'ok');
      const panel = document.getElementById('settingsPanel');
      if (panel && window.settingsPanels) panel.innerHTML = window.settingsPanels.segments();
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
    if (window.mHydrate) window.mHydrate();
  };

  // ---- Role permissions ----
  window.saveRoles = async function () {
    const inputs = document.querySelectorAll('#rolesBody input[type=checkbox][data-perm]');
    const perms = {};
    inputs.forEach(inp => {
      const key = inp.getAttribute('data-perm');
      const idx = parseInt(inp.getAttribute('data-role-idx'), 10);
      if (!perms[key]) perms[key] = [0,0,0,0,0,0];
      perms[key][idx] = (inp.checked || idx === 0) ? 1 : 0;
    });
    try {
      await mApi('/api/v1/merchant/team/roles', { method:'PATCH', body: { permissions: perms } });
      if (window.STATE) window.STATE.rolePermissions = perms;
      closeAll();
      toast('Roles saved', 'ok');
      if (window.applyRoleVisibility) window.applyRoleVisibility();
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
    if (window.mHydrate) window.mHydrate();
  };

  // ---- SMS templates ----
  window.saveSmsTemplate = async function () {
    const which = window.STATE && window.STATE.smsEditing;
    const msg = document.getElementById('smsMessage').value;
    if (!which) return closeAll();
    const body = {}; body[which] = { enabled: true, message: msg };
    try {
      await mApi('/api/v1/merchant/settings/sms-templates', { method:'PATCH', body });
      if (window.STATE && window.STATE.smsTemplates && window.STATE.smsTemplates[which]) {
        window.STATE.smsTemplates[which].message = msg;
      }
      closeAll();
      toast('SMS template saved', 'ok');
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
    if (window.mHydrate) window.mHydrate();
  };

  // ---- Profile save ----
  window.saveProfileForReview = async function () {
    const get = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const payload = {
      name: get('bpName'), dba: get('bpDba'), reg: get('bpReg'),
      tin: get('bpTin'),   industry: get('bpInd'),
      web: get('bpWeb'),   address: get('bpAddr'),
    };
    try {
      await mApi('/api/v1/merchant/settings/profile', { method:'PATCH', body: payload });
      if (window.STATE) {
        window.STATE.profileValues = payload;
        window.STATE.profilePending = true;
        window.STATE.profileEditing = false;
      }
      toast('Profile changes submitted for review', 'ok', 'PepaPay compliance will respond within 24 hours');
      const panel = document.getElementById('settingsPanel');
      if (panel && window.settingsPanels) panel.innerHTML = window.settingsPanels.profile();
    } catch (e) { toast('Submit failed: ' + e.message, 'err'); }
  };

  // ---- API keys ----
  window.generateNewApiKeys = async function () {
    try {
      const r = await mApi('/api/v1/merchant/api-keys', { method:'POST' });
      if (window.STATE && window.STATE.apiKeys) {
        window.STATE.apiKeys.pub      = r.pub;
        window.STATE.apiKeys.secret   = r.secret;
        window.STATE.apiKeys.revealed = true;
        window.STATE.apiKeys.rotated  = (new Date(r.created_at)).toDateString();
      }
      closeAll();
      const pubEl = document.getElementById('newKeyPub'); if (pubEl) pubEl.textContent = r.pub;
      const secEl = document.getElementById('newKeySecret'); if (secEl) secEl.textContent = r.secret;
      openModal('apiKeyRevealModal');
      const panel = document.getElementById('settingsPanel');
      if (panel && window.settingsPanels) panel.innerHTML = window.settingsPanels.api();
    } catch (e) { toast('API key generation failed: ' + e.message, 'err'); }
  };

  // ---- Mark-all-read button (notif popover) ----
  document.addEventListener('click', async (e) => {
    if (e.target && e.target.id === 'notifMarkAll') {
      try { await mApi('/api/v1/merchant/notifications/mark-all-read', { method:'POST' }); } catch (_) {}
    }
  }, true);

  // ---- Audit log CSV export ----
  window.exportAuditLog = async function () {
    try {
      const token = localStorage.getItem(TOKEN_KEY) || '';
      const resp = await fetch('/api/v1/merchant/audit-log?format=csv', {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'audit-log.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Audit log indirildi', 'ok');
    } catch (e) {
      toast('Export failed: ' + e.message, 'err');
    }
  };

  // ---- Notifications hydrate ----
  window.hydrateNotifications = async function () {
    try {
      const items = await mApi('/api/v1/merchant/notifications?limit=50');
      if (Array.isArray(items) && Array.isArray(window.NOTIFICATIONS)) {
        window.NOTIFICATIONS.length = 0;
        items.forEach(n => window.NOTIFICATIONS.push({
          id: n.id, icon: n.icon, category: n.category,
          title: n.title, body: n.body || '',
          time: (function() {
            const d = new Date(n.created_at); const today = new Date();
            const diffMin = Math.floor((today - d) / 60000);
            if (diffMin < 60) return diffMin + ' min ago';
            if (diffMin < 1440) return Math.floor(diffMin / 60) + ' h ago';
            return Math.floor(diffMin / 1440) + ' days ago';
          })(),
          read: !!n.read,
        }));
        if (window.updateNotifBadge) window.updateNotifBadge();
      }
    } catch (_) {}
  };

  // ---- Approvals hydrate ----
  window.hydrateApprovals = async function () {
    try {
      const items = await mApi('/api/v1/merchant/approvals');
      if (Array.isArray(items) && Array.isArray(window.APPROVALS)) {
        window.APPROVALS.length = 0;
        items.forEach(t => window.APPROVALS.push({
          id: t.id, date: t.created_at,
          requester: t.requested_by_name || '—',
          dest: t.dest_label,
          name: t.dest_type + ' transfer · ' + t.dest_label,
          amount: Number(t.amount),
          reason: t.note || (t.dest_type === 'payroll' ? 'Payroll batch' : 'Outgoing transfer'),
          type: t.dest_type,
          items: Array.isArray(t.items) ? t.items : null,
        }));
        if (window.updateApprovalsCount) window.updateApprovalsCount();
      }
    } catch (_) {}
  };

  // ---- Payroll → POST /transfers (dest_type=payroll) ----
  window.submitPayrollForApproval = async function () {
    const list = ((window.STATE && window.STATE._payrollDraft) || []).filter(e => e.included && (parseFloat(e.salary) || 0) > 0);
    if (!list.length) { toast('Select at least one employee', 'warn'); return; }
    const total = list.reduce((a, e) => a + (parseFloat(e.salary) || 0), 0);
    const items = list.map(e => ({ name: e.name, dest: e.bank + ' · ' + e.number, amount: parseFloat(e.salary) || 0 }));
    try {
      await mApi('/api/v1/merchant/transfers', {
        method:'POST',
        body: {
          dest_type:'payroll',
          dest_label:'Monthly payroll · ' + list.length + ' employee' + (list.length === 1 ? '' : 's'),
          amount: total, items, note:'Salary run',
        },
      });
      closeAll();
      setTimeout(() => {
        const tot = document.getElementById('payrollSentTotal');
        const cnt = document.getElementById('payrollSentCount');
        if (tot) tot.textContent = window.fmt ? window.fmt(total) : 'GHS ' + total;
        if (cnt) cnt.textContent = list.length + ' employee' + (list.length === 1 ? '' : 's');
        openModal('payrollSentModal');
      }, 200);
      if (window.hydrateApprovals) await window.hydrateApprovals();
    } catch (e) { toast('Payroll failed: ' + e.message, 'err'); }
  };

  // ---- Refresh approvals when opening approvals slideover ----
  const _origOpenSlide = window.openSlide;
  window.openSlide = function (id) {
    if (typeof _origOpenSlide === 'function') _origOpenSlide(id);
    if (id === 'approvalsSlide' && window.hydrateApprovals) {
      window.hydrateApprovals().then(() => {
        if (window.renderApprovalsList) window.renderApprovalsList();
      });
    }
  };

  // ---- Phase 4b: wire inline-only handlers to existing M10 endpoints ----

  // Branch creation → POST /branches
  window.submitBranch = async function () {
    const name = readVal('brName');
    if (!name) { toast('Branch name is required', 'warn'); return; }
    const note = readVal('brNote');
    if (!note) { toast('Add a note for the branch', 'warn'); return; }
    try {
      await mApi('/api/v1/merchant/branches', {
        method: 'POST',
        body: {
          name,
          region: readVal('brRegion') || 'Greater Accra',
          address: readVal('brAddress') || null,
          contact_phone: readVal('brPhone') || null,
        },
      });
      closeAll();
      toast('Branch submitted for review', 'ok', name + ' · 24 hour response');
      if (window.setView) window.setView('branches');
    } catch (e) {
      toast('Branch error: ' + e.message, 'err');
    }
  };

  // Employee invite → POST /employees
  window.submitInvite = async function () {
    const name = readVal('inviteName');
    const email = readVal('inviteEmail');
    if (!name) { toast('Full name is required', 'warn'); return; }
    if (!email || !/.+@.+\..+/.test(email)) { toast('Enter a valid email', 'warn'); return; }
    try {
      await mApi('/api/v1/merchant/employees', {
        method: 'POST',
        body: { full_name: name, email, phone: readVal('invitePhone') || null },
      });
      closeAll();
      toast('Invite sent · ' + name, 'ok', email);
    } catch (e) {
      toast('Invite error: ' + e.message, 'err');
    }
  };

  // Support ticket → POST /support/tickets
  window.submitSupportTicket = async function () {
    const subject = readVal('spSubject');
    const body = readVal('spBody');
    if (!subject) { toast('Subject line is required', 'warn'); return; }
    if (!body || body.length < 12) { toast('Add more details', 'warn', 'At least a couple of sentences'); return; }
    const activeCard = document.querySelector('.support-card.active');
    const kind = activeCard ? activeCard.dataset.kind : 'other';
    // Map design "kind" -> backend category
    const catMap = { 'Problem': 'technical', 'Question': 'other', 'Billing': 'billing', 'KYC': 'kyc' };
    try {
      const r = await mApi('/api/v1/merchant/support/tickets', {
        method: 'POST',
        body: { subject, category: catMap[kind] || 'other', priority: 'normal', body },
      });
      const el1 = document.getElementById('spSubject'); if (el1) el1.value = '';
      const el2 = document.getElementById('spBody'); if (el2) el2.value = '';
      toast('Ticket created', 'ok', (r && r.id ? r.id : '') + ' · We will respond within 1 business day');
      if (window.setView) window.setView('support');
    } catch (e) {
      toast('Ticket error: ' + e.message, 'err');
    }
  };

  // Support message → POST /support/tickets/{id}/messages
  window.submitMessage = async function () {
    const body = readVal('msgBody');
    if (!body) { toast('Type your message first', 'warn'); return; }
    const r = (window.STATE && window.STATE._msgRecipient) || {};
    const ticketId = r.ticketId || r.id;
    if (!ticketId) { toast('No ticket selected', 'err'); return; }
    try {
      await mApi('/api/v1/merchant/support/tickets/' + ticketId + '/messages', {
        method: 'POST',
        body: { body },
      });
      closeAll();
      toast('Message sent' + (r.name ? ' · ' + r.name : ''), 'ok');
    } catch (e) {
      toast('Message error: ' + e.message, 'err');
    }
  };

  // Beneficiary remove → DELETE /beneficiaries/{id}
  const _origRemoveBene = window.removeBeneficiary;
  window.removeBeneficiary = async function (id) {
    if (!id) { if (typeof _origRemoveBene === 'function') return _origRemoveBene(id); }
    try {
      await mApi('/api/v1/merchant/beneficiaries/' + id, { method: 'DELETE' });
      if (Array.isArray(window.BENEFICIARIES)) {
        const i = window.BENEFICIARIES.findIndex(b => b.id === id);
        if (i >= 0) window.BENEFICIARIES.splice(i, 1);
      }
      toast('Beneficiary removed', 'ok');
      if (window.STATE && window.STATE.view === 'beneficiaries') setView('beneficiaries');
    } catch (e) {
      toast('Remove beneficiary failed: ' + e.message, 'err');
    }
  };

  // Mark single notification read → PATCH /notifications/{id}/read
  const _origMarkNotif = window.markNotif;
  window.markNotif = async function (id) {
    try {
      await mApi('/api/v1/merchant/notifications/' + id + '/read', { method: 'PATCH', body: {} });
    } catch (e) { /* silent: keep UI optimistic */ }
    if (typeof _origMarkNotif === 'function') return _origMarkNotif(id);
  };

  // ============================================================
  // Phase 4c: customer/branch/team/cash/topup/checkin/ussd/setup
  // ============================================================

  // Add single customer
  window.submitAddCustomer = async function () {
    const name = readVal('newCustName');
    const phone = readVal('newCustPhone');
    if (!name) { toast('Customer name is required', 'warn'); return; }
    try {
      const r = await mApi('/api/v1/merchant/customers', {
        method: 'POST',
        body: { name, phone: phone || null },
      });
      if (Array.isArray(window.CUSTOMERS)) {
        window.CUSTOMERS.unshift({
          id: r.id, name: r.name, phone: r.phone || '—',
          visits: 0, spend: 0, last: 'Today', points: 0,
          branch: (window.activeBranches && window.activeBranches()[0]) || (window.ALL_BRANCH_NAMES || [])[0],
        });
      }
      if (window.STATE) {
        window.STATE.custMonth = '';
        window.STATE.custSearch = '';
        window.STATE.custTiers = new Set();
        window.STATE.custSegments = new Set();
        window.STATE.custPage = 1;
      }
      closeAll();
      toast('Customer added · ' + name, 'ok');
      if (window.STATE && window.STATE.view === 'customers') setView('customers');
    } catch (e) {
      toast('Customer add error: ' + e.message, 'err');
    }
  };

  // Bulk import — for now adds a fixed sample list via /customers/bulk
  window.submitImportCustomers = async function () {
    const sample = [
      { name: 'Augustina Boateng', phone: '0240084471' },
      { name: 'Kweku Donkor',       phone: '0557129911' },
      { name: 'Adwoa Tetteh',       phone: '0206608821' },
      { name: 'Felix Nkrumah',      phone: '0549982240' },
      { name: 'Comfort Asante',     phone: '0260057711' },
    ];
    try {
      const r = await mApi('/api/v1/merchant/customers/bulk', {
        method: 'POST',
        body: { customers: sample },
      });
      if (Array.isArray(window.CUSTOMERS)) {
        for (const c of (r.items || [])) {
          window.CUSTOMERS.unshift({
            id: c.id, name: c.name, phone: c.phone || '—',
            visits: 0, spend: 0, last: 'Today', points: 0,
            branch: (window.activeBranches && window.activeBranches()[0]) || (window.ALL_BRANCH_NAMES || [])[0],
          });
        }
      }
      if (window.STATE) {
        window.STATE.custMonth = '';
        window.STATE.custSearch = '';
        window.STATE.custTiers = new Set();
        window.STATE.custSegments = new Set();
        window.STATE.custPage = 1;
      }
      closeAll();
      toast(r.added + ' customers imported', 'ok', r.skipped + ' duplicates skipped');
      if (window.STATE && window.STATE.view === 'customers') setView('customers');
    } catch (e) {
      toast('Import error: ' + e.message, 'err');
    }
  };

  // Branch edit → PATCH /branches/{id}
  window.submitBranchEdit = async function () {
    const editingName = window.STATE && window.STATE._editingBranch;
    const note = readVal('brEditNote');
    if (!note) { toast('Change reason is required', 'warn', 'Compliance needs context'); return; }
    // Find branch by name to get its id
    let branchId = null;
    if (Array.isArray(window.BRANCHES)) {
      const b = window.BRANCHES.find(x => x.name === editingName);
      if (b) branchId = b.id;
    }
    if (!branchId) { toast('Branch not found', 'err'); return; }
    try {
      const r = await mApi('/api/v1/merchant/branches/' + branchId, {
        method: 'PATCH',
        body: {
          name: readVal('brEditName') || null,
          region: readVal('brEditRegion') || null,
          address: readVal('brEditAddress') || null,
          contact_phone: readVal('brEditPhone') || null,
          note,
        },
      });
      closeAll();
      if (r.in_place) {
        toast('Branch updated', 'ok');
      } else {
        toast('Edit submitted for review', 'ok', 'Branch keeps operating with current info until approved');
      }
      if (window.STATE && window.STATE.view === 'branches') setView('branches');
    } catch (e) {
      toast('Branch edit error: ' + e.message, 'err');
    }
  };

  // Team member manage → PATCH /employees/{id}
  window.saveMemberManage = async function () {
    const memberId = window.STATE && window.STATE._managingMember;
    if (!memberId) { toast('No member selected', 'err'); return; }
    const displayRole = (document.querySelector('#mgrRole') || {}).value || null;
    // Collect permission checkboxes (id^="perm:")
    const perms = [];
    document.querySelectorAll('input[type="checkbox"][id^="perm:"]:checked').forEach(cb => {
      perms.push(cb.id.replace(/^perm:/, ''));
    });
    try {
      await mApi('/api/v1/merchant/employees/' + memberId, {
        method: 'PATCH',
        body: {
          display_role: displayRole,
          permissions: perms.length ? perms : null,
        },
      });
      closeAll();
      toast('Member updated', 'ok');
    } catch (e) {
      toast('Member update error: ' + e.message, 'err');
    }
  };

  // Cash sale → POST /transactions/cash
  window.submitCash = async function () {
    const amt = parseFloat((readVal('cashAmt') || '').replace(/,/g, ''));
    if (!amt || amt <= 0) { toast('Enter an amount', 'warn'); return; }
    const cust = readVal('cashCust') || 'Walk-in';
    const phone = readVal('cashPhone') || null;
    const branchName = readVal('cashBranch') || null;
    const note = readVal('cashNote') || null;
    let branchId = null;
    if (branchName && Array.isArray(window.BRANCHES)) {
      const b = window.BRANCHES.find(x => x.name === branchName);
      if (b) branchId = b.id;
    }
    try {
      const r = await mApi('/api/v1/merchant/transactions/cash', {
        method: 'POST',
        body: { amount: amt, customer_name: cust, customer_phone: phone, branch_id: branchId, note },
      });
      closeAll();
      toast('Cash sale recorded · GHS ' + amt.toFixed(2), 'ok', cust);
      if (window.mHydrate) window.mHydrate();
    } catch (e) {
      toast('Cash sale error: ' + e.message, 'err');
    }
  };

  // Top-up → POST /transactions/topup
  window.submitTopUp = async function () {
    const amt = parseFloat((readVal('topupAmount') || '').replace(/,/g, ''));
    if (!amt || amt <= 0) { toast('Enter an amount', 'warn'); return; }
    const source = readVal('topupSource') || 'bank';
    const target = readVal('topupTarget') || 'wallet';
    try {
      await mApi('/api/v1/merchant/transactions/topup', {
        method: 'POST',
        body: { amount: amt, source, target },
      });
      closeAll();
      toast('Top-up confirmed · GHS ' + amt.toFixed(2), 'ok', source + ' → ' + target);
      if (window.mHydrate) window.mHydrate();
    } catch (e) {
      toast('Top-up error: ' + e.message, 'err');
    }
  };

  // Check-in → POST /checkins
  window.submitCheckin = async function () {
    const date = readVal('ckDate');
    const time = readVal('ckTime');
    const duration = readVal('ckDuration') || '30 min';
    const type = readVal('ckType') || 'video';
    const topic = readVal('ckTopic') || 'General check-in';
    if (!date || !time) { toast('Pick a date and time', 'warn'); return; }
    try {
      await mApi('/api/v1/merchant/checkins', {
        method: 'POST',
        body: { date, time, duration, type, topic },
      });
      closeAll();
      toast('Check-in requested · ' + date + ' ' + time, 'ok', topic + ' · ' + duration);
    } catch (e) {
      toast('Check-in error: ' + e.message, 'err');
    }
  };

  // USSD config save → PATCH /ussd-config
  window.saveUssdConfig = async function () {
    const next = {};
    let errors = 0;
    document.querySelectorAll('#ussdBody .ussd-row').forEach(row => {
      const branch = row.getAttribute('data-branch');
      const inp = row.querySelector('.ussd-input');
      if (!inp) return;
      const v = (inp.value || '').trim();
      if (!v) return;
      if (typeof window.checkUssd === 'function') {
        const r = window.checkUssd(v);
        if (!r.ok) { errors++; return; }
      }
      next[branch] = v;
    });
    if (errors) { toast(errors + ' branch(es) have invalid USSD', 'warn'); return; }
    try {
      await mApi('/api/v1/merchant/ussd-config', {
        method: 'PATCH',
        body: { ussd_by_branch: next },
      });
      if (window.STATE) window.STATE.ussdByBranch = next;
      if (Array.isArray(window.BRANCHES)) {
        window.BRANCHES.forEach(b => {
          if (next[b.name]) b.ussd = next[b.name]; else delete b.ussd;
        });
      }
      toast('USSD settings saved', 'ok');
    } catch (e) {
      toast('USSD error: ' + e.message, 'err');
    }
  };

  // Setup hint dismiss → PATCH /settings/setup-state
  window.dismissSetup = async function () {
    try {
      await mApi('/api/v1/merchant/settings/setup-state', {
        method: 'PATCH',
        body: { dismissed: true },
      });
      if (window.SETUP_STATE) window.SETUP_STATE.dismissed = true;
      if (window.setView) setView('overview');
      toast('Setup hidden — find it again in the Help tab', 'info');
    } catch (e) {
      // Fail silent — UI state is OK; user can retry
      if (window.SETUP_STATE) window.SETUP_STATE.dismissed = true;
      if (window.setView) setView('overview');
    }
  };

  // KYC extra slot → POST /kyc/extras
  window.submitAddExtra = async function () {
    const cat = readVal('addExtraCategory') || 'misc';
    const name = readVal('addExtraName') || (cat + ' document');
    try {
      const r = await mApi('/api/v1/merchant/kyc/extras', {
        method: 'POST',
        body: { category: cat, name },
      });
      if (Array.isArray(window.KYC_EXTRA)) {
        window.KYC_EXTRA.push({ key: r.key, name: r.name, category: r.category, files: [] });
      }
      closeAll();
      if (typeof window.rerenderKyc === 'function') window.rerenderKyc();
      toast('Document slot added', 'ok', 'Now upload the files');
    } catch (e) {
      toast('Add document failed: ' + e.message, 'err');
    }
  };

  // ---- Phase 4f: repopulate Transfer modal branches from live data ----
  function _ppRepopulateXferBranches() {
    const branches = Array.isArray(window.BRANCHES) ? window.BRANCHES : [];
    if (branches.length === 0) return;
    const sel = document.getElementById('xferSrcBranch');
    if (sel) {
      const prev = sel.value;
      sel.innerHTML = branches.map(b => `<option>${b.name}</option>`).join('');
      if (branches.some(b => b.name === prev)) sel.value = prev;
    }
    const sweepList = document.querySelector('#xferSweepWrap .sweep-list');
    if (sweepList) {
      const fmtAmt = (typeof window.fmt === 'function') ? window.fmt : (v) => 'GHS ' + Number(v).toFixed(2);
      sweepList.innerHTML = branches.slice(0, 12).map(b => {
        const avail = Number(b.revenue || 0) * 0.18;
        return `
          <label class="sweep-row">
            <div style="flex:1; min-width:0">
              <b style="font-size:13px">${b.name}</b>
              <div class="muted" style="font-size:11.5px">Avail. ${fmtAmt(avail)}</div>
            </div>
            <label class="switch"><input type="checkbox" /><i></i></label>
            <label class="switch-all" title="Send all funds from this branch"><input type="checkbox" /><span>All funds</span></label>
          </label>`;
      }).join('');
    }
  }

  // NOTE: Overriding window.prepareTransferModal does NOT intercept calls the
  // inline openModal() makes — those use the lexical (inline) binding.
  // Reliable fix: hook window.openModal (which IS invoked from HTML onclick
  // via the global lookup) and repopulate after the inline handler runs.
  const _origOpenModal = window.openModal;
  window.openModal = function (id) {
    if (typeof _origOpenModal === 'function') _origOpenModal(id);
    const branches = Array.isArray(window.BRANCHES) ? window.BRANCHES : [];
    if (branches.length === 0) return;
    if (id === 'cashModal') {
      const sel = document.getElementById('cashBranch');
      if (sel) {
        const prev = sel.value;
        sel.innerHTML = branches.map(b => `<option>${b.name}</option>`).join('');
        if (branches.some(b => b.name === prev)) sel.value = prev;
      }
    } else if (id === 'transferModal') {
      // Defer to next tick so the inline prepareTransferModal/renderXferDestForm
      // have already inserted their content into the DOM.
      setTimeout(_ppRepopulateXferBranches, 0);
    }
  };

  // Dispute slideover "Issue refund" button — POSTs a refund linked to the
  // currently-open dispute so the dispute flips to status=refunded.
  window.submitDisputeRefund = async function () {
    const d = (window.STATE && window.STATE._activeDispute) || null;
    if (!d || !d.api_id) {
      toast('Open a dispute first', 'warn');
      return;
    }
    const amt = Number(d.amount || 0) || 0;
    try {
      const r = await mApi('/api/v1/merchant/refunds', {
        method: 'POST',
        body: { dispute_id: d.api_id, amount: amt, reason: 'Refund issued via Disputes' },
      });
      closeAll();
      toast('Refund issued · GHS ' + amt.toFixed(2), 'ok', r.dispute_case_ref || '');
      if (window.mHydrate) await window.mHydrate();
      if (typeof window.setView === 'function') window.setView('disputes');
    } catch (e) {
      toast('Refund error: ' + e.message, 'err');
    }
  };

  // Patch openDispute(d) so STATE._activeDispute is set when the dispute
  // slideover opens — that's what submitDisputeRefund reads to know which
  // dispute to refund.
  if (window.STATE) window.STATE._activeDispute = null;
  const _origOpenDispute = window.openDispute;
  if (typeof _origOpenDispute === 'function') {
    window.openDispute = function (d) {
      if (window.STATE) window.STATE._activeDispute = d;
      return _origOpenDispute(d);
    };
  }

  // Force navigation to the Transactions page after a cash sale + force
  // hydrate so the freshly-recorded transaction is immediately visible.
  window.submitCash = async function () {
    const amt = parseFloat((readVal('cashAmt') || '').replace(/,/g, ''));
    if (!amt || amt <= 0) { toast('Enter an amount', 'warn'); return; }
    const cust = readVal('cashCust') || 'Walk-in';
    const phone = readVal('cashPhone') || null;
    const branchName = readVal('cashBranch') || null;
    const note = readVal('cashNote') || null;
    let branchId = null;
    if (branchName && Array.isArray(window.BRANCHES)) {
      const b = window.BRANCHES.find(x => x.name === branchName);
      if (b) branchId = b.id;
    }
    try {
      await mApi('/api/v1/merchant/transactions/cash', {
        method: 'POST',
        body: { amount: amt, customer_name: cust, customer_phone: phone, branch_id: branchId, note },
      });
      closeAll();
      toast('Cash sale recorded · GHS ' + amt.toFixed(2), 'ok', cust);
      // Pull fresh data, THEN switch to the Transactions page so the new tx is
      // already in the TX array when the view renders.
      if (window.mHydrate) await window.mHydrate();
      if (typeof window.setView === 'function') window.setView('transactions');
    } catch (e) {
      toast('Cash sale error: ' + e.message, 'err');
    }
  };

  console.log('[PepaPay merchant-v2] bridge + phase 4 + 4b + 4c + 4f + 4g loaded');
})();
