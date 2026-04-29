// ── utils.js — shared UI helpers ─────────────────────────────────────────────
// Consumed by items.html, npcs.html, loot.html, admin.html (and any future page).
// Load with <script src="utils.js"></script> before the inline page script.

/**
 * Returns an <img> tag string for a WoW icon.
 * @param {string} iconUrl     - Primary src URL (may be falsy/empty).
 * @param {string} fallbackUrl - onerror fallback src; if omitted the img is hidden on error.
 * @param {string} altText     - alt attribute text (default: empty string).
 */
function iconImg(iconUrl, fallbackUrl, altText) {
    if (!iconUrl) return fallbackUrl ? `<span>${fallbackUrl}</span>` : '';
    const alt = altText || '';
    const onerror = fallbackUrl
        ? `this.onerror=null;this.src='${fallbackUrl}'`
        : `this.style.display='none'`;
    return `<img class="wow-icon" src="${iconUrl}" onerror="${onerror}" alt="${alt}">`;
}

/**
 * Formats a number with locale-aware thousands separators.
 * @param {number|string} n
 */
function fmt(n) {
    return Number(n).toLocaleString();
}

/**
 * Capitalizes the first character of a string.
 * @param {string} s
 */
function cap(s) {
    if (!s) return '';
    return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

/**
 * Returns the CSS class name for a WoW item quality integer (0–6).
 * Maps to the q0–q6 classes defined in epochdb.css.
 * @param {number} qualityInt
 */
function qualityColor(qualityInt) {
    const QUALITY_CLASSES = ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
    return QUALITY_CLASSES[qualityInt] || 'q0';
}

/**
 * Normalizes a raw NPC type string to a canonical badge key.
 * @param {string} t - Raw type from DB (e.g. 'worldboss', 'RareElite', …)
 * @returns {'boss'|'elite'|'rare'|'normal'}
 */
function normType(t) {
    if (!t) return 'normal';
    const s = t.toLowerCase();
    if (s === 'worldboss' || s === 'boss') return 'boss';
    if (s === 'rareelite') return 'rare';
    if (s === 'elite') return 'elite';
    if (s === 'rare') return 'rare';
    return 'normal';
}

/**
 * Returns a badge <span> for an NPC type string.
 * @param {string} npcType - Raw NPC type value from the DB.
 */
function badgeHtml(npcType) {
    const n = normType(npcType);
    const label = n === 'boss' ? 'Boss' : n === 'elite' ? 'Elite' : n === 'rare' ? 'Rare' : 'Normal';
    return `<span class="badge badge-${n}">${label}</span>`;
}

/**
 * HTML-escapes a value for safe insertion into innerHTML.
 * Escapes &, <, >, ", and '.
 * @param {*} s - Value to escape (coerced to string; null/undefined → '').
 */
function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
