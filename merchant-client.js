/*
 * merchant-client.js — PepaPay Merchant Dashboard (Stage 6-7).
 *
 *   - OTP-based login (Stage 5)
 *   - 8 sidebar tabs: Overview / Transactions / Transfers / CRM / Employees /
 *     Branches / Services / USSD / KYC / Support
 *   - Mobile view (?mobile=1 or width < 700px): "Receive Payment" big CTA
 *   - Talks to /api/v1/merchant/* (nginx proxies through to backend:8001)
 */

(function () {
  'use strict';

  const LS_TOKEN   = 'pp_merchant_token';
  const LS_PROFILE = 'pp_merchant_profile';

  // -------- HTTP helpers ----------------------------------------------------

  async function api(path, opts) {
    opts = opts || {};
    const tok = localStorage.getItem(LS_TOKEN);
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
      opts.body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    const r = await fetch(path, Object.assign({}, opts, { headers }));
    let body;
    try { body = await r.json(); } catch { body = null; }
    if (!r.ok) {
      const msg = (body && (body.message || body.detail)) || ('HTTP ' + r.status);
      const err = new Error(msg);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtMoney(n) { return 'GH₵ ' + Number(n).toLocaleString('en-GH', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleString() : '—'; }
  function fmtDateShort(iso) { return iso ? new Date(iso).toLocaleString('en-GH', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'; }

  function toast(msg, isError) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.style.background = isError ? '#DC2626' : '#111827';
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 3500);
  }

  // -------- Login flow (Stage 5) -------------------------------------------

  let pendingIdentifier = null;

  window.requestOtp = async function () {
    const identifier = document.getElementById('identifier').value.trim();
    if (!identifier) { toast('Enter an email or phone', true); return; }
    const isEmail = identifier.includes('@');
    pendingIdentifier = identifier;
    try {
      const r = await api('/api/v1/merchant/auth/request-otp', {
        method: 'POST',
        body: { identifier, identifier_type: isEmail ? 'email' : 'phone' },
      });
      document.getElementById('step-identifier').style.display = 'none';
      document.getElementById('step-otp').style.display = 'block';
      document.getElementById('otp-target').textContent = identifier;
      if (r.demo_code) {
        document.getElementById('otp-demo-hint').style.display = 'block';
        document.getElementById('otp-demo-code').textContent = r.demo_code;
      }
      toast('Code sent (5 minutes validity)');
    } catch (e) {
      toast('Failed: ' + e.message, true);
    }
  };

  window.verifyOtp = async function () {
    const code = document.getElementById('otp-code').value.trim();
    if (!code) { toast('Enter the code', true); return; }
    try {
      const r = await api('/api/v1/merchant/auth/verify-otp', {
        method: 'POST',
        body: { identifier: pendingIdentifier, code },
      });
      localStorage.setItem(LS_TOKEN, r.access_token);
      localStorage.setItem(LS_PROFILE, JSON.stringify(r));
      await bootApp();
    } catch (e) {
      toast('Login failed: ' + e.message, true);
    }
  };

  window.backToIdentifier = function () {
    document.getElementById('step-otp').style.display = 'none';
    document.getElementById('step-identifier').style.display = 'block';
    document.getElementById('otp-code').value = '';
    document.getElementById('otp-demo-hint').style.display = 'none';
  };

  window.logout = function () {
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_PROFILE);
    location.reload();
  };

  // -------- App boot --------------------------------------------------------

  async function bootApp() {
    let me;
    try {
      me = await api('/api/v1/merchant/me');
    } catch (e) {
      localStorage.removeItem(LS_TOKEN);
      return showLogin();
    }
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-screen').classList.add('active');
    document.getElementById('who-name').textContent = me.full_name + ' (' + me.role + ')';
    document.getElementById('who-biz').textContent = me.merchant.mid + ' · ' + me.merchant.status;

    _renderStatusBanner(me);

    // Mobile mode (Stage 7)
    const params = new URLSearchParams(location.search);
    if (params.get('mobile') === '1' || params.get('view') === 'mobile' || location.pathname.indexOf('/mobile') === 0 || window.innerWidth < 700) {
      document.body.classList.add('mobile');
    }

    // Wire sidebar
    document.querySelectorAll('.nav-item').forEach(item => {
      item.onclick = () => switchTab(item.dataset.tab);
    });

    // Initial tab
    switchTab(params.get('tab') || 'overview');
  }

  function showLogin() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-screen').classList.remove('active');
  }

  // ---- Status banner (Approved / Monitoring / Pending Setup / etc.) -------

  function _renderStatusBanner(me) {
    const main = document.querySelector('.main');
    if (!main) return;
    const prior = document.getElementById('pp-status-banner');
    if (prior) prior.remove();

    const status = me.merchant.status;
    const tier = me.merchant.tier || '';
    const mid = me.merchant.mid;
    const mobile = me.merchant.mobile_app_enabled;

    // status → (label, sublabel, bg, fg, border, icon)
    const config = ({
      active: {
        label: '✓ Approved Merchant',
        sub:   `${tier.toUpperCase()} · Live · Mobile App ${mobile ? 'enabled' : 'disabled'}`,
        bg: '#DCFCE7', fg: '#166534', border: '#22C55E',
      },
      pending_setup: {
        label: '⏳ Pending Setup',
        sub:   `${tier.toUpperCase()} · Operations is configuring your account — limited features until activation.`,
        bg: '#FEF3C7', fg: '#92400E', border: '#F59E0B',
      },
      suspended: {
        label: '⛔ Account Suspended',
        sub:   'Contact your Account Manager to resolve.',
        bg: '#FEE2E2', fg: '#991B1B', border: '#EF4444',
      },
      closed: {
        label: '✗ Account Closed',
        sub:   'This account is no longer active.',
        bg: '#FEE2E2', fg: '#991B1B', border: '#EF4444',
      },
    })[status] || {
      label: status, sub: '', bg: '#E5E7EB', fg: '#374151', border: '#9CA3AF',
    };

    const banner = document.createElement('div');
    banner.id = 'pp-status-banner';
    banner.style.cssText = `background:${config.bg};color:${config.fg};border-left:4px solid ${config.border};`
      + 'padding:12px 16px;border-radius:8px;margin-bottom:18px;display:flex;'
      + 'justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;';
    banner.innerHTML = `
      <div>
        <div style="font-size:14px;font-weight:700;">${config.label}</div>
        <div style="font-size:12px;margin-top:2px;opacity:0.85;">${config.sub}</div>
      </div>
      <div style="font-family:ui-monospace,monospace;font-size:12px;opacity:0.75;">${escapeHtml(mid)}</div>
    `;
    main.insertBefore(banner, main.firstChild);

    // If this session was started by an internal admin via the cross-portal
    // "Open Merchant View" button, surface a clear impersonation banner —
    // the presenter (and any future operator) should never be confused
    // about whose data they're looking at.
    const impBy = sessionStorage.getItem('pp_imp_by');
    if (impBy) {
      const imp = document.createElement('div');
      imp.id = 'pp-imp-banner';
      imp.style.cssText = 'background:#7C3AED;color:white;padding:8px 16px;'
        + 'border-radius:6px;margin-bottom:12px;font-size:12px;display:flex;'
        + 'justify-content:space-between;align-items:center;gap:12px;';
      imp.innerHTML = `
        <div>
          <strong>👁 Internal admin session.</strong>
          You're viewing this merchant's dashboard as the Owner.
          Logged in by <code style="background:rgba(255,255,255,0.18);padding:1px 6px;border-radius:3px;">${escapeHtml(impBy)}</code> (audit-logged).
        </div>
        <button onclick="logout()" style="background:white;color:#5B21B6;border:0;padding:5px 12px;border-radius:5px;font-weight:600;font-size:11px;cursor:pointer;">End session</button>
      `;
      main.insertBefore(imp, main.firstChild);
    }
  }

  // -------- Tab routing -----------------------------------------------------

  const renderers = {
    overview:     renderOverview,
    transactions: renderTransactions,
    transfers:    renderTransfers,
    crm:          renderCrm,
    employees:    renderEmployees,
    branches:     renderBranches,
    services:     renderServices,
    ussd:         renderUssd,
    kyc:          renderKyc,
    support:      renderSupport,
  };

  const tabTitles = {
    overview:     ['Overview', 'Your business at a glance'],
    transactions: ['Transactions', 'Every payment received'],
    transfers:    ['Transfers', 'Move money out (bank / momo / Pepapay)'],
    crm:          ['Customers', 'Captured at first payment — loyalty per merchant rules'],
    employees:    ['Employees & Access', 'Owner invites staff and assigns roles'],
    branches:     ['Branches', 'Request new branches (Operations approves)'],
    services:     ['Services', 'Turn services on/off (reflected on Internal Dashboard)'],
    ussd:         ['USSD Codes', 'Unique prefix+extension from the central pool'],
    kyc:          ['KYC', 'Re-uploads validated by Operations, then reviewed by Compliance'],
    support:      ['Support', 'Tickets handled by the internal Support team'],
  };

  window.switchTab = function (tab) {
    if (!renderers[tab]) return;
    document.querySelectorAll('.nav-item').forEach(n =>
      n.classList.toggle('active', n.dataset.tab === tab)
    );
    const sel = document.getElementById('mobile-tab');
    if (sel && sel.value !== tab) sel.value = tab;
    const [title, sub] = tabTitles[tab];
    document.getElementById('page-title').textContent = title;
    document.getElementById('page-sub').textContent = sub;
    document.getElementById('page-actions').innerHTML = '';
    document.getElementById('page-content').innerHTML =
      '<div class="empty">Loading…</div>';
    renderers[tab]();
  };

  // ==========================================================================
  // OVERVIEW
  // ==========================================================================

  async function renderOverview() {
    try {
      const [txs, custs, branches, tickets, kyc] = await Promise.all([
        api('/api/v1/merchant/transactions?limit=200'),
        api('/api/v1/merchant/customers'),
        api('/api/v1/merchant/branches'),
        api('/api/v1/merchant/support/tickets'),
        api('/api/v1/merchant/kyc/uploads'),
      ]);
      const successTxs = txs.items.filter(t => t.status === 'success' && t.kind === 'payment');
      const today = new Date(); today.setHours(0,0,0,0);
      const todayTxs = successTxs.filter(t => new Date(t.created_at) >= today);
      const todayAmt = todayTxs.reduce((a, t) => a + t.amount, 0);
      const pendingBranches = branches.filter(b => b.status === 'pending_approval').length;
      const openTickets = tickets.filter(t => t.status !== 'resolved' && t.status !== 'closed').length;
      const pendingKyc = kyc.filter(k => k.status !== 'approved' && k.status !== 'rejected').length;

      const recent = txs.items.slice(0, 6).map(t => `
        <tr>
          <td>${fmtDateShort(t.created_at)}</td>
          <td>${escapeHtml(t.customer_name || t.customer_phone || '—')}</td>
          <td><span class="pill pill-info">${escapeHtml(t.channel)}</span></td>
          <td style="text-align:right;font-weight:600;">${fmtMoney(t.amount)}</td>
          <td><span class="pill pill-ok">${escapeHtml(t.status)}</span></td>
        </tr>`).join('');

      document.getElementById('page-content').innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="lbl">Today</div><div class="val">${fmtMoney(todayAmt)}</div><div class="sub">${todayTxs.length} payments</div></div>
          <div class="stat"><div class="lbl">Lifetime collected</div><div class="val">${fmtMoney(txs.total_amount)}</div><div class="sub">${successTxs.length} successful</div></div>
          <div class="stat"><div class="lbl">Customers</div><div class="val">${custs.length}</div><div class="sub">in CRM</div></div>
          <div class="stat"><div class="lbl">Open tickets</div><div class="val">${openTickets}</div><div class="sub">Support team</div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Recent Transactions</h3><a href="#" onclick="switchTab('transactions');return false;" style="font-size:12px;color:var(--brand-2);text-decoration:none;">View all →</a></div>
          <table><thead><tr><th>When</th><th>Customer</th><th>Channel</th><th style="text-align:right;">Amount</th><th>Status</th></tr></thead><tbody>${recent || '<tr><td colspan="5" class="empty">No transactions yet</td></tr>'}</tbody></table>
        </div>
        ${pendingBranches || pendingKyc ? `
          <div class="card">
            <div class="card-head"><h3>Awaiting Internal Review</h3></div>
            <div class="card-body">
              ${pendingBranches ? `<div style="margin-bottom:10px;">🏢 <strong>${pendingBranches}</strong> branch request${pendingBranches === 1 ? '' : 's'} pending Operations approval</div>` : ''}
              ${pendingKyc ? `<div>📄 <strong>${pendingKyc}</strong> KYC document${pendingKyc === 1 ? '' : 's'} in review (Ops → Compliance)</div>` : ''}
            </div>
          </div>` : ''}
      `;
    } catch (e) {
      document.getElementById('page-content').innerHTML = `<div class="empty">Failed to load: ${e.message}</div>`;
    }
  }

  // ==========================================================================
  // TRANSACTIONS
  // ==========================================================================

  async function renderTransactions() {
    document.getElementById('page-actions').innerHTML =
      `<button class="btn btn-primary" onclick="openReceivePaymentModal()">+ Receive Payment</button>`;
    try {
      const r = await api('/api/v1/merchant/transactions?limit=100');
      const rows = r.items.map(t => `
        <tr>
          <td>${fmtDateShort(t.created_at)}</td>
          <td><code>${escapeHtml(t.id.slice(0,8))}</code></td>
          <td><span class="pill ${t.kind === 'payment' ? 'pill-ok' : 'pill-info'}">${escapeHtml(t.kind)}</span></td>
          <td>${escapeHtml(t.customer_name || t.customer_phone || '—')}</td>
          <td><span class="pill pill-neutral">${escapeHtml(t.channel)}</span></td>
          <td style="text-align:right;font-weight:600;color:${t.kind === 'payment' ? 'var(--ok)' : 'var(--ink)'};">${t.kind === 'payment' ? '+' : '-'} ${fmtMoney(t.amount)}</td>
          <td><span class="pill ${t.status === 'success' ? 'pill-ok' : 'pill-warn'}">${escapeHtml(t.status)}</span></td>
        </tr>`).join('');
      document.getElementById('page-content').innerHTML = `
        <div class="card"><div class="card-head"><h3>${r.items.length} transactions · Total collected: ${fmtMoney(r.total_amount)}</h3></div>
          <table><thead><tr><th>When</th><th>ID</th><th>Kind</th><th>Customer</th><th>Channel</th><th style="text-align:right;">Amount</th><th>Status</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="empty">No transactions</td></tr>'}</tbody></table></div>`;
    } catch (e) {
      document.getElementById('page-content').innerHTML = `<div class="empty">Failed: ${e.message}</div>`;
    }
  }

  window.openReceivePaymentModal = function () {
    const html = `
      <div class="modal-bg" id="rx-modal">
        <div class="modal">
          <h3>Receive Payment (in-person)</h3>
          <div class="body">
            <label>Amount (GHS)</label>
            <input id="rx-amount" type="number" min="0.01" step="0.01" placeholder="50.00" />
            <label>Customer phone (optional — auto-creates CRM record)</label>
            <input id="rx-phone" placeholder="+233 24 ..." />
            <label>Customer name (optional)</label>
            <input id="rx-name" placeholder="Kweku Mensah" />
            <label>Description</label>
            <input id="rx-desc" placeholder="In-store purchase" />
          </div>
          <div class="actions">
            <button class="btn" onclick="document.getElementById('rx-modal').remove()">Cancel</button>
            <button class="btn btn-success" onclick="submitReceivePayment()">Collect</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };

  window.submitReceivePayment = async function () {
    const amount = parseFloat(document.getElementById('rx-amount').value);
    if (!amount || amount <= 0) { toast('Enter a positive amount', true); return; }
    try {
      const r = await api('/api/v1/merchant/transactions', {
        method: 'POST',
        body: {
          amount,
          customer_phone: document.getElementById('rx-phone').value.trim() || null,
          customer_name:  document.getElementById('rx-name').value.trim() || null,
          description:    document.getElementById('rx-desc').value.trim() || null,
          channel: document.body.classList.contains('mobile') ? 'mobile_app' : 'pos',
        },
      });
      document.getElementById('rx-modal').remove();
      toast(`Payment received · ${fmtMoney(r.amount)} · synced to Internal Dashboard`);
      const tab = document.querySelector('.nav-item.active');
      switchTab((tab && tab.dataset.tab) || 'transactions');
    } catch (e) {
      toast('Failed: ' + e.message, true);
    }
  };

  // ==========================================================================
  // TRANSFERS
  // ==========================================================================

  async function renderTransfers() {
    document.getElementById('page-actions').innerHTML =
      `<button class="btn btn-primary" onclick="openTransferModal()">+ New Transfer</button>`;
    try {
      const r = await api('/api/v1/merchant/transactions?limit=100');
      const transfers = r.items.filter(t => t.kind === 'transfer');
      const rows = transfers.map(t => `
        <tr>
          <td>${fmtDateShort(t.created_at)}</td>
          <td><span class="pill pill-info">${escapeHtml(t.channel)}</span></td>
          <td>${escapeHtml(t.description || '—')}</td>
          <td style="text-align:right;font-weight:600;">${fmtMoney(t.amount)}</td>
          <td><span class="pill pill-ok">${escapeHtml(t.status)}</span></td>
        </tr>`).join('');
      document.getElementById('page-content').innerHTML = `
        <div class="card"><div class="card-head"><h3>${transfers.length} transfers out</h3></div>
          <table><thead><tr><th>When</th><th>Destination</th><th>Description</th><th style="text-align:right;">Amount</th><th>Status</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="empty">No transfers yet</td></tr>'}</tbody></table></div>`;
    } catch (e) {
      document.getElementById('page-content').innerHTML = `<div class="empty">Failed: ${e.message}</div>`;
    }
  }

  window.openTransferModal = function () {
    const html = `
      <div class="modal-bg" id="tr-modal">
        <div class="modal">
          <h3>New Transfer</h3>
          <div class="body">
            <label>Destination</label>
            <select id="tr-dest">
              <option value="bank">Bank account</option>
              <option value="momo">Mobile Money</option>
              <option value="pepapay">Another Pepapay customer</option>
              <option value="branch">Another branch</option>
            </select>
            <label>Reference / number</label>
            <input id="tr-ref" placeholder="ECO-1234567 / 024xxxxxxx / @handle" />
            <label>Amount (GHS)</label>
            <input id="tr-amount" type="number" min="0.01" step="0.01" />
            <label>Description</label>
            <input id="tr-desc" />
          </div>
          <div class="actions">
            <button class="btn" onclick="document.getElementById('tr-modal').remove()">Cancel</button>
            <button class="btn btn-primary" onclick="submitTransfer()">Send</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };

  window.submitTransfer = async function () {
    const dest = document.getElementById('tr-dest').value;
    const ref = document.getElementById('tr-ref').value.trim();
    const amt = parseFloat(document.getElementById('tr-amount').value);
    const desc = document.getElementById('tr-desc').value.trim();
    if (!ref || !amt) { toast('Fill ref + amount', true); return; }
    try {
      await api('/api/v1/merchant/transfers', {
        method: 'POST',
        body: { amount: amt, destination_kind: dest, destination_ref: ref, description: desc || null },
      });
      document.getElementById('tr-modal').remove();
      toast('Transfer sent · ' + fmtMoney(amt));
      switchTab('transfers');
    } catch (e) {
      toast('Failed: ' + e.message, true);
    }
  };

  // ==========================================================================
  // CRM / Customers
  // ==========================================================================

  async function renderCrm() {
    try {
      const r = await api('/api/v1/merchant/customers');
      const rows = r.map(c => `
        <tr>
          <td><div style="font-weight:600;">${escapeHtml(c.name || '—')}</div><div style="font-size:11px;color:var(--ink-soft);">${escapeHtml(c.phone || c.email || '')}</div></td>
          <td style="text-align:right;font-weight:600;">${fmtMoney(c.total_paid)}</td>
          <td style="text-align:center;">${c.payment_count}</td>
          <td style="text-align:center;"><span class="pill pill-warn">⭐ ${c.loyalty_points} pts</span></td>
          <td style="font-size:12px;">${fmtDateShort(c.last_seen_at)}</td>
        </tr>`).join('');
      document.getElementById('page-content').innerHTML = `
        <div class="card"><div class="card-head"><h3>${r.length} customers · Captured automatically at first payment</h3></div>
          <table><thead><tr><th>Customer</th><th style="text-align:right;">Total Paid</th><th style="text-align:center;">Visits</th><th style="text-align:center;">Loyalty</th><th>Last seen</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="empty">No customers yet — collect a payment to start your CRM</td></tr>'}</tbody></table></div>`;
    } catch (e) {
      document.getElementById('page-content').innerHTML = `<div class="empty">Failed: ${e.message}</div>`;
    }
  }

  // ==========================================================================
  // EMPLOYEES
  // ==========================================================================

  async function renderEmployees() {
    const me = JSON.parse(localStorage.getItem(LS_PROFILE) || '{}');
    if (me.role === 'owner') {
      document.getElementById('page-actions').innerHTML =
        `<button class="btn btn-primary" onclick="openInviteEmployeeModal()">+ Invite Employee</button>`;
    }
    try {
      const r = await api('/api/v1/merchant/employees');
      const rows = r.map(e => `
        <tr>
          <td><div style="font-weight:600;">${escapeHtml(e.full_name)}</div><div style="font-size:11px;color:var(--ink-soft);">${escapeHtml(e.email || e.phone || '')}</div></td>
          <td><span class="pill ${e.role === 'owner' ? 'pill-warn' : 'pill-neutral'}">${escapeHtml(e.role)}</span></td>
          <td><span class="pill ${e.status === 'active' ? 'pill-ok' : 'pill-bad'}">${escapeHtml(e.status)}</span></td>
          <td style="font-size:12px;">${e.last_login_at ? fmtDateShort(e.last_login_at) : 'Never'}</td>
        </tr>`).join('');
      document.getElementById('page-content').innerHTML = `
        <div class="card"><div class="card-head"><h3>${r.length} team members</h3></div>
          <table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last login</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`;
    } catch (e) {
      document.getElementById('page-content').innerHTML = `<div class="empty">Failed: ${e.message}</div>`;
    }
  }

  window.openInviteEmployeeModal = function () {
    const html = `
      <div class="modal-bg" id="inv-modal">
        <div class="modal">
          <h3>Invite Employee</h3>
          <div class="body">
            <label>Full name</label><input id="inv-name" />
            <label>Email</label><input id="inv-email" type="email" />
            <label>Phone (optional)</label><input id="inv-phone" />
            <div style="font-size:11.5px;color:var(--ink-soft);margin-top:10px;">
              They'll sign in with OTP using either email or phone.
            </div>
          </div>
          <div class="actions">
            <button class="btn" onclick="document.getElementById('inv-modal').remove()">Cancel</button>
            <button class="btn btn-primary" onclick="submitInviteEmployee()">Invite</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };

  window.submitInviteEmployee = async function () {
    const full_name = document.getElementById('inv-name').value.trim();
    const email = document.getElementById('inv-email').value.trim() || null;
    const phone = document.getElementById('inv-phone').value.trim() || null;
    if (!full_name || (!email && !phone)) { toast('Name + email or phone', true); return; }
    try {
      await api('/api/v1/merchant/employees', { method: 'POST', body: { full_name, email, phone } });
      document.getElementById('inv-modal').remove();
      toast('Employee invited');
      switchTab('employees');
    } catch (e) {
      toast('Failed: ' + e.message, true);
    }
  };

  // ==========================================================================
  // BRANCHES
  // ==========================================================================

  async function renderBranches() {
    document.getElementById('page-actions').innerHTML =
      `<button class="btn btn-primary" onclick="openBranchRequestModal()">+ Request Branch</button>`;
    try {
      const r = await api('/api/v1/merchant/branches');
      const rows = r.map(b => {
        const pillClass = b.status === 'active' ? 'pill-ok'
                        : b.status === 'rejected' ? 'pill-bad' : 'pill-warn';
        return `<tr>
          <td><div style="font-weight:600;">${escapeHtml(b.name)}</div><div style="font-size:11px;color:var(--ink-soft);">${escapeHtml(b.address || '')}</div></td>
          <td>${escapeHtml(b.city || '')} ${escapeHtml(b.region || '')}</td>
          <td><span class="pill ${pillClass}">${escapeHtml(b.status.replace('_', ' '))}</span></td>
          <td style="font-size:12px;">${fmtDateShort(b.created_at)}</td>
        </tr>`;
      }).join('');
      document.getElementById('page-content').innerHTML = `
        <div class="card"><div class="card-head"><h3>${r.length} branches</h3>
          <span style="font-size:11.5px;color:var(--ink-soft);">New branches require Operations approval</span></div>
          <table><thead><tr><th>Branch</th><th>Location</th><th>Status</th><th>Requested</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="empty">No branches yet</td></tr>'}</tbody></table></div>`;
    } catch (e) {
      document.getElementById('page-content').innerHTML = `<div class="empty">Failed: ${e.message}</div>`;
    }
  }

  window.openBranchRequestModal = function () {
    const html = `
      <div class="modal-bg" id="br-modal">
        <div class="modal">
          <h3>Request New Branch</h3>
          <div class="body">
            <label>Branch name</label><input id="br-name" placeholder="Main Branch - Kumasi" />
            <label>Address</label><input id="br-addr" />
            <label>City</label><input id="br-city" />
            <label>Region</label><input id="br-region" placeholder="Ashanti" />
            <label>Contact phone</label><input id="br-phone" />
            <div style="font-size:11.5px;color:var(--warn);margin-top:10px;">
              ⚠ Branch requests go to Operations for approval before becoming active.
            </div>
          </div>
          <div class="actions">
            <button class="btn" onclick="document.getElementById('br-modal').remove()">Cancel</button>
            <button class="btn btn-primary" onclick="submitBranchRequest()">Submit Request</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };

  window.submitBranchRequest = async function () {
    const body = {
      name:    document.getElementById('br-name').value.trim(),
      address: document.getElementById('br-addr').value.trim() || null,
      city:    document.getElementById('br-city').value.trim() || null,
      region:  document.getElementById('br-region').value.trim() || null,
      contact_phone: document.getElementById('br-phone').value.trim() || null,
    };
    if (!body.name) { toast('Branch name required', true); return; }
    try {
      await api('/api/v1/merchant/branches', { method: 'POST', body });
      document.getElementById('br-modal').remove();
      toast('Branch request submitted · Operations will review');
      switchTab('branches');
    } catch (e) { toast('Failed: ' + e.message, true); }
  };

  // ==========================================================================
  // SERVICES
  // ==========================================================================

  async function renderServices() {
    try {
      const r = await api('/api/v1/merchant/services');
      const rows = r.map(s => `
        <tr>
          <td><div style="font-weight:600;">${escapeHtml(s.name)}</div><div style="font-size:11px;color:var(--ink-soft);"><code>${escapeHtml(s.code)}</code></div></td>
          <td><span class="pill ${s.enabled ? 'pill-ok' : 'pill-neutral'}">${s.enabled ? '✓ Enabled' : 'Disabled'}</span></td>
          <td style="font-size:12px;">${fmtDateShort(s.enabled_at)}</td>
          <td style="text-align:right;">
            <button class="btn ${s.enabled ? 'btn-ghost' : 'btn-success'}" onclick="toggleService('${s.id}', ${!s.enabled})">${s.enabled ? 'Disable' : 'Enable'}</button>
          </td>
        </tr>`).join('');
      document.getElementById('page-content').innerHTML = `
        <div class="card"><div class="card-head"><h3>${r.length} services</h3>
          <span style="font-size:11.5px;color:var(--ink-soft);">Toggle anytime — no approval required (reflected on Internal Dashboard)</span></div>
          <table><thead><tr><th>Service</th><th>Status</th><th>Last toggled</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>`;
    } catch (e) {
      document.getElementById('page-content').innerHTML = `<div class="empty">Failed: ${e.message}</div>`;
    }
  }

  window.toggleService = async function (id, enable) {
    try {
      await api('/api/v1/merchant/services/' + id, { method: 'PATCH', body: { enabled: enable } });
      toast(enable ? 'Service enabled' : 'Service disabled');
      switchTab('services');
    } catch (e) { toast('Failed: ' + e.message, true); }
  };

  // ==========================================================================
  // USSD
  // ==========================================================================

  async function renderUssd() {
    document.getElementById('page-actions').innerHTML =
      `<button class="btn btn-primary" onclick="requestUssdCode()">+ Request USSD Code</button>`;
    try {
      const r = await api('/api/v1/merchant/ussd-codes');
      const rows = r.map(u => `
        <tr>
          <td><code style="font-size:14px;color:var(--brand);font-weight:700;">${escapeHtml(u.display_code)}</code></td>
          <td style="font-size:12px;">${fmtDateShort(u.assigned_at)}</td>
        </tr>`).join('');
      document.getElementById('page-content').innerHTML = `
        <div class="card"><div class="card-head"><h3>${r.length} USSD code${r.length === 1 ? '' : 's'}</h3>
          <span style="font-size:11.5px;color:var(--ink-soft);">Each code is unique platform-wide — pulled from PepaCash's central pool</span></div>
          <table><thead><tr><th>Code</th><th>Assigned</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="2" class="empty">No USSD codes — request one for in-store payments</td></tr>'}</tbody></table></div>`;
    } catch (e) {
      document.getElementById('page-content').innerHTML = `<div class="empty">Failed: ${e.message}</div>`;
    }
  }

  window.requestUssdCode = async function () {
    try {
      const r = await api('/api/v1/merchant/ussd-codes/request', { method: 'POST', body: {} });
      toast('Assigned: ' + r.display_code);
      switchTab('ussd');
    } catch (e) { toast('Failed: ' + e.message, true); }
  };

  // ==========================================================================
  // KYC
  // ==========================================================================

  async function renderKyc() {
    document.getElementById('page-actions').innerHTML =
      `<button class="btn btn-primary" onclick="openKycUploadModal()">+ Upload KYC Document</button>`;
    try {
      const r = await api('/api/v1/merchant/kyc/uploads');
      const rows = r.map(k => {
        const pillClass = k.status === 'approved' ? 'pill-ok'
                        : k.status === 'rejected' ? 'pill-bad'
                        : k.status === 'forwarded_to_compliance' ? 'pill-info'
                        : 'pill-warn';
        return `<tr>
          <td>${escapeHtml(k.doc_type)}</td>
          <td>${escapeHtml(k.file_name)}</td>
          <td><span class="pill ${pillClass}">${escapeHtml(k.status.replace('_', ' '))}</span></td>
          <td style="font-size:12px;">${fmtDateShort(k.created_at)}</td>
          <td style="font-size:11.5px;color:var(--ink-soft);">${k.validated_at ? '✓ Ops validated ' + fmtDateShort(k.validated_at) : 'Awaiting Operations'}</td>
        </tr>`;
      }).join('');
      document.getElementById('page-content').innerHTML = `
        <div class="card">
          <div class="card-head"><h3>${r.length} uploads</h3>
            <span style="font-size:11.5px;color:var(--warn);">⚠ KYC always goes Operations → Compliance — never direct to Compliance</span></div>
          <table><thead><tr><th>Doc type</th><th>File</th><th>Status</th><th>Uploaded</th><th>Validation</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="empty">No KYC uploads</td></tr>'}</tbody></table></div>`;
    } catch (e) {
      document.getElementById('page-content').innerHTML = `<div class="empty">Failed: ${e.message}</div>`;
    }
  }

  window.openKycUploadModal = function () {
    const html = `
      <div class="modal-bg" id="kyc-modal">
        <div class="modal">
          <h3>Upload KYC Document</h3>
          <div class="body">
            <label>Document type</label>
            <select id="kyc-type">
              <option value="bank_letter">Bank Letter</option>
              <option value="tin">TIN Certificate</option>
              <option value="director_id">Director ID</option>
              <option value="tax_clearance">Tax Clearance</option>
              <option value="other">Other</option>
            </select>
            <label>File</label><input id="kyc-file" type="file" />
            <label>Notes (optional)</label><textarea id="kyc-notes" rows="2"></textarea>
            <div style="font-size:11.5px;color:var(--warn);margin-top:10px;">
              Upload lands in the Operations queue first. Your Account Manager validates it, then forwards to Compliance.
            </div>
          </div>
          <div class="actions">
            <button class="btn" onclick="document.getElementById('kyc-modal').remove()">Cancel</button>
            <button class="btn btn-primary" onclick="submitKycUpload()">Upload</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };

  window.submitKycUpload = async function () {
    const fileInput = document.getElementById('kyc-file');
    const f = fileInput.files[0];
    if (!f) { toast('Pick a file', true); return; }
    const fd = new FormData();
    fd.append('file', f);
    fd.append('doc_type', document.getElementById('kyc-type').value);
    const notes = document.getElementById('kyc-notes').value.trim();
    if (notes) fd.append('notes', notes);
    try {
      const tok = localStorage.getItem(LS_TOKEN);
      const r = await fetch('/api/v1/merchant/kyc/upload', {
        method: 'POST', body: fd, headers: { 'Authorization': 'Bearer ' + tok },
      });
      if (!r.ok) { const b = await r.json().catch(()=>({})); throw new Error(b.message || 'HTTP ' + r.status); }
      document.getElementById('kyc-modal').remove();
      toast('Uploaded · waiting on Operations validation');
      switchTab('kyc');
    } catch (e) { toast('Failed: ' + e.message, true); }
  };

  // ==========================================================================
  // SUPPORT
  // ==========================================================================

  async function renderSupport() {
    document.getElementById('page-actions').innerHTML =
      `<button class="btn btn-primary" onclick="openTicketModal()">+ Open Ticket</button>`;
    try {
      const r = await api('/api/v1/merchant/support/tickets');
      const rows = r.map(t => {
        const pillClass = t.status === 'resolved' || t.status === 'closed' ? 'pill-ok'
                        : t.status === 'awaiting_merchant' ? 'pill-warn'
                        : 'pill-info';
        return `<tr style="cursor:pointer;" onclick="openTicketDetail('${t.id}')">
          <td><div style="font-weight:600;">${escapeHtml(t.subject)}</div><div style="font-size:11px;color:var(--ink-soft);">${escapeHtml(t.category || '')}</div></td>
          <td><span class="pill pill-neutral">${escapeHtml(t.priority)}</span></td>
          <td><span class="pill ${pillClass}">${escapeHtml(t.status.replace('_', ' '))}</span></td>
          <td style="font-size:12px;">${escapeHtml(t.assigned_to_name || 'Unassigned')}</td>
          <td style="font-size:12px;">${fmtDateShort(t.updated_at)}</td>
        </tr>`;
      }).join('');
      document.getElementById('page-content').innerHTML = `
        <div class="card"><div class="card-head"><h3>${r.length} tickets</h3></div>
          <table><thead><tr><th>Subject</th><th>Priority</th><th>Status</th><th>Assigned</th><th>Updated</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="empty">No tickets — open one if you need help</td></tr>'}</tbody></table></div>`;
    } catch (e) {
      document.getElementById('page-content').innerHTML = `<div class="empty">Failed: ${e.message}</div>`;
    }
  }

  window.openTicketModal = function () {
    const html = `
      <div class="modal-bg" id="tk-modal">
        <div class="modal">
          <h3>Open Support Ticket</h3>
          <div class="body">
            <label>Subject</label><input id="tk-subj" />
            <label>Category</label>
            <select id="tk-cat">
              <option value="billing">Billing / Settlement</option>
              <option value="technical">Technical</option>
              <option value="kyc">KYC / Compliance</option>
              <option value="other">Other</option>
            </select>
            <label>Priority</label>
            <select id="tk-pri">
              <option value="normal">Normal</option>
              <option value="low">Low</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
            <label>Describe the issue</label><textarea id="tk-body" rows="5"></textarea>
          </div>
          <div class="actions">
            <button class="btn" onclick="document.getElementById('tk-modal').remove()">Cancel</button>
            <button class="btn btn-primary" onclick="submitTicket()">Open Ticket</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };

  window.submitTicket = async function () {
    const body = {
      subject:  document.getElementById('tk-subj').value.trim(),
      category: document.getElementById('tk-cat').value,
      priority: document.getElementById('tk-pri').value,
      body:     document.getElementById('tk-body').value.trim(),
    };
    if (!body.subject || !body.body) { toast('Subject + body required', true); return; }
    try {
      await api('/api/v1/merchant/support/tickets', { method: 'POST', body });
      document.getElementById('tk-modal').remove();
      toast('Ticket opened · Support team notified');
      switchTab('support');
    } catch (e) { toast('Failed: ' + e.message, true); }
  };

  window.openTicketDetail = async function (id) {
    try {
      const t = await api('/api/v1/merchant/support/tickets/' + id);
      const msgs = t.messages.map(m => `
        <div style="padding:12px;border-radius:8px;margin:6px 0;background:${m.author_kind === 'merchant' ? '#EFF6FF' : '#F0FDF4'};">
          <div style="font-size:11px;font-weight:600;color:${m.author_kind === 'merchant' ? '#1E40AF' : '#166534'};margin-bottom:4px;">
            ${m.author_kind === 'merchant' ? 'You' : 'Support team'} · ${fmtDateShort(m.created_at)}
          </div>
          <div style="font-size:13px;white-space:pre-wrap;">${escapeHtml(m.body)}</div>
        </div>`).join('');
      const html = `
        <div class="modal-bg" id="td-modal">
          <div class="modal" style="max-width:640px;">
            <h3>${escapeHtml(t.subject)} <span class="pill pill-neutral" style="font-size:10px;margin-left:6px;">${escapeHtml(t.status)}</span></h3>
            <div class="body" style="max-height:60vh;overflow-y:auto;">
              ${msgs}
              <label>Your reply</label>
              <textarea id="td-reply" rows="3"></textarea>
            </div>
            <div class="actions">
              <button class="btn" onclick="document.getElementById('td-modal').remove()">Close</button>
              <button class="btn btn-primary" onclick="replyTicket('${t.id}')">Send reply</button>
            </div>
          </div>
        </div>`;
      document.body.insertAdjacentHTML('beforeend', html);
    } catch (e) { toast('Failed: ' + e.message, true); }
  };

  window.replyTicket = async function (id) {
    const body = document.getElementById('td-reply').value.trim();
    if (!body) { toast('Type your reply', true); return; }
    try {
      await api('/api/v1/merchant/support/tickets/' + id + '/messages', {
        method: 'POST', body: { body },
      });
      document.getElementById('td-modal').remove();
      toast('Reply sent');
      switchTab('support');
    } catch (e) { toast('Failed: ' + e.message, true); }
  };

  // -------- Boot ------------------------------------------------------------

  // SSO via internal admin: if URL has ?session_token=XXX, swap it into
  // localStorage and boot the app directly (skips OTP login). Clean the URL.
  (function _acceptCrossPortalSso() {
    const params = new URLSearchParams(location.search);
    const tok = params.get('session_token');
    if (!tok) return;
    localStorage.setItem(LS_TOKEN, tok);
    // Mark this session as impersonated so the dashboard shows a banner.
    const impBy = params.get('imp_by');
    if (impBy) sessionStorage.setItem('pp_imp_by', impBy);
    else       sessionStorage.removeItem('pp_imp_by');
    // Strip the secrets from the address bar.
    params.delete('session_token');
    params.delete('imp_by');
    const newUrl = location.pathname + (params.toString() ? '?' + params.toString() : '');
    history.replaceState({}, '', newUrl);
  })();

  if (localStorage.getItem(LS_TOKEN)) {
    bootApp();
  } else {
    showLogin();
  }
})();
