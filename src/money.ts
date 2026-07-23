/** Converts a decimal amount string ("1234.56", "-0.7") to milliunits digit-by-digit. */
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

    const remainder = fracPart.slice(3);
    if (remainder && Number(remainder[0]) >= 5) {
        total += 1;
    }

    if (!Number.isFinite(total)) {
        throw new Error(`Unparseable SimpleFIN amount: ${JSON.stringify(value)}`);
    }

    return negative ? -total : total;
};
