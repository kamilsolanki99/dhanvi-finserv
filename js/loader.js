/**
 * Dhanvi Finserv - Lightweight Page Preloader
 * Handles smooth loading transitions, zero-flicker on fast connections,
 * back/forward cache safety, and fail-safe error recovery.
 */
(function () {
    'use strict';

    var loader = document.getElementById('page-loader');
    if (!loader) return;

    var dismissed = false;
    var showTimer = null;

    // 1. Anti-flicker: Only show the loader if loading takes longer than 120ms
    // If the page loads quickly (e.g., from cache), it will be dismissed before ever showing
    showTimer = setTimeout(function () {
        if (!dismissed && loader) {
            loader.classList.add('is-visible');
        }
    }, 120);

    function dismissLoader() {
        if (dismissed) return;
        dismissed = true;

        if (showTimer) {
            clearTimeout(showTimer);
            showTimer = null;
        }

        try {
            loader.classList.remove('is-visible');
            loader.classList.add('is-hidden');
            loader.setAttribute('aria-hidden', 'true');

            // Wait for CSS transition (300ms) then remove element completely from DOM
            setTimeout(function () {
                if (loader && loader.parentNode) {
                    loader.parentNode.removeChild(loader);
                }
            }, 320);
        } catch (e) {
            // Instant fallback if DOM manipulation fails
            if (loader) {
                loader.style.display = 'none';
            }
        }
    }

    // 2. Check if page is already loaded (cached or instant render)
    if (document.readyState === 'complete') {
        dismissLoader();
        return;
    }

    // 3. Browser Back/Forward navigation detection: Never show loader when returning via history
    try {
        if (window.performance) {
            var navEntries = performance.getEntriesByType && performance.getEntriesByType('navigation');
            if (navEntries && navEntries.length > 0 && navEntries[0].type === 'back_forward') {
                dismissLoader();
                return;
            } else if (performance.navigation && performance.navigation.type === 2) {
                dismissLoader();
                return;
            }
        }
    } catch (e) {}

    // 4. Hide immediately when window load event completes
    window.addEventListener('load', function () {
        dismissLoader();
    });

    // 5. Essential content fallback: If DOM is ready and window.load takes > 1.2s, dismiss
    document.addEventListener('DOMContentLoaded', function () {
        setTimeout(function () {
            dismissLoader();
        }, 1200);
    });

    // 6. Absolute fail-safe: Never stay on screen under ANY circumstance (image hanging, 3rd party script stall)
    setTimeout(function () {
        dismissLoader();
    }, 2500);

    // 7. BFCache restoration (browser back/forward button)
    window.addEventListener('pageshow', function (event) {
        if (event.persisted) {
            dismissLoader();
        }
    });

    // 8. Graceful recovery on runtime errors or broken resources
    window.addEventListener('error', function () {
        setTimeout(dismissLoader, 300);
    });

})();

// Global logo error handler in case image fails to load
function handleDhanviLogoError(img) {
    if (!img) return;
    img.style.display = 'none';
    var fallback = document.querySelector('.loader-logo-fallback');
    if (fallback) {
        fallback.style.display = 'block';
    }
}
