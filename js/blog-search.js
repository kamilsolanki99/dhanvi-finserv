(function () {
    var forms = document.querySelectorAll('.blog-search-form');
    if (!forms.length) {
        return;
    }

    var inputs = document.querySelectorAll('.blog-search-input');
    var count = document.getElementById('blogResultCount');
    var empty = document.getElementById('blogNoResults');
    var items = document.querySelectorAll('[data-blog-item]');

    function filterArticles(source) {
        var query = (source.value || '').toLowerCase().replace(/\s+/g, ' ').trim();
        var terms = query ? query.split(' ') : [];
        var visible = 0;
        var i;
        var j;

        for (i = 0; i < inputs.length; i++) {
            if (inputs[i] !== source) {
                inputs[i].value = source.value;
            }
        }

        for (i = 0; i < items.length; i++) {
            var haystack = (items[i].getAttribute('data-blog-search') || '').toLowerCase();
            var matches = true;

            for (j = 0; j < terms.length; j++) {
                if (haystack.indexOf(terms[j]) === -1) {
                    matches = false;
                    break;
                }
            }

            items[i].hidden = !matches;
            if (matches) {
                visible++;
            }
        }

        if (count) {
            count.textContent = visible + (visible === 1 ? ' article' : ' articles');
        }
        if (empty) {
            empty.hidden = visible !== 0;
        }
    }

    function bindForm(form) {
        var input = form.querySelector('.blog-search-input');
        if (!input) {
            return;
        }

        form.addEventListener('submit', function (event) {
            event.preventDefault();
            filterArticles(input);
        });

        input.addEventListener('input', function () {
            filterArticles(input);
        });
        input.addEventListener('search', function () {
            filterArticles(input);
        });
    }

    for (var i = 0; i < forms.length; i++) {
        bindForm(forms[i]);
    }
}());
