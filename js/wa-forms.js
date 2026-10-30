(function () {
    var WA_NUMBER = '919925002324';

    function buildMessage(form) {
        var parts = ['New enquiry from Dhanvi Finserv website', ''];
        var els = form.querySelectorAll('input, select, textarea');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            var type = (el.type || '').toLowerCase();
            if (!el.name || type === 'submit' || type === 'button' || type === 'hidden') continue;
            var val = (el.value || '').trim();
            if (!val) continue;
            var label = el.name.charAt(0).toUpperCase() + el.name.slice(1);
            parts.push(label + ': ' + val);
        }
        return parts.join('\n');
    }

    function handleSubmit(e) {
        e.preventDefault();
        var form = e.target;
        var url = 'https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(buildMessage(form));
        var opened = window.open(url, '_blank');

        var notify = window.DhanviNotify;
        if (notify) {
            var isNewsletter = !!form.querySelector('#newsletter, input[name="newsletter"]');
            if (!opened) {
                notify.warning(
                    'Pop-up blocked',
                    'Please allow pop-ups for this site and try again, or call +91 99250 02324.'
                );
            } else if (isNewsletter) {
                notify.info(
                    'Newsletter signup',
                    'Continue in the WhatsApp window to complete your newsletter signup.'
                );
            } else if (!form.classList.contains('blog-search-form') &&
                       !form.classList.contains('reply-form') &&
                       !form.classList.contains('doc-wizard-form') &&
                       !form.classList.contains('loan-eligibility-form')) {
                notify.info(
                    'Opening WhatsApp',
                    'Continue your enquiry in the WhatsApp window. If it did not open, allow pop-ups and try again.'
                );
            }
        }
        return false;
    }

    document.addEventListener('DOMContentLoaded', function () {
        var forms = document.querySelectorAll('form');
        for (var i = 0; i < forms.length; i++) {
            if (forms[i].hasAttribute('data-wa-ignore')) continue;
            var action = forms[i].getAttribute('action') || '';
            if (action.indexOf('jituchauhan') !== -1 || action === '#' || action === '') {
                forms[i].addEventListener('submit', handleSubmit);
            }
        }
    });
})();
