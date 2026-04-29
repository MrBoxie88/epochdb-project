class EpochList {
    /**
     * @param {object}   opts
     * @param {Array}    opts.allData       - Full record array loaded from the API.
     * @param {Element}  opts.containerEl   - <tbody> that receives rendered <tr> strings.
     * @param {Element}  opts.paginatorEl   - Element that receives the paginator HTML.
     * @param {Element}  opts.countEl       - Element whose textContent shows "(N results)".
     * @param {Function} opts.filterFn      - (record, filters, searchQ) => boolean
     * @param {Function} opts.sortFn        - (a, b, sortKey) => number
     * @param {Function} opts.renderRowFn   - (record) => HTML string for one <tr>
     * @param {string}   opts.emptyMessage  - Message shown when no rows match.
     * @param {number}   [opts.pageSize=50] - Initial rows per page.
     * @param {string}   [opts.sortKey='']  - Initial sort key.
     * @param {number}   [opts.colSpan=5]   - colspan for the empty-state row.
     */
    constructor(opts) {
        this._all      = opts.allData      || [];
        this._tbody    = opts.containerEl;
        this._pagEl    = opts.paginatorEl;
        this._countEl  = opts.countEl;
        this._filterFn = opts.filterFn;
        this._sortFn   = opts.sortFn;
        this._rowFn    = opts.renderRowFn;
        this._empty    = opts.emptyMessage || 'No results found.';
        this._colSpan  = opts.colSpan  || 5;

        this._filtered = [];
        this._page     = 1;
        this._pageSize = opts.pageSize || 50;
        this._sortKey  = opts.sortKey  || '';
        this._searchQ  = '';
        this._filters  = {};
    }

    // Public API

    /** Replace the full dataset and re-render from page 1. */
    load(data) {
        this._all  = data;
        this._page = 1;
        this.refresh();
    }

    setSearch(val) {
        this._searchQ = val.toLowerCase();
        this._page    = 1;
        this.refresh();
    }

    /**
     * Set a named filter value.  Passing '' removes that filter key.
     * Also updates the active highlight on all .fp-item[data-field] elements.
     */
    setFilter(field, val) {
        document.querySelectorAll('.fp-item[data-field="' + field + '"]')
            .forEach(e => e.classList.remove('active'));

        if (val === '') {
            delete this._filters[field];
        } else {
            this._filters[field] = isNaN(val) ? val : Number(val);
        }
        this._page = 1;
        this.refresh();
    }

    setSort(key) {
        if (!key) return;
        this._sortKey = key;
        const sel = document.getElementById('sort-select');
        if (sel) sel.value = key;
        this.refresh();
    }

    setPageSize(n) {
        this._pageSize = n;
        this._page     = 1;
        this.refresh();
    }

    setPage(n) {
        this._page = n;
        this._renderPage();
        window.scrollTo(0, 0);
    }

    /** Re-apply filters + sort and re-render the current page. */
    refresh() {
        this._filtered = this._all.filter(
            r => this._filterFn(r, this._filters, this._searchQ)
        );

        if (this._sortKey) {
            const key = this._sortKey;
            this._filtered.sort((a, b) => this._sortFn(a, b, key));
        }

        if (this._countEl) {
            this._countEl.textContent = '(' + this._filtered.length + ' results)';
        }

        this._renderPage();
    }

    // Private

    _renderPage() {
        const total = Math.ceil(this._filtered.length / this._pageSize) || 1;
        if (this._page > total) this._page = total;
        if (this._page < 1)     this._page = 1;

        const start = (this._page - 1) * this._pageSize;
        const rows  = this._filtered.slice(start, start + this._pageSize);

        this._tbody.innerHTML = rows.length
            ? rows.map(r => this._rowFn(r)).join('')
            : '<tr><td colspan="' + this._colSpan + '" style="text-align:center;padding:2rem;color:var(--text-dim);font-style:italic">' + this._empty + '</td></tr>';

        this._pagEl.innerHTML = this._buildPaginator(start, total);
    }

    _buildPaginator(start, total) {
        if (total <= 1) return '';

        const cur = this._page;
        const end = Math.min(start + this._pageSize, this._filtered.length);
        let h = '<span style="color:var(--text-dim);font-family:\'Share Tech Mono\',monospace;font-size:.7rem;margin-right:8px">' + (start + 1) + '\u2013' + end + ' of ' + this._filtered.length + '</span>';

        h += this._pgBtn('\u00ab', 1,       cur <= 1);
        h += this._pgBtn('\u2039', cur - 1, cur <= 1);

        let ps = Math.max(1, cur - 2);
        let pe = Math.min(total, ps + 4);
        if (pe - ps < 4) ps = Math.max(1, pe - 4);

        if (ps > 1) h += '<span style="color:var(--text-dim);padding:0 4px;font-size:.7rem">\u2026</span>';
        for (let p = ps; p <= pe; p++) {
            h += '<button class="pager-btn' + (p === cur ? ' active' : '') + '" onclick="_epochList.setPage(' + p + ')">' + p + '</button>';
        }
        if (pe < total) h += '<span style="color:var(--text-dim);padding:0 4px;font-size:.7rem">\u2026</span>';

        h += this._pgBtn('\u203a', cur + 1, cur >= total);
        h += this._pgBtn('\u00bb', total,   cur >= total);
        return h;
    }

    _pgBtn(label, page, disabled) {
        return '<button class="pager-btn" onclick="_epochList.setPage(' + page + ')" ' + (disabled ? 'disabled style="opacity:.4;cursor:default"' : '') + '>' + label + '</button>';
    }
}
