import { describe, expect, test } from "bun:test";
import { spokenNumber, toE164 } from "../src/core/phone";

describe("caller numbers", () => {
  test("toE164: national, 00 and +-less international numbers; anything else as it came", () => {
    expect(toE164("07700900461", 44)).toBe("+447700900461");
    expect(toE164("+447700900461", 44)).toBe("+447700900461");
    expect(toE164("36301234567", 44)).toBe("+36301234567");
    expect(toE164("0036301234567", 44)).toBe("+36301234567");
    expect(toE164("020 7946 0018", 44)).toBe("+442079460018");
    for (const raw of ["anonymous", "", "browser (SIP)", "123"]) expect(toE164(raw, 44)).toBe(raw);
  });

  test("spokenNumber: home numbers national and grouped, others E.164, else withheld", () => {
    expect(spokenNumber("+447700900461", 44)).toBe("07700 900461");
    expect(spokenNumber("07700900461", 44)).toBe("07700 900461");
    expect(spokenNumber("+442079460018", 44)).toBe("020 7946 0018");
    expect(spokenNumber("+443001234567", 44)).toBe("0300 123 4567");
    expect(spokenNumber("36301234567", 44)).toBe("+36301234567");
    expect(spokenNumber("+36301234567", 36)).toBe("0301234567");
    for (const from of ["", "anonymous", "public", "browser"]) expect(spokenNumber(from, 44)).toBe("withheld");
  });
});
