$(document).ready(function () {
    var $amount = $('#la');
    var $months = $('#nm');
    var $rate = $('#roi');
    var $amountOut = $('#la_value');
    var $monthsOut = $('#nm_value');
    var $rateOut = $('#roi_value');

    if (!$amount.length || !$months.length || !$rate.length) {
        return;
    }

    function formatINR(value) {
        return '\u20B9' + Math.round(value).toLocaleString('en-IN');
    }

    function formatMoney(value) {
        return value.toLocaleString('en-IN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    function readValues() {
        return {
            amount: parseFloat($amount.val()),
            months: Math.round(parseFloat($months.val())),
            rate: parseFloat($rate.val())
        };
    }

    function calculateEMI() {
        var values = readValues();
        var loanAmount = values.amount;
        var numberOfMonths = values.months;
        var rateOfInterest = values.rate;
        var monthlyInterestRatio = (rateOfInterest / 100) / 12;

        var top = Math.pow((1 + monthlyInterestRatio), numberOfMonths);
        var bottom = top - 1;
        var sp = top / bottom;
        var emi = ((loanAmount * monthlyInterestRatio) * sp);
        var full = numberOfMonths * emi;
        var interest = full - loanAmount;
        var int_pge = (interest / full) * 100;

        $amountOut.text(formatINR(loanAmount));
        $monthsOut.text(numberOfMonths + (numberOfMonths === 1 ? ' month' : ' months'));
        $rateOut.text(rateOfInterest.toFixed(2) + '% p.a.');

        $("#tbl_int_pge").html(int_pge.toFixed(2) + " %");
        $("#emi").html(formatMoney(emi));
        $("#tbl_full").html(formatMoney(full));
        $("#tbl_int").html(formatMoney(interest));

        // Update the "Apply for This Loan" button with the current loan amount
        var applyBtn = $('#apply-with-amount');
        if (applyBtn.length) {
            applyBtn.attr('href', 'apply-loan.html?amount=' + loanAmount);
        }

        var detailDesc = "<table class='table table-striped table-bordered mb0'><thead><tr class='table-head'><th>Payment No.</th><th>Beginning Balance</th><th>EMI</th><th>Principal</th><th>Interest</th><th>Ending Balance</th></tr></thead><tbody>";
        var balance = loanAmount;

        for (var j = 1; j <= numberOfMonths; j++) {
            var int_dd = balance * monthlyInterestRatio;
            var pre_dd = emi - int_dd;
            var end_dd = balance - pre_dd;

            detailDesc += "<tr><td>" + j + "</td><td>" + formatMoney(balance) + "</td><td>" + formatMoney(emi) + "</td><td>" + formatMoney(pre_dd) + "</td><td>" + formatMoney(int_dd) + "</td><td>" + formatMoney(end_dd) + "</td></tr>";
            balance = end_dd;
        }

        detailDesc += "</tbody></table>";
        $("#loantable").html(detailDesc);
    }

    $("#la, #nm, #roi").on("input change", calculateEMI);

    calculateEMI();
});
