/**
 * Dhanvi Finserv - Interactive Motion & Micro-Interactions Engine
 * Powered by Intersection Observer. Zero dependencies, lightweight, 60fps.
 */
(function () {
    'use strict';

    // 1. Check for reduced motion preference
    var prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Helper: Execute after DOM is loaded
    function onReady(fn) {
        if (document.readyState !== 'loading') {
            fn();
        } else {
            document.addEventListener('DOMContentLoaded', fn);
        }
    }

    /* ----------------------------------------------------------------------
       A. Scroll Reveal Animations (Intersection Observer)
       ---------------------------------------------------------------------- */
    function initScrollReveals() {
        if (prefersReducedMotion || !('IntersectionObserver' in window)) {
            return;
        }

        // Select key interactive cards and headings to animate on scroll
        var targetSelectors = [
            '.service-block',
            '.rate-box',
            '.rate-counter-block',
            '.feature-card',
            '.process-step',
            '.why-choose-block',
            '.testimonial-block',
            '.post-block',
            '.stat-card',
            '.doc-note'
        ].join(', ');

        var elements = document.querySelectorAll(targetSelectors);
        if (!elements.length) return;

        // Group sibling columns in rows to add staggered delays
        var rows = document.querySelectorAll('.row');
        Array.prototype.forEach.call(rows, function (row) {
            var items = row.querySelectorAll(targetSelectors);
            if (items.length > 1) {
                Array.prototype.forEach.call(items, function (item, index) {
                    var delayClass = 'reveal-delay-' + Math.min(index + 1, 4);
                    item.classList.add(delayClass);
                });
            }
        });

        var observer = new IntersectionObserver(function (entries, obs) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('is-revealed');
                    obs.unobserve(entry.target);
                }
            });
        }, {
            root: null,
            rootMargin: '0px 0px -40px 0px',
            threshold: 0.12
        });

        Array.prototype.forEach.call(elements, function (el) {
            el.classList.add('reveal-on-scroll');
            observer.observe(el);
        });
    }

    /* ----------------------------------------------------------------------
       B. Numerical Counter Animations
       ---------------------------------------------------------------------- */
    function initStatCounters() {
        if (prefersReducedMotion || !('IntersectionObserver' in window)) {
            return;
        }

        // Target milestone stats in about.html, admin dashboard, etc.
        var statElements = document.querySelectorAll('.big-title, .stat-number');
        if (!statElements.length) return;

        var counterObserver = new IntersectionObserver(function (entries, obs) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    animateCounter(entry.target);
                    obs.unobserve(entry.target);
                }
            });
        }, {
            threshold: 0.3
        });

        Array.prototype.forEach.call(statElements, function (el) {
            var rawText = el.textContent.trim();
            // Match numbers like 5,000+, ₹500 crore+, 247, etc.
            var match = rawText.match(/^([^\d]*)([\d,]+(\.\d+)?)(.*)$/);
            if (match) {
                el.setAttribute('data-counter-target', match[2].replace(/,/g, ''));
                el.setAttribute('data-counter-prefix', match[1]);
                el.setAttribute('data-counter-suffix', match[4]);
                counterObserver.observe(el);
            }
        });
    }

    function animateCounter(el) {
        var rawTarget = el.getAttribute('data-counter-target');
        if (!rawTarget) return;

        var targetValue = parseFloat(rawTarget);
        if (isNaN(targetValue)) return;

        var prefix = el.getAttribute('data-counter-prefix') || '';
        var suffix = el.getAttribute('data-counter-suffix') || '';
        var isFloat = rawTarget.indexOf('.') !== -1;
        var duration = 1400; // ms
        var startTime = null;

        function step(timestamp) {
            if (!startTime) startTime = timestamp;
            var progress = Math.min((timestamp - startTime) / duration, 1);
            // Ease out quad
            var easeProgress = progress * (2 - progress);
            var current = targetValue * easeProgress;

            var formatted = isFloat
                ? current.toFixed(1)
                : Math.round(current).toLocaleString('en-IN');

            el.textContent = prefix + formatted + suffix;

            if (progress < 1) {
                window.requestAnimationFrame(step);
            } else {
                // Ensure exact final string
                var finalFormatted = isFloat
                    ? targetValue.toFixed(1)
                    : targetValue.toLocaleString('en-IN');
                el.textContent = prefix + finalFormatted + suffix;
            }
        }

        window.requestAnimationFrame(step);
    }

    /* ----------------------------------------------------------------------
       C. Loan Calculator Micro-Feedback
       ---------------------------------------------------------------------- */
    function initCalculatorFeedback() {
        var sliders = document.querySelectorAll('input[type="range"]');
        if (!sliders.length) return;

        var outputEls = document.querySelectorAll(
            '#monthly-emi, #total-interest, #total-payment, #emi, .emi-output, #tbl_emi, #tbl_interest, #tbl_total, #la_value, #nm_value, #roi_value'
        );

        if (!outputEls.length) return;

        var flashTimer = null;
        function flashOutputs() {
            if (flashTimer) clearTimeout(flashTimer);
            Array.prototype.forEach.call(outputEls, function (el) {
                el.classList.add('emi-value-flash');
            });
            flashTimer = setTimeout(function () {
                Array.prototype.forEach.call(outputEls, function (el) {
                    el.classList.remove('emi-value-flash');
                });
            }, 400);
        }

        Array.prototype.forEach.call(sliders, function (slider) {
            slider.addEventListener('input', flashOutputs);
        });
    }

    /* ----------------------------------------------------------------------
       D. Button Click Micro-Feedback (Tactile Ripple Effect)
       ---------------------------------------------------------------------- */
    function initButtonFeedback() {
        if (prefersReducedMotion) return;

        var buttons = document.querySelectorAll('.btn-default, .btn-primary, .btn-nav-cta');
        Array.prototype.forEach.call(buttons, function (btn) {
            btn.addEventListener('mousedown', function () {
                btn.style.transform = 'translateY(1px) scale(0.985)';
            });
            btn.addEventListener('mouseup', function () {
                btn.style.transform = '';
            });
            btn.addEventListener('mouseleave', function () {
                btn.style.transform = '';
            });
        });
    }

    // Initialize all components on DOM ready
    onReady(function () {
        initScrollReveals();
        initStatCounters();
        initCalculatorFeedback();
        initButtonFeedback();
    });

})();
