import test from "node:test";
import assert from "node:assert/strict";
import { describeApiError } from "../src/ynab";

/** Minimal stand-in for the ynab SDK's ResponseError: a thrown object carrying a fetch Response. */
const responseError = (status: number, statusText: string, body?: unknown) => ({
    name: "ResponseError",
    message: "Response returned an error code",
    response: {
        status,
        statusText,
        clone: () => ({
            json: async () => {
                if (body === undefined) throw new Error("no body");
                return body;
            },
        }),
    },
});

test("describeApiError surfaces YNAB's status and error detail", async () => {
    const err = responseError(400, "Bad Request", {
        error: { id: "400.1", name: "bad_request", detail: "This account is a tracking account." },
    });
    assert.equal(await describeApiError(err), "YNAB API 400 Bad Request: This account is a tracking account.");
});

test("describeApiError falls back to the status when the body has no detail", async () => {
    assert.equal(await describeApiError(responseError(429, "Too Many Requests")), "YNAB API 429 Too Many Requests");
});

test("describeApiError never yields [object Object] for a plain object", async () => {
    const message = await describeApiError({ code: "boom", info: 1 });
    assert.notEqual(message, "[object Object]");
    assert.equal(message, '{"code":"boom","info":1}');
});

test("describeApiError passes through Errors and strings", async () => {
    assert.equal(await describeApiError(new Error("network down")), "network down");
    assert.equal(await describeApiError("plain string"), "plain string");
});
