// ==UserScript==
// @name         CZK Price Tooltip Converter
// @namespace    https://github.com/local-tampermonkey
// @version      2.0.0
// @description  Zobrazuje ceny v CZK při najetí myší na částky v cizích měnách (USD, EUR, GBP, PLN, JPY a další) podle aktuálního kurzu ČNB
// @author       Lukáš
// @match        http://*/*
// @match        https://*/*
// @updateURL    https://raw.githubusercontent.com/lukasvac/userscripts/main/src/czk-price-tooltip-converter.user.js
// @downloadURL  https://raw.githubusercontent.com/lukasvac/userscripts/main/src/czk-price-tooltip-converter.user.js
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      www.cnb.cz
// @connect      cnb.cz
// ==/UserScript==

(function () {
    'use strict';

    const CACHE_KEY = 'cnb_rates_v2';
    const CACHE_DATE_KEY = 'cnb_rates_date_v2';
    const CACHE_DATE_STR_KEY = 'cnb_rates_date_str_v2';
    const TOOLTIP_ID = 'tm-czk-price-tooltip';
    const STYLE_TAG_ID = 'tm-czk-converter-styles';
    const HOVER_DELAY_MS = 180;

    // Hardcoded fallback rates if ČNB is temporarily offline or unreachable
    const FALLBACK_RATES = {
        EUR: 24.36,
        USD: 22.45,
        GBP: 28.95,
        PLN: 5.53,
        JPY: 0.13875,
        CHF: 26.50,
        CAD: 15.61,
        AUD: 15.32,
        CNY: 3.28,
        HUF: 0.0665,
        SEK: 2.22,
        NOK: 2.36,
        DKK: 3.26
    };

    const CURRENCY_MAP = {
        '$': 'USD',
        'US$': 'USD',
        'USD': 'USD',
        '€': 'EUR',
        'EUR': 'EUR',
        '£': 'GBP',
        'GBP': 'GBP',
        'ZŁ': 'PLN',
        'PLN': 'PLN',
        '¥': 'JPY',
        'JPY': 'JPY',
        '円': 'JPY',
        'C$': 'CAD',
        'CAD': 'CAD',
        'CA$': 'CAD',
        'A$': 'AUD',
        'AUD': 'AUD',
        'AU$': 'AUD',
        'CHF': 'CHF',
        'FR.': 'CHF',
        'SFR.': 'CHF',
        'CNY': 'CNY',
        'RMB': 'CNY',
        'HUF': 'HUF',
        'FT': 'HUF',
        'SEK': 'SEK',
        'NOK': 'NOK',
        'DKK': 'DKK'
    };

    // Regex patterns for matching prices with currency before or after the number
    const PATTERNS = [
        /(?:^|[^\w$€£¥zł円])(US\s*\$|CA\s*\$|AU\s*\$|C\$|A\$|USD|EUR|GBP|PLN|JPY|CAD|AUD|CHF|CNY|RMB|HUF|SEK|NOK|DKK|zł|円|[$€£¥])\s*([0-9]{1,3}(?:[.,\s][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)(?!\w)/i,
        /(?:^|[^\w$€£¥zł円])([0-9]{1,3}(?:[.,\s][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)\s*(US\s*\$|CA\s*\$|AU\s*\$|C\$|A\$|USD|EUR|GBP|PLN|JPY|CAD|AUD|CHF|CNY|RMB|HUF|SEK|NOK|DKK|zł|円|Ft|[$€£¥])(?!\w)/i
    ];

    let currentRates = FALLBACK_RATES;
    let rateDateString = '';
    let hoverTimer = null;
    let tooltipEl = null;
    let activePrice = null;
    let currentPriceElement = null;

    // Cache parsed DOM elements to prevent redundant regex executions
    const elementPriceCache = new WeakMap();

    /**
     * Formats number in CZK currency.
     * @param {number} value
     * @returns {string}
     */
    function formatCZK(value) {
        return Math.round(value).toLocaleString('cs-CZ') + ' Kč';
    }

    /**
     * Cleans localized number string and returns a float.
     * Handles combinations of dots, commas, spaces, and thousands separators.
     * @param {string} str
     * @returns {number}
     */
    function cleanNumber(str) {
        str = str.trim().replace(/\s/g, '');
        const firstDot = str.indexOf('.');
        const firstComma = str.indexOf(',');

        if (firstDot !== -1 && firstComma !== -1) {
            if (firstDot < firstComma) {
                // E.g., 1.234,56 -> dot is thousands, comma is decimal
                str = str.replace(/\./g, '').replace(',', '.');
            } else {
                // E.g., 1,234.56 -> comma is thousands, dot is decimal
                str = str.replace(/,/g, '');
            }
        } else if (firstComma !== -1) {
            const parts = str.split(',');
            if (parts.length > 2) {
                str = str.replace(/,/g, '');
            } else if (parts[1].length === 2 || parts[1].length === 1) {
                str = str.replace(',', '.');
            } else if (parts[1].length === 3 && parts[0].length <= 3) {
                str = str.replace(/,/g, '');
            } else {
                str = str.replace(',', '.');
            }
        } else if (firstDot !== -1) {
            const parts = str.split('.');
            if (parts.length > 2) {
                str = str.replace(/\./g, '');
            }
        }

        return parseFloat(str);
    }

    /**
     * Extracts currency and numeric price amount from raw text.
     * @param {string} text
     * @returns {{ currency: string, amount: number, rawSymbol: string } | null}
     */
    function extractPrice(text) {
        if (!text || typeof text !== 'string') return null;
        if (text.includes('Kč') || text.includes('CZK')) return null;

        const normalized = text.replace(/[\u00a0\u2000-\u200b\u202f]/g, ' ');

        let match = normalized.match(PATTERNS[0]);
        if (match) {
            const sym = match[1].replace(/\s+/g, '').toUpperCase();
            const curr = CURRENCY_MAP[sym] || sym;
            const amount = cleanNumber(match[2]);
            if (!isNaN(amount) && amount > 0 && amount < 100000000) {
                return { currency: curr, amount, rawSymbol: match[1].trim() };
            }
        }

        match = normalized.match(PATTERNS[1]);
        if (match) {
            const sym = match[2].replace(/\s+/g, '').toUpperCase();
            const curr = CURRENCY_MAP[sym] || sym;
            const amount = cleanNumber(match[1]);
            if (!isNaN(amount) && amount > 0 && amount < 100000000) {
                return { currency: curr, amount, rawSymbol: match[2].trim() };
            }
        }

        return null;
    }

    /**
     * Searches for a valid price by inspecting the hovered element and its immediate ancestors.
     * Resolves split price elements (e.g., Amazon, Temu, AliExpress).
     * @param {Element} startEl
     * @returns {{ price: { currency: string, amount: number, rawSymbol: string }, el: Element } | null}
     */
    function findPriceFromElement(startEl) {
        if (!startEl || startEl === document.body || startEl === document.documentElement) return null;

        if (elementPriceCache.has(startEl)) {
            const cached = elementPriceCache.get(startEl);
            return cached ? { price: cached, el: startEl } : null;
        }

        let current = startEl;
        let depth = 0;

        while (current && current !== document.body && depth < 5) {
            // Check aria-label first
            const ariaLabel = current.getAttribute && current.getAttribute('aria-label');
            if (ariaLabel && ariaLabel.length < 120) {
                const price = extractPrice(ariaLabel);
                if (price) {
                    elementPriceCache.set(startEl, price);
                    return { price, el: current };
                }
            }

            // Check innerText or textContent (limit length to prevent overhead on large containers)
            const text = current.innerText || current.textContent || '';
            if (text && text.length <= 150) {
                const price = extractPrice(text);
                if (price) {
                    elementPriceCache.set(startEl, price);
                    return { price, el: current };
                }
            }

            current = current.parentElement;
            depth++;
        }

        elementPriceCache.set(startEl, null);
        return null;
    }

    /**
     * Parses the ČNB daily exchange rate fixing plain text format.
     * Format: Country|Currency|Amount|Code|Rate
     * @param {string} text
     * @returns {{ rates: Record<string, number>, dateStr: string }}
     */
    function parseCNB(text) {
        const rates = {};
        const lines = text.split(/\r?\n/);
        let dateStr = '';

        if (lines.length > 0 && lines[0].includes('#')) {
            dateStr = lines[0].split('#')[0].trim();
        }

        for (const line of lines) {
            const parts = line.split('|');
            if (parts.length < 5) continue;

            const amount = parseFloat(parts[2].trim());
            const code = parts[3].trim().toUpperCase();
            const rate = parseFloat(parts[4].trim().replace(',', '.'));

            if (!isNaN(amount) && amount > 0 && !isNaN(rate) && code) {
                rates[code] = rate / amount;
            }
        }

        return { rates, dateStr };
    }

    /**
     * Fetches current exchange rates from the Czech National Bank.
     */
    function loadRates() {
        const todayStr = new Date().toISOString().slice(0, 10);
        const cachedDate = GM_getValue(CACHE_DATE_KEY);
        const cachedRates = GM_getValue(CACHE_KEY);

        if (cachedDate === todayStr && cachedRates && typeof cachedRates === 'object' && Object.keys(cachedRates).length > 5) {
            currentRates = cachedRates;
            rateDateString = GM_getValue(CACHE_DATE_STR_KEY, '');
            return;
        }

        const cnbUrl = 'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt';

        GM_xmlhttpRequest({
            method: 'GET',
            url: cnbUrl,
            timeout: 10000,
            onload(response) {
                try {
                    if (response.status === 200 && response.responseText) {
                        const parsed = parseCNB(response.responseText);
                        if (parsed.rates && Object.keys(parsed.rates).length > 5) {
                            currentRates = parsed.rates;
                            rateDateString = parsed.dateStr;
                            GM_setValue(CACHE_KEY, currentRates);
                            GM_setValue(CACHE_DATE_KEY, todayStr);
                            GM_setValue(CACHE_DATE_STR_KEY, rateDateString);
                            return;
                        }
                    }
                } catch (e) {
                    // Fallback to existing or hardcoded rates
                }

                if (cachedRates) {
                    currentRates = cachedRates;
                    rateDateString = GM_getValue(CACHE_DATE_STR_KEY, '');
                }
            },
            onerror() {
                if (cachedRates) {
                    currentRates = cachedRates;
                    rateDateString = GM_getValue(CACHE_DATE_STR_KEY, '');
                }
            }
        });
    }

    /**
     * Injects dark theme styling for the tooltip.
     */
    function injectStyles() {
        if (document.getElementById(STYLE_TAG_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_TAG_ID;
        style.textContent = `
            #${TOOLTIP_ID} {
                all: initial;
                position: fixed !important;
                z-index: 2147483647 !important;
                pointer-events: none !important;
                display: none;
                opacity: 0;
                transition: opacity 0.12s ease-out;
                background: #181a1f !important;
                color: #e6edf3 !important;
                border: 1px solid rgba(255, 255, 255, 0.18) !important;
                border-radius: 6px !important;
                padding: 8px 12px !important;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45) !important;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
                font-size: 13px !important;
                line-height: 1.35 !important;
                box-sizing: border-box !important;
                max-width: 280px !important;
                user-select: none !important;
            }
            #${TOOLTIP_ID}.tm-visible {
                opacity: 1 !important;
            }
            #${TOOLTIP_ID} .tm-czk-row-primary {
                display: block;
                font-size: 15px !important;
                font-weight: 700 !important;
                color: #ffffff !important;
                margin-bottom: 2px !important;
                letter-spacing: -0.01em !important;
            }
            #${TOOLTIP_ID} .tm-czk-row-sub {
                display: block;
                font-size: 12px !important;
                color: #8b949e !important;
                margin-bottom: 4px !important;
            }
            #${TOOLTIP_ID} .tm-czk-row-meta {
                display: flex;
                justify-content: space-between;
                gap: 8px;
                font-size: 10px !important;
                color: #6e7681 !important;
                border-top: 1px solid rgba(255, 255, 255, 0.1) !important;
                padding-top: 4px !important;
            }
        `;

        (document.head || document.documentElement).appendChild(style);
    }

    /**
     * Ensures tooltip element exists in DOM.
     * @returns {HTMLElement}
     */
    function getOrCreateTooltip() {
        if (tooltipEl && document.body.contains(tooltipEl)) {
            return tooltipEl;
        }

        let el = document.getElementById(TOOLTIP_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOOLTIP_ID;
            document.body.appendChild(el);
        }

        tooltipEl = el;
        return tooltipEl;
    }

    /**
     * Updates position of tooltip ensuring it stays inside the viewport.
     * @param {number} clientX
     * @param {number} clientY
     */
    function updateTooltipPosition(clientX, clientY) {
        if (!tooltipEl || tooltipEl.style.display !== 'block') return;

        const offset = 14;
        const width = tooltipEl.offsetWidth || 180;
        const height = tooltipEl.offsetHeight || 60;
        const winWidth = window.innerWidth;
        const winHeight = window.innerHeight;

        let left = clientX + offset;
        let top = clientY + offset;

        if (left + width + 8 > winWidth) {
            left = clientX - width - 8;
        }

        if (top + height + 8 > winHeight) {
            top = clientY - height - 8;
        }

        if (left < 6) left = 6;
        if (top < 6) top = 6;

        tooltipEl.style.left = left + 'px';
        tooltipEl.style.top = top + 'px';
    }

    /**
     * Shows tooltip with converted CZK price.
     * @param {number} clientX
     * @param {number} clientY
     * @param {{ currency: string, amount: number, rawSymbol: string }} price
     */
    function showTooltip(clientX, clientY, price) {
        const rate = currentRates[price.currency];
        if (!rate || isNaN(rate)) return;

        const convertedCZK = price.amount * rate;
        const tooltip = getOrCreateTooltip();

        const formattedAmount = price.amount.toLocaleString('cs-CZ', {
            minimumFractionDigits: Number.isInteger(price.amount) ? 0 : 2,
            maximumFractionDigits: 2
        });

        const rateFormatted = (rate >= 1) ? rate.toFixed(2) : rate.toFixed(4);
        const metaDate = rateDateString ? ` (${rateDateString})` : '';

        tooltip.innerHTML = `
            <span class="tm-czk-row-primary">≈ ${formatCZK(convertedCZK)}</span>
            <span class="tm-czk-row-sub">${formattedAmount} ${price.currency}</span>
            <span class="tm-czk-row-meta">
                <span>ČNB: 1 ${price.currency} = ${rateFormatted} Kč</span>
                <span>${metaDate}</span>
            </span>
        `;

        tooltip.style.display = 'block';
        updateTooltipPosition(clientX, clientY);

        requestAnimationFrame(() => {
            tooltip.classList.add('tm-visible');
        });
    }

    /**
     * Hides tooltip.
     */
    function hideTooltip() {
        if (tooltipEl) {
            tooltipEl.classList.remove('tm-visible');
            tooltipEl.style.display = 'none';
        }
        activePrice = null;
        currentPriceElement = null;
    }

    /**
     * Initializes event listeners.
     */
    function init() {
        injectStyles();
        loadRates();

        document.addEventListener('mouseover', (e) => {
            const target = e.target;
            if (!target || target === document.body || target === document.documentElement) return;
            if (target.id === TOOLTIP_ID || (tooltipEl && tooltipEl.contains(target))) return;

            // If still hovering within the same price container, maintain tooltip
            if (currentPriceElement && currentPriceElement.contains(target)) {
                return;
            }

            const match = findPriceFromElement(target);
            if (!match) {
                clearTimeout(hoverTimer);
                hideTooltip();
                return;
            }

            clearTimeout(hoverTimer);
            currentPriceElement = match.el;
            activePrice = match.price;

            hoverTimer = setTimeout(() => {
                if (activePrice) {
                    showTooltip(e.clientX, e.clientY, activePrice);
                }
            }, HOVER_DELAY_MS);
        }, { passive: true });

        document.addEventListener('mousemove', (e) => {
            if (tooltipEl && tooltipEl.style.display === 'block') {
                updateTooltipPosition(e.clientX, e.clientY);
            }
        }, { passive: true });

        document.addEventListener('mouseout', (e) => {
            const related = e.relatedTarget;
            // If leaving window or leaving the active price element container
            if (!related || (currentPriceElement && !currentPriceElement.contains(related))) {
                clearTimeout(hoverTimer);
                hideTooltip();
            }
        }, { passive: true });

        window.addEventListener('scroll', () => {
            hideTooltip();
        }, { passive: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
