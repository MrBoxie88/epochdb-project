const API_BASE = '';

/**
 * Core fetch wrapper.
 * - Prepends API_BASE to every path.
 * - Throws a descriptive Error on any non-2xx response (includes status + body).
 * - Always returns parsed JSON.
 * - Logs the failing endpoint to the console for easier debugging.
 *
 * @param {string} path     - Relative path, e.g. '/api/list/npcs'
 * @param {object} [options] - Standard fetch options (method, headers, body, …)
 * @returns {Promise<any>}  - Parsed JSON response body
 */
async function apiFetch(path, options = {}) {
    const url = API_BASE + path;
    let res;
    try {
        res = await fetch(url, options);
    } catch (networkErr) {
        console.error('[api] network error —', path, networkErr);
        throw networkErr;
    }
    if (!res.ok) {
        let detail = '';
        try { const body = await res.json(); detail = body.error || JSON.stringify(body); } catch {}
        const err = new Error(`${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
        err.status = res.status;
        console.error('[api] request failed —', path, err.message);
        throw err;
    }
    return res.json();
}

// ── List page helpers ──────────────────────────────────────────────────────

function listNpcs()     { return apiFetch('/api/list/npcs'); }
function listItems()    { return apiFetch('/api/list/items'); }
function listLoot()     { return apiFetch('/api/list/loot'); }
function listVendors()  { return apiFetch('/api/list/vendors'); }
function listQuests()   { return apiFetch('/api/list/quests'); }

// ── Item detail helpers ────────────────────────────────────────────────────

function getItemRecord(id)   { return apiFetch(`/api/record/items/${encodeURIComponent(id)}`); }
function getItemSources(name){ return apiFetch(`/api/item-sources/${encodeURIComponent(name)}`); }
function getItemComments(id) { return apiFetch(`/api/comments/items/${encodeURIComponent(id)}`); }

/**
 * Post a comment on an item.
 * @param {string} id    - Item record id
 * @param {string} text  - Comment body
 * @param {string} token - JWT bearer token for the current user
 */
function postItemComment(id, text, token) {
    return apiFetch(`/api/comments/items/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ text }),
    });
}

// ── Admin helpers ──────────────────────────────────────────────────────────
// Each admin helper accepts an authHeaders() result so the call site
// constructs auth headers exactly as before.

function adminLogin(email, password) {
    return apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, captchaToken: '' }),
    });
}

/**
 * @param {number} page
 * @param {string} q      - search query
 * @param {string} type   - record type filter
 * @param {object} headers - authHeaders() result
 */
function adminRecords(page, q, type, headers) {
    const qs = new URLSearchParams({ q, type, page });
    return apiFetch('/api/admin/records?' + qs, { headers });
}

/**
 * @param {number} page
 * @param {string} type     - comment type filter
 * @param {string} recordId - record id filter
 * @param {object} headers  - authHeaders() result
 */
function adminComments(page, type, recordId, headers) {
    const qs = new URLSearchParams({ type, recordId, page });
    return apiFetch('/api/admin/comments?' + qs, { headers });
}

/**
 * @param {string} type    - record type, e.g. 'npcs'
 * @param {string} id      - record id
 * @param {object} headers - authHeaders() result
 */
function deleteRecord(type, id, headers) {
    return apiFetch(`/api/admin/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers,
    });
}

/**
 * @param {string} id      - comment _id
 * @param {object} headers - authHeaders() result
 */
function deleteComment(id, headers) {
    return apiFetch(`/api/admin/comments/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers,
    });
}

/**
 * @param {string} type    - comment collection type, e.g. 'items'
 * @param {string} rid     - record id
 * @param {string} text    - comment body
 * @param {string} cls     - player class
 * @param {object} headers - authHeaders() result
 */
function adminPostComment(type, rid, text, cls, headers) {
    return apiFetch(`/api/comments/${type}/${rid}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, cls }),
    });
}

/**
 * @param {string} email   - user email to verify
 * @param {object} headers - authHeaders() result
 */
function verifyUser(email, headers) {
    return apiFetch('/api/admin/verify-user', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email }),
    });
}

// ── Talent damage API helpers ──────────────────────────────────────────────

function fetchRogueDamage(payload) {
    return apiFetch('/api/rogue-damage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

function fetchMageDamage(payload) {
    return apiFetch('/api/mage-damage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

function fetchWarriorDamage(payload) {
    return apiFetch('/api/warrior-damage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

function fetchWarlockDamage(payload) {
    return apiFetch('/api/warlock-damage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}
