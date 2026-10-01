// Caller numbers. Calls are stored with E.164 numbers (+447700900461); anything that isn't a
// number (a withheld caller, a browser test call) is kept as it came.

/**
 * `raw` as E.164, with `countryCode` (e.g. 44) for national numbers. Telnyx's call-control
 * webhooks already send E.164; over SIP it sends national numbers (07700900461) and
 * international ones without the + (36301234567).
 */
export function toE164(raw: string, countryCode: number): string {
  const s = raw.trim().replace(/[\s().-]/g, "");
  if (/^\+\d{6,15}$/.test(s)) return s;
  if (/^00\d{6,15}$/.test(s)) return `+${s.slice(2)}`;
  if (/^0\d{6,14}$/.test(s)) return `+${countryCode}${s.slice(1)}`;
  if (/^[1-9]\d{7,14}$/.test(s)) return `+${s}`;
  return raw;
}

/**
 * The caller's number as the person answering would read it off the screen: national and
 * grouped for the home country (07700 900461, 020 7946 0018), E.164 for others, else "withheld".
 */
export function spokenNumber(from: string, countryCode: number): string {
  const e164 = toE164(from, countryCode);
  if (!e164.startsWith("+")) return "withheld";
  const home = `+${countryCode}`;
  if (!e164.startsWith(home)) return e164;
  const n = `0${e164.slice(home.length)}`;
  // UK groupings; other national numbers are left ungrouped.
  if (countryCode !== 44 || n.length !== 11) return n;
  if (n.startsWith("02")) return `${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)}`;
  if (/^0[389]/.test(n)) return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  return `${n.slice(0, 5)} ${n.slice(5)}`;
}
