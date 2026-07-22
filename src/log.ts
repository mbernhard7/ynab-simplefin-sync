const PREFIX = "[YSS]";

export const info = (msg: string) => console.log(`${PREFIX} ${msg}`);
export const detail = (msg: string) => console.log(`      ${msg}`);
export const warn = (msg: string) => console.log(`${PREFIX} [WARN] ${msg}`);
export const error = (msg: string) => console.error(`${PREFIX} [ERROR] ${msg}`);

/** Strips Basic Auth credentials so an Access URL can be logged safely. */
export const redactUrl = (url: string): string => {
    try {
        const u = new URL(url);
        if (u.username || u.password) {
            u.username = "***";
            u.password = "***";
        }
        return u.toString();
    } catch {
        return "<unparseable url>";
    }
};

export const formatMilliunits = (milliunits: number): string => {
    const sign = milliunits < 0 ? "-" : "";
    const abs = Math.abs(milliunits);
    const dollars = Math.floor(abs / 1000);
    const cents = Math.round((abs % 1000) / 10);
    return `${sign}$${dollars.toLocaleString("en-US")}.${String(cents).padStart(2, "0")}`;
};
