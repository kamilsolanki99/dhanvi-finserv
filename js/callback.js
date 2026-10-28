/**
 * Dhanvi Finserv - callback scheduling.
 * Depends on: js/nhost-client.js, js/public-api.js
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var form = document.getElementById('callbackForm');
    if (!form || !D) { return; }

    var SLOTS = [
        '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
        '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
        '17:00', '17:30'
    ];

    var alertBox = document.getElementById('callbackAlert');
    var dateInput = document.getElementById('cbDate');
    var slotGrid = document.getElementById('slotGrid');
    var slotNote = document.getElementById('slotNote');
    var submitBtn = document.getElementById('callbackSubmit');
    var successBox = document.getElementById('callbackSuccess');
    var resetBtn = document.getElementById('callbackReset');
    var slotRequestId = 0;

    dateInput.min = D.todayISO(1);
    dateInput.max = D.todayISO(45);

    function selectedSlot() {
        var checked = form.querySelector('input[name="callbackSlot"]:checked');
        return checked ? checked.value : '';
    }

    function renderSlots(booked) {
        slotGrid.innerHTML = '';
        var available = 0;

        SLOTS.forEach(function (slot) {
            var isBooked = booked.indexOf(slot) !== -1;
            if (!isBooked) { available += 1; }

            var label = document.createElement('label');
            label.className = 'cp-slot' + (isBooked ? ' is-booked' : '');
            label.innerHTML =
                '<input type="radio" name="callbackSlot" value="' + slot + '"' +
                (isBooked ? ' disabled' : '') + '>' +
                '<span>' + D.prettySlot(slot) + '</span>';
            slotGrid.appendChild(label);
        });

        if (available === 0) {
            slotNote.textContent = 'All slots are booked for this date. Please choose another date.';
            D.showAlert(alertBox, 'warn', 'No callback slots are available on the selected date. Please choose another working day.');
        } else {
            slotNote.textContent = available + ' of ' + SLOTS.length + ' slots available. Each slot is 30 minutes.';
            D.hideAlert(alertBox);
        }
    }

    async function loadSlots() {
        var requestId = ++slotRequestId;
        var date = dateInput.value;
        if (!date) {
            slotGrid.innerHTML = '';
            slotNote.textContent = 'Choose a date to see available slots.';
            return;
        }
        if (D.isSunday(date)) {
            slotGrid.innerHTML = '';
            slotNote.textContent = 'Callbacks are not available on Sundays. Please choose another date.';
            D.showAlert(alertBox, 'warn', 'Callbacks are not available on Sundays. Please choose a working day.');
            return;
        }

        slotGrid.innerHTML = '<div class="cp-empty" style="grid-column:1/-1;"><i class="fa fa-circle-o-notch fa-spin"></i>Loading available slots…</div>';
        slotNote.textContent = 'Checking availability…';

        try {
            var rows = await D.rpc('get_booked_callback_slots', { p_date: date });
            if (requestId !== slotRequestId) { return; }
            // A tracked function returning one row is unwrapped to a single
            // object by D.rpc; normalise it back to a list.
            if (rows && !Array.isArray(rows)) { rows = [rows]; }
            var booked = (rows || []).map(function (row) { return row.slot; });
            renderSlots(booked);
        } catch (err) {
            if (requestId !== slotRequestId) { return; }
            console.error('Could not load callback slots:', err);
            slotGrid.innerHTML = '';
            slotNote.textContent = '';
            D.showAlert(alertBox, 'error',
                'Callback scheduling is temporarily unavailable. Please call +91 99250 02324 or try again later.');
        }
    }

    dateInput.addEventListener('change', loadSlots);

    form.addEventListener('input', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
    });

    form.addEventListener('change', function (event) {
        if (event.target.name === 'callbackSlot') {
            D.hideAlert(alertBox);
        }
    });

    form.addEventListener('submit', async function (event) {
        event.preventDefault();
        D.hideAlert(alertBox);
        D.clearErrors(form);

        var name = document.getElementById('cbName');
        var mobile = document.getElementById('cbMobile');
        var email = document.getElementById('cbEmail');
        var consent = document.getElementById('cbConsent');
        var ok = true;

        if (!name.value.trim()) {
            D.setFieldError(name, 'Enter your full name.');
            ok = false;
        }
        if (!D.isIndianMobile(mobile.value)) {
            D.setFieldError(mobile, 'Enter a valid 10-digit Indian mobile number.');
            ok = false;
        }
        if (email.value.trim() && !D.isEmail(email.value)) {
            D.setFieldError(email, 'Enter a valid email address.');
            ok = false;
        }
        if (!dateInput.value) {
            D.setFieldError(dateInput, 'Choose a callback date.');
            ok = false;
        } else if (D.isSunday(dateInput.value)) {
            D.setFieldError(dateInput, 'Sundays are not available.');
            ok = false;
        }
        if (!selectedSlot()) {
            D.showAlert(alertBox, 'error', 'Choose an available time slot.');
            ok = false;
        }
        if (!consent.checked) {
            D.showAlert(alertBox, 'error', 'Please accept the privacy notice before scheduling a callback.');
            ok = false;
        }
        if (!ok) {
            var first = form.querySelector('.is-invalid');
            if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            return;
        }

        D.setLoading(submitBtn, true, 'Scheduling callback…');
        try {
            var result = await D.rpc('book_callback', {
                p_full_name: name.value.trim(),
                p_mobile: mobile.value.trim(),
                p_email: email.value.trim(),
                p_date: dateInput.value,
                p_slot: selectedSlot(),
                p_notes: document.getElementById('cbNotes').value.trim(),
                p_application_reference: document.getElementById('cbAppRef').value.trim(),
                p_consent: true
            });
            showSuccess(result);
        } catch (err) {
            console.error('Callback booking failed:', err);
            if (err.code === '23505' || err.code === 'constraint-violation') {
                D.showAlert(alertBox, 'error', 'That slot was just booked by someone else. Please choose another time.');
                await loadSlots();
            } else {
                D.showAlert(alertBox, 'error', D.escapeHtml(D.friendlyError(err)));
            }
            alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } finally {
            D.setLoading(submitBtn, false);
        }
    });

    function showSuccess(result) {
        form.classList.add('cp-hidden');
        successBox.classList.add('show');
        document.getElementById('callbackReference').textContent = result.reference_no || '—';
        document.getElementById('callbackWhen').textContent =
            D.prettyDate(result.preferred_date) + ' at ' + D.prettySlot(result.preferred_slot) + ' (IST)';
        successBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', function () {
            form.reset();
            slotGrid.innerHTML = '';
            slotNote.textContent = 'Choose a date to see available slots.';
            slotRequestId += 1;
            D.clearErrors(form);
            D.hideAlert(alertBox);
            form.classList.remove('cp-hidden');
            successBox.classList.remove('show');
            dateInput.min = D.todayISO(1);
            dateInput.max = D.todayISO(45);
            form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
})(window, document);
