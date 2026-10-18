import { describe, expect, test } from "bun:test";
import { ipKey } from "../src/core/ip";

describe("ipKey", () => {
  test("IPv6: the /64, however the address is written", () => {
    for (const ip of ["2001:db8:1:2::1", "2001:DB8:1:2:ffff:ffff:ffff:ffff", "2001:0db8:0001:0002:0:0:0:9", "2001:db8:1:2::1%eth0", "2001:db8:1:2::1.2.3.4"]) {
      expect(ipKey(ip, 64)).toBe("2001:db8:1:2::/64");
    }
    expect(ipKey("2001:db8:1:3::1", 64)).toBe("2001:db8:1:3::/64");
    expect(ipKey("::1", 64)).toBe("::/64");
    expect(ipKey("fe80::1", 64)).toBe("fe80::/64");
  });

  test("other prefixes, within a group too", () => {
    expect(ipKey("2001:db8:abcd:12ff::1", 56)).toBe("2001:db8:abcd:1200::/56");
    expect(ipKey("2001:db8:abcd:12ff::1", 48)).toBe("2001:db8:abcd::/48");
    expect(ipKey("2001:db8:0:0:1:0:0:1", 128)).toBe("2001:db8::1:0:0:1/128");
  });

  test("IPv4-mapped addresses count as their IPv4; IPv4 and anything else stay as they are", () => {
    expect(ipKey("::ffff:10.1.2.3", 64)).toBe("10.1.2.3");
    expect(ipKey("::ffff:a01:203", 64)).toBe("10.1.2.3");
    for (const ip of ["10.1.2.3", "local", "", "1::2::3", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", "12345::", "::1.2.3.256", "g::1", "1:2:3:4:5:6:7::8"]) {
      expect(ipKey(ip, 64)).toBe(ip);
    }
  });
});
