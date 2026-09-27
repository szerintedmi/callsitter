import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The call pages' call info panel (src/web/client/call-info.ts) against a fake DOM. Its only
// import is a type, so it runs as a plain script once its `export`s are dropped.
const source = new Bun.Transpiler({ loader: "ts" })
  .transformSync(readFileSync(new URL("../src/web/client/call-info.ts", import.meta.url), "utf8"))
  .replace(/^export /gm, "");

class El {
  className = "";
  textContent = "";
  open = false;
  children: El[] = [];
  constructor(readonly tag: string) {}
  set innerHTML(v: string) {
    if (v) throw new Error("innerHTML with content");
    this.children = [];
  }
  appendChild(c: El) {
    this.children.push(c);
    return c;
  }
  addEventListener() {}
  all(tag: string): El[] {
    return this.children.flatMap((c) => [...(c.tag === tag ? [c] : []), ...c.all(tag)]);
  }
  text(): string[] {
    return this.children.flatMap((c) => [...(c.textContent ? [c.textContent] : []), ...c.text()]);
  }
}

function panel() {
  const ctx: Record<string, any> = { document: { createElement: (tag: string) => new El(tag) } };
  runInNewContext(source + "\nthis.createCallInfo = createCallInfo;", ctx);
  const root = new El("div");
  return { root, info: ctx.createCallInfo(root) };
}

const headers = (at: number, headers: { name: string; value: string }[], info?: Record<string, string>) => ({ type: "sip.headers", callId: "c1", at, source: "telnyx", headers, info });

test("renders each header set once, whether it came stored or live, as text", () => {
  const { root, info } = panel();
  expect(root.children).toEqual([]);
  const diversion = headers(0, [{ name: "Diversion", value: "<sip:+447700900111@x>;reason=no-answer" }]);
  info.add(diversion);
  info.add(diversion); // the live copy of a stored event
  info.add(headers(5, [{ name: "X-Test", value: "<b>hi</b>" }, { name: "From", value: "a" }]));
  expect(root.all("summary")[0]!.textContent).toBe("Call info (3 SIP headers)");
  expect(root.all("td").map((td) => td.textContent)).toEqual(["<sip:+447700900111@x>;reason=no-answer", "<b>hi</b>", "a"]);
  info.clear();
  expect(root.children).toEqual([]);
});

test("says when no SIP headers arrived, and shows the carrier's metadata and hangup", () => {
  const { root, info } = panel();
  info.add(headers(0, [], { calling_party_type: "pstn" }));
  info.add({ type: "carrier.hangup", callId: "c1", at: 90_000, source: "telnyx", info: { hangup_cause: "normal_clearing", hangup_source: "caller" } });
  expect(root.all("summary")[0]!.textContent).toBe("Call info (no SIP headers)");
  const text = root.text();
  expect(text).toContain("no SIP headers received");
  expect(text).toContain("hangup, from Telnyx (call.hangup)");
  expect(root.all("th").map((th) => th.textContent)).toEqual(["calling_party_type", "hangup_cause", "hangup_source"]);
});
