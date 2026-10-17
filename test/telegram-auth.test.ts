import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyInitData } from "../src/core/telegram-auth";

const TOKEN = "123456:ABC-test-token";
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;

/** initData as Telegram signs it, built with node:crypto (independent of the code under test). */
function initData(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const USER = JSON.stringify({ id: 42, first_name: "Peter", username: "peter", language_code: "en", allows_write_to_pm: true });
const fields = (over: Record<string, string> = {}) => ({
  query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
  user: USER,
  auth_date: String(NOW_S - 30),
  signature: "SGVsbG8td29ybGQtc2lnbmF0dXJlLWVkMjU1MTk_base64url",
  ...over,
});

describe("verifyInitData", () => {
  test("accepts initData Telegram signed, signature field included in the check", async () => {
    expect(await verifyInitData(initData(fields()), TOKEN, 600, NOW_MS)).toEqual({ userId: 42, authDate: NOW_S - 30 });
  });

  test("rejects a tampered field, a dropped field, or another bot's token", async () => {
    const good = initData(fields());
    const tampered = good.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":43'));
    expect(tampered).not.toBe(good);
    expect(await verifyInitData(tampered, TOKEN, 600, NOW_MS)).toBeNull();
    const p = new URLSearchParams(good);
    p.delete("signature");
    expect(await verifyInitData(p.toString(), TOKEN, 600, NOW_MS)).toBeNull();
    expect(await verifyInitData(initData(fields(), "999:other"), TOKEN, 600, NOW_MS)).toBeNull();
  });

  test("rejects stale and far-future auth_date", async () => {
    expect(await verifyInitData(initData(fields({ auth_date: String(NOW_S - 601) })), TOKEN, 600, NOW_MS)).toBeNull();
    expect(await verifyInitData(initData(fields({ auth_date: String(NOW_S + 3600) })), TOKEN, 600, NOW_MS)).toBeNull();
    expect(await verifyInitData(initData(fields({ auth_date: String(NOW_S - 600) })), TOKEN, 600, NOW_MS)).not.toBeNull();
  });

  test("rejects malformed input", async () => {
    for (const bad of ["", "garbage", "hash=zz", `auth_date=${NOW_S}&hash=${"0".repeat(64)}`]) {
      expect(await verifyInitData(bad, TOKEN, 600, NOW_MS)).toBeNull();
    }
    // Signed correctly, but no usable user or auth_date.
    const { user: _, ...noUser } = fields();
    expect(await verifyInitData(initData(noUser), TOKEN, 600, NOW_MS)).toBeNull();
    expect(await verifyInitData(initData(fields({ user: "{not json" })), TOKEN, 600, NOW_MS)).toBeNull();
    expect(await verifyInitData(initData(fields({ user: '{"id":"42"}' })), TOKEN, 600, NOW_MS)).toBeNull();
    expect(await verifyInitData(initData(fields({ auth_date: "soon" })), TOKEN, 600, NOW_MS)).toBeNull();
    // A repeated key.
    expect(await verifyInitData(`${initData(fields())}&user=${encodeURIComponent('{"id":1}')}`, TOKEN, 600, NOW_MS)).toBeNull();
  });
});
