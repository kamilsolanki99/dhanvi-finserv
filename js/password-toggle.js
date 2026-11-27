(function () {
    'use strict';

    Array.prototype.forEach.call(document.querySelectorAll('input[type="password"]'), function (input) {
        var wrapper = document.createElement('div');
        wrapper.className = 'password-toggle-wrap';
        input.parentNode.insertBefore(wrapper, input);
        wrapper.appendChild(input);

        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'password-toggle';
        button.setAttribute('aria-label', 'Show password');
        button.setAttribute('aria-controls', input.id);
        button.setAttribute('aria-pressed', 'false');

        var icon = document.createElement('i');
        icon.className = 'fa fa-eye';
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        wrapper.appendChild(button);

        button.addEventListener('click', function () {
            var showing = input.type === 'password';
            input.type = showing ? 'text' : 'password';
            button.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
            button.setAttribute('aria-pressed', showing ? 'true' : 'false');
            icon.className = showing ? 'fa fa-eye-slash' : 'fa fa-eye';
        });
    });
})();
