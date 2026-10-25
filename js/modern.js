/* ==========================================================================
   Dhanvi Finserv - shared modern UI behaviour
   ========================================================================== */
(function () {
    'use strict';

    var WA_NUMBER = '919925002324';

    function ready(fn) {
        if (document.readyState !== 'loading') { fn(); }
        else { document.addEventListener('DOMContentLoaded', fn); }
    }

    function formatINR(value) {
        return '\u20B9' + Math.round(value).toLocaleString('en-IN');
    }

    function waLink(message) {
        return 'https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(message);
    }

    /* Skip link + main landmark ------------------------------------------- */
    function initSkipLink() {
        var main = document.querySelector('.page-header, .wrapper-content, .slider');
        if (!main || document.querySelector('.skip-link')) { return; }
        if (!main.id) { main.id = 'main-content'; }
        main.setAttribute('tabindex', '-1');
        var link = document.createElement('a');
        link.className = 'skip-link';
        link.href = '#' + main.id;
        link.textContent = 'Skip to content';
        document.body.insertBefore(link, document.body.firstChild);
    }

    /* Floating mobile action bar ----------------------------------------- */
    function initMobileBar() {
        if (document.querySelector('.mobile-action-bar')) { return; }
        var bar = document.createElement('div');
        bar.className = 'mobile-action-bar';
        bar.innerHTML =
            '<a href="tel:+919925002324" aria-label="Call Dhanvi Finserv"><i class="fa fa-phone"></i>Call</a>' +
            '<a class="wa" href="' + waLink('Hi Dhanvi Finserv, I would like to enquire about a loan.') + '" target="_blank" rel="noopener" aria-label="Chat on WhatsApp"><i class="fa fa-whatsapp"></i>WhatsApp</a>' +
            '<a class="apply" href="apply-loan.html" aria-label="Apply for a loan"><i class="fa fa-file-text-o"></i>Apply</a>';
        document.body.appendChild(bar);
    }

    /* Double-click to edit EMI values -------------------------------------- */
    function initEmiValueEditing() {
        var fields = document.querySelectorAll('.emi-field');
        Array.prototype.forEach.call(fields, function (field) {
            var range = field.querySelector('input[type="range"]');
            var label = field.querySelector('label');
            var valueEl = label ? label.querySelector('strong') : null;
            if (!range || !valueEl) { return; }

            var editor = null;

            valueEl.classList.add('emi-value-edit');
            valueEl.setAttribute('title', 'Double-click to edit');

            function closeEditor() {
                if (!editor) { return; }
                var input = editor;
                editor = null;
                if (input.parentNode) { input.parentNode.removeChild(input); }
                valueEl.style.display = '';
            }

            function commitValue() {
                if (!editor) { return; }
                var value = parseFloat(editor.value);
                if (isNaN(value)) { value = parseFloat(range.value); }
                var min = parseFloat(range.getAttribute('min'));
                var max = parseFloat(range.getAttribute('max'));
                value = Math.min(Math.max(value, min), max);
                if (range.classList.contains('emi-rate')) {
                    value = Math.round(value * 100) / 100;
                } else {
                    value = Math.round(value);
                }
                range.value = value;
                range.dispatchEvent(new Event('input', { bubbles: true }));
                closeEditor();
            }

            function openEditor() {
                if (editor) { return; }
                editor = document.createElement('input');
                editor.type = 'number';
                editor.className = 'emi-inline-input';
                editor.min = range.getAttribute('min');
                editor.max = range.getAttribute('max');
                editor.step = range.getAttribute('step');
                editor.value = range.value;
                editor.inputMode = range.classList.contains('emi-rate') ? 'decimal' : 'numeric';
                editor.setAttribute('aria-label', 'Enter value manually');
                valueEl.style.display = 'none';
                valueEl.parentNode.insertBefore(editor, valueEl.nextSibling);
                editor.focus();
                editor.select();

                editor.addEventListener('blur', commitValue);
                editor.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        commitValue();
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        closeEditor();
                    }
                });
            }

            valueEl.addEventListener('dblclick', function (e) {
                e.preventDefault();
                openEditor();
            });
        });
    }

    /* Mini EMI calculator ------------------------------------------------- */
    function initMiniEmi() {
        var boxes = document.querySelectorAll('.mini-emi');
        Array.prototype.forEach.call(boxes, function (box) {
            var amountInput = box.querySelector('.emi-amount');
            var tenureInput = box.querySelector('.emi-tenure');
            var rateInput = box.querySelector('.emi-rate');
            var amountOut = box.querySelector('.emi-amount-out');
            var tenureOut = box.querySelector('.emi-tenure-out');
            var rateOut = box.querySelector('.emi-rate-out');
            var emiOut = box.querySelector('.emi-value');
            var interestOut = box.querySelector('.emi-interest');
            var totalOut = box.querySelector('.emi-total');
            var applyLink = box.querySelector('.emi-apply');
            var loanName = box.getAttribute('data-loan') || 'loan';

            if (!amountInput || !tenureInput || !rateInput) { return; }

            function update() {
                var amount = parseFloat(amountInput.value);
                var years = parseFloat(tenureInput.value);
                var rate = parseFloat(rateInput.value);
                var months = Math.max(1, Math.round(years * 12));
                var monthlyRate = rate / 1200;
                var factor = Math.pow(1 + monthlyRate, months);
                var emi = monthlyRate === 0 ? amount / months : amount * monthlyRate * factor / (factor - 1);
                var total = emi * months;

                amountOut.textContent = formatINR(amount);
                tenureOut.textContent = years + (years === 1 ? ' year' : ' years');
                rateOut.textContent = rate.toFixed(2) + '% p.a.';
                emiOut.textContent = formatINR(emi);
                interestOut.textContent = formatINR(total - amount);
                totalOut.textContent = formatINR(total);

                if (applyLink) {
                    applyLink.href = waLink(
                        'Hi Dhanvi Finserv, I am interested in a ' + loanName + '. ' +
                        'Amount: ' + formatINR(amount) + ', tenure: ' + years + ' years, ' +
                        'indicative rate: ' + rate.toFixed(2) + '% (estimated EMI ' + formatINR(emi) + '). Please guide me.'
                    );
                    applyLink.target = '_blank';
                    applyLink.rel = 'noopener';
                }
            }

            Array.prototype.forEach.call([amountInput, tenureInput, rateInput], function (input) {
                input.addEventListener('input', update);
                input.addEventListener('change', update);
            });
            update();
        });
    }

    /* Documents page tabs -------------------------------------------------- */
    function initDocTabs() {
        var tabs = document.querySelectorAll('.doc-tab');
        if (!tabs.length) { return; }

        function activate(panelId, updateHash) {
            var found = false;
            Array.prototype.forEach.call(tabs, function (tab) {
                var active = tab.getAttribute('data-doc-tab') === panelId;
                tab.classList.toggle('active', active);
                tab.setAttribute('aria-selected', active ? 'true' : 'false');
                if (active) { found = true; }
            });
            if (!found) { return false; }
            Array.prototype.forEach.call(document.querySelectorAll('.doc-panel'), function (panel) {
                panel.classList.toggle('active', panel.id === panelId);
            });
            if (updateHash !== false) {
                var hash = panelId.replace(/^doc-/, '');
                if (window.history && window.history.replaceState) {
                    window.history.replaceState(null, '', '#' + hash);
                }
            }
            return true;
        }

        Array.prototype.forEach.call(tabs, function (tab) {
            tab.addEventListener('click', function () {
                activate(tab.getAttribute('data-doc-tab'));
            });
        });

        var hash = (window.location.hash || '').replace('#', '');
        if (hash) {
            if (!activate('doc-' + hash)) { activate('doc-home', false); }
        }
    }

    /* Documents wizard ----------------------------------------------------- */
    var DOC_DATA = {
        home: {
            label: 'Home Loan',
            common: ['PAN card', 'Aadhaar card', 'Passport-size photographs', 'Address proof'],
            salaried: ['Last 3 months salary slips', 'Last 6 months bank statement', 'Form 16 or latest ITR', 'Employee ID / offer letter'],
            self: ['Last 2-3 years ITR with computation', 'Profit & loss and balance sheet', 'Last 12 months bank statement', 'Business proof (GST / Udyam / registration)'],
            specific: ['Property sale deed or agreement to sell', 'Approved building plan and layout', 'Property tax receipt', 'NOC from society or builder', 'Existing loan statement (for balance transfer)']
        },
        lap: {
            label: 'Loan Against Property',
            common: ['PAN card', 'Aadhaar card', 'Passport-size photographs', 'Address proof'],
            salaried: ['Last 3 months salary slips', 'Last 6 months bank statement', 'Form 16 or latest ITR', 'Employee ID / offer letter'],
            self: ['Last 2-3 years ITR with financials', 'Last 12 months bank statement', 'Business proof (GST / Udyam / registration)'],
            specific: ['Property title deed / chain of documents', 'Latest property tax receipt', 'Occupancy certificate / approved plan', 'Existing mortgage or loan details', 'Property valuation report (arranged by lender)']
        },
        business: {
            label: 'Business Loan',
            common: ['PAN card', 'Aadhaar card', 'Passport-size photographs', 'Business address proof'],
            salaried: ['Not applicable - business loans need business income proof'],
            self: ['Last 2 years ITR with computation', 'Audited financials / P&L and balance sheet', 'Last 12 months bank statement', 'GST returns and Udyam / shop licence'],
            specific: ['Ownership proof or rent agreement of business premises', 'Existing loan statements', 'Bank statement of current account', 'GST / VAT registration certificate']
        },
        personal: {
            label: 'Personal Loan',
            common: ['PAN card', 'Aadhaar card', 'Passport-size photographs', 'Address proof'],
            salaried: ['Last 3 months salary slips', 'Last 6 months bank statement', 'Form 16 or latest ITR', 'Employee ID / offer letter'],
            self: ['Last 2 years ITR', 'Last 6-12 months bank statement', 'Business proof (GST / Udyam / registration)'],
            specific: ['Existing loan or credit card statements', 'Purpose of loan (if asked by lender)', 'Reference details (as requested)']
        },
        education: {
            label: 'Education Loan',
            common: ['Student PAN / Aadhaar', 'Passport-size photographs', 'Address proof', 'Co-applicant PAN and Aadhaar'],
            salaried: ['Co-applicant last 3 months salary slips', 'Co-applicant last 6 months bank statement', 'Co-applicant Form 16 or ITR'],
            self: ['Co-applicant last 2-3 years ITR', 'Co-applicant business financials', 'Co-applicant last 12 months bank statement'],
            specific: ['Admission letter from the institute', 'Fee structure / fee receipt', 'Class 10, 12 and graduation marksheets', 'Entrance exam score card', 'Collateral documents (for secured loans)']
        },
        vehicle: {
            label: 'Vehicle Loan',
            common: ['PAN card', 'Aadhaar card', 'Passport-size photographs', 'Address proof'],
            salaried: ['Last 3 months salary slips', 'Last 6 months bank statement', 'Form 16 or latest ITR', 'Employee ID / offer letter'],
            self: ['Last 2 years ITR', 'Last 6-12 months bank statement', 'Business proof (GST / Udyam / registration)'],
            specific: ['Proforma invoice / quotation from dealer', 'Dealer and vehicle details', 'Driving licence (for some lenders)', 'Existing vehicle loan statement (for refinance)']
        }
    };

    function initWizard() {
        var form = document.querySelector('.doc-wizard-form');
        if (!form) { return; }
        var loanSelect = form.querySelector('.dw-loan');
        var empSelect = form.querySelector('.dw-emp');
        var amountSelect = form.querySelector('.dw-amount');
        var result = document.querySelector('.wizard-result');
        var list = result ? result.querySelector('.doc-list') : null;
        var waButton = document.querySelector('.doc-wizard-wa');

        function build() {
            var key = loanSelect.value;
            var emp = empSelect.value;
            var amount = amountSelect.value;
            var data = DOC_DATA[key];
            if (!data || !list) { return; }

            var docs = data.common.concat(data[emp] || []).concat(data.specific);
            list.innerHTML = '';
            Array.prototype.forEach.call(docs, function (doc) {
                var li = document.createElement('li');
                li.textContent = doc;
                list.appendChild(li);
            });

            result.hidden = false;
            result.querySelector('h3').textContent = data.label + ' - your document checklist';

            if (waButton) {
                waButton.href = waLink(
                    'Hi Dhanvi Finserv, I want a ' + data.label + ' of about ' + amount + '. ' +
                    'My employment type is ' + (emp === 'salaried' ? 'salaried' : 'self-employed') + '. ' +
                    'Please confirm the documents I need:\n- ' + docs.join('\n- ')
                );
            }

            var panelId = 'doc-' + key;
            var tab = document.querySelector('[data-doc-tab="' + panelId + '"]');
            if (tab) { tab.click(); }
            if (result.scrollIntoView) { result.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        }

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            build();
        });
    }

    function initPrint() {
        var buttons = document.querySelectorAll('[data-print-checklist]');
        Array.prototype.forEach.call(buttons, function (button) {
            button.addEventListener('click', function (e) {
                e.preventDefault();
                window.print();
            });
        });
    }

    function initFormFeedback() {
        Array.prototype.forEach.call(document.querySelectorAll('form .form-control'), function (field) {
            field.addEventListener('blur', function () { field.classList.add('touched'); });
        });
    }

    ready(function () {
        initSkipLink();
        initMobileBar();
        initEmiValueEditing();
        initMiniEmi();
        initDocTabs();
        initWizard();
        initPrint();
        initFormFeedback();
    });
})();
