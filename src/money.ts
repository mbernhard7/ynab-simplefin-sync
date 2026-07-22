/**
 * SimpleFIN reports balances as *numeric strings* ("1234.56", "-0.7"). Parsing those
 * through a float and multiplying by 1000 introduces representation error at exactly the
 * magnitudes we care about, so convert digit-by-digit instead.
 */
export const toMilliunits = (value: string | number): number => {
    const raw = typeof value === "number" ? value.toString() : value.trim();

    if (!/^[+-]?\d*(\.\d+)?$/.test(raw) || raw === "" || raw === "+" || raw === "-") {
        throw new Error(`Unparseable SimpleFIN amount: ${JSON.stringify(value)}`);
    }

    const negative = raw.startsWith("-");
    const unsigned = raw.replace(/^[+-]/, "");
    const [wholePart = "", fracPart = ""] = unsigned.split(".");

    const whole = wholePart === "" ? 0 : Number(wholePart);
    const milli = Number((fracPart + "000").slice(0, 3));

    let total = whole * 1000 + milli;

    // Round on the 4th decimal place rather than truncating.
    const remainder = fracPart.slice(3);
    if (remainder && Number(remainder[0]) >= 5) {
        total += 1;
    }

    if (!Number.isFinite(total)) {
        throw new Error(`Unparseable SimpleFIN amount: ${JSON.stringify(value)}`);
    }

    return negative ? -total : total;
};
