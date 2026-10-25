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
        window.open(url, '_blank');
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
