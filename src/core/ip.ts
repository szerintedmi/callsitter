// Client IPs as rate-limit keys. An IPv6 client usually holds a whole /64 (often more) and can
// pick a new address in it for every request, so per-IP limits count its network prefix instead.

/**
 * The key a per-IP limit counts `ip` under: an IPv6 address's first `v6Prefix` bits (as
 * `2001:db8:1:2::/64`), an IPv4-mapped one's IPv4, anything else as it is (IPv4, "local").
 */
export function ipKey(ip: string, v6Prefix: number): string {
  const groups = ipv6Groups(ip);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
  }
  const masked = groups.map((g, i) => {
    const bits = Math.min(16, Math.max(0, v6Prefix - i * 16));
    return bits === 0 ? 0 : g & ((0xffff << (16 - bits)) & 0xffff);
  });
  return `${compress(masked)}/${v6Prefix}`;
}

/** an IPv6 address's eight 16-bit groups; null: not IPv6 */
function ipv6Groups(ip: string): number[] | null {
  const addr = ip.split("%")[0]!.toLowerCase();
  if (!addr.includes(":")) return null;
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === "") return [];
    const parts = s.split(":");
    const out: number[] = [];
    for (const [i, p] of parts.entries()) {
      if (i === parts.length - 1 && p.includes(".")) {
        const v4 = p.split(".").map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : NaN));
        if (v4.length !== 4 || v4.some((o) => !(o <= 255))) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/.test(p)) out.push(parseInt(p, 16));
      else return null;
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

/** groups as hex, the longest run of zero groups (two or more) as `::` */
function compress(groups: number[]): string {
  let best = { at: -1, len: 1 };
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j === i ? i + 1 : j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.at < 0) return hex.join(":");
  return `${hex.slice(0, best.at).join(":")}::${hex.slice(best.at + best.len).join(":")}`;
}
