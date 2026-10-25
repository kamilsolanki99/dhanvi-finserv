function eligiable() {
    var f2 = document.formval2;
    var f3 = document.formval3;
    if (!f2 || !f3) return;

    var P1 = parseFloat(f2.pr_amt2.value);
    var rate1 = parseFloat(f2.int_rate2.value);
    var n1 = parseFloat(f2.period2.value);
    var existing = parseFloat(f2.ExLoan.value) || 0;
    var income1 = parseFloat(f2.NetIncome.value);

    if (isNaN(P1) || P1 <= 0 || isNaN(income1) || income1 <= 0 || isNaN(n1) || n1 <= 0 || isNaN(rate1) || rate1 <= 0) {
        f3.field13.value = "Please enter valid loan amount, income, tenure and interest rate.";
        f3.field11.value = "";
        f3.field12.value = "";
        return;
    }

    var r1 = rate1 / (12 * 100);
    var months = n1 * 12;
    var factor = Math.pow(1 + r1, months);
    var emi1 = Math.ceil((P1 * r1 * factor) / (factor - 1));

    var existingLoan = existing * 0.40;
    var ratio = 0.50;
    if (income1 <= 14999) {
        ratio = 0.40;
    } else if (income1 <= 29999) {
        ratio = 0.45;
    }

    var incomere = (income1 * ratio) - existingLoan;
    if (incomere <= 0) {
        f3.field13.value = "You are not Eligible for this loan";
        f3.field11.value = "";
        f3.field12.value = "Existing loan commitments exceed eligible income limit.";
        return;
    }

    var incomereq = Math.floor(incomere / emi1 * P1);
    var prate2 = (incomereq * r1 * factor) / (factor - 1);
    var emi2 = Math.ceil(prate2);

    if (incomereq >= P1) {
        f3.field13.value = "You are Eligible for this loan";
        f3.field11.value = "₹ " + Math.round(P1).toLocaleString('en-IN') + " at EMI ₹ " + emi1.toLocaleString('en-IN') + "/mo";
        f3.field12.value = "You are Eligible for a maximum loan of ₹ " + incomereq.toLocaleString('en-IN') + " at EMI ₹ " + emi2.toLocaleString('en-IN') + "/mo";
    } else {
        f3.field13.value = "You are not Eligible for requested loan amount";
        f3.field11.value = "Requested: ₹ " + Math.round(P1).toLocaleString('en-IN') + " (EMI ₹ " + emi1.toLocaleString('en-IN') + "/mo)";
        f3.field12.value = "You are Eligible for a maximum loan of ₹ " + incomereq.toLocaleString('en-IN') + " at EMI ₹ " + emi2.toLocaleString('en-IN') + "/mo";
    }
}

function resetEligibility() {
    if (document.formval2) document.formval2.reset();
    if (document.formval3) {
        document.formval3.field13.value = "";
        document.formval3.field11.value = "";
        document.formval3.field12.value = "";
    }
}
