import { describe, expect, test } from "bun:test";
import { buildClient } from "../src/runtime/client-assets";

const testCallJs = (await buildClient()).get("test-call.js")!;

// Runs the test-call page script against a fake DOM and a fake Telnyx SDK, to check the SIP
// route never leaves the page stuck (buttons disabled, stale status) whatever fails.

class El {
  textContent = "";
  innerHTML = "";
  disabled = false;
  value = "";
  checked = true;
  className = "";
  scrollTop = 0;
  scrollHeight = 0;
  style: Record<string, string> = {};
  childNodes: El[] = [];
  onclick: ((e: { preventDefault(): void }) => void) | null = null;
  appendChild(c: El) {
    this.childNodes.push(c);
    return c;
  }
  removeChild(c: El) {
    this.childNodes = this.childNodes.filter((x) => x !== c);
  }
  remove() {}
  addEventListener() {}
  querySelector() {
    return new El();
  }
}

class FakeCall {
  hungUp = false;
  state = "new";
  constructor(readonly opts: any) {}
  hangup() {
    this.hungUp = true;
  }
}

class FakeRtc {
  static last: FakeRtc | null = null;
  handlers = new Map<string, (e: any) => void>();
  call: FakeCall | null = null;
  disconnected = false;
  constructor(readonly opts: any) {
    FakeRtc.last = this;
  }
  on(ev: string, fn: (e: any) => void) {
    this.handlers.set(ev, fn);
  }
  connect() {}
  disconnect() {
    this.disconnected = true;
    this.handlers.get("telnyx.socket.close")?.({});
  }
  newCall(opts: any) {
    return (this.call = new FakeCall(opts));
  }
  emit(ev: string, e: any = {}) {
    this.handlers.get(ev)!(e);
  }
  state(state: string, extra: Record<string, unknown> = {}) {
    if (this.call) this.call.state = state;
    this.emit("telnyx.notification", { type: "callUpdate", call: { state, ...extra } });
  }
}

function page(opts: { tokenStatus?: number } = {}) {
  const els = new Map<string, El>();
  const el = (id: string) => {
    if (!els.has(id)) els.set(id, new El());
    return els.get(id)!;
  };
  el("route").value = "sip";
  el("hangup").disabled = true;
  const document = { getElementById: el, createElement: () => new El(), head: new El(), currentScript: { src: "/assets/test-call.js?v=abc" } };
  const window: any = { TelnyxWebRTC: { TelnyxRTC: FakeRtc }, addEventListener() {}, removeEventListener() {} };
  const fetch = async (url: string) => {
    if (url === "/test-call/sip") {
      const status = opts.tokenStatus ?? 200;
      const body =
        status === 200
          ? { token: "t", nonce: "n1", header: "X-CallSitter-Test", dial: "callsittertestn1", sipUri: "sip:proj_x@sip.api.openai.com;transport=tls" }
          : { error: "no credential" };
      return { ok: status === 200, status, json: async () => body };
    }
    if (url.startsWith("/debug/log")) return { ok: true, json: async () => ({ lines: [], last: 0 }) };
    return { ok: true, json: async () => ({ callId: null }) };
  };
  const timers: ReturnType<typeof setInterval>[] = [];
  const setIntervalT = (fn: () => void, ms: number) => {
    const t = setInterval(fn, ms);
    timers.push(t);
    return t;
  };
  const location = { protocol: "http:", host: "localhost" };
  new Function("window", "document", "fetch", "location", "setInterval", "WebSocket", "navigator", testCallJs)(
    window,
    document,
    fetch,
    location,
    setIntervalT,
    class {},
    {},
  );
  const log = () => el("debuglog").childNodes.map((c) => c.textContent).join("\n");
  const idle = () => !el("start").disabled && el("hangup").disabled && !el("route").disabled;
  return { el, log, idle, done: () => timers.forEach(clearInterval) };
}

const tick = () => Bun.sleep(10);

describe("test-call page, SIP route", () => {
  test("token request fails → error shown and logged, page usable again", async () => {
    const p = page({ tokenStatus: 404 });
    p.el("start").onclick!({ preventDefault() {} });
    await tick();
    expect(p.el("status").textContent).toContain("no credential");
    expect(p.log()).toContain("no credential");
    expect(p.el("debugcount").textContent).toContain("1 error");
    expect(p.idle()).toBe(true);
    p.done();
  });

  test("hang up while the call is stuck on 'trying' → call hung up, page reset", async () => {
    const p = page();
    p.el("start").onclick!({ preventDefault() {} });
    await tick();
    const rtc = FakeRtc.last!;
    rtc.emit("telnyx.ready");
    rtc.state("trying");
    expect(p.el("status").textContent).toBe("SIP call: trying");
    expect(p.el("hangup").disabled).toBe(false);
    const call = rtc.call!;
    p.el("hangup").onclick!({ preventDefault() {} });
    // The page resets at once; the SDK teardown runs just after (outside any SDK callback).
    expect(p.el("status").textContent).toBe("hung up");
    expect(p.idle()).toBe(true);
    await tick();
    expect(call.hungUp).toBe(true);
    expect(rtc.disconnected).toBe(true);
    // Our own disconnect's socket-close and a late hangup update don't log a second end.
    rtc.state("hangup", { cause: "NORMAL_CLEARING" });
    expect(p.log().match(/hung up|call ended/g)?.length).toBe(1);
    p.done();
  });

  test("dials the parking destination with the nonce header", async () => {
    const p = page();
    p.el("start").onclick!({ preventDefault() {} });
    await tick();
    FakeRtc.last!.emit("telnyx.ready");
    expect(FakeRtc.last!.call!.opts).toMatchObject({ destinationNumber: "callsittertestn1", customHeaders: [{ name: "X-CallSitter-Test", value: "n1" }] });
    p.el("hangup").onclick!({ preventDefault() {} });
    p.done();
  });

  test("an SDK that re-emits hangup when an ended call is hung up doesn't loop", async () => {
    const p = page();
    p.el("start").onclick!({ preventDefault() {} });
    await tick();
    const rtc = FakeRtc.last!;
    rtc.emit("telnyx.ready");
    let reemits = 0;
    // Like the real SDK: hangup() on an ended call emits hangup + destroy again, synchronously.
    rtc.call!.hangup = function () {
      if (++reemits > 50) throw new Error("hangup loop");
      rtc.state("hangup", { cause: "NORMAL_CLEARING" });
      rtc.state("destroy", { cause: "NORMAL_CLEARING" });
    };
    rtc.disconnect = function () {
      this.disconnected = true;
      this.call?.hangup();
    };
    rtc.state("trying");
    rtc.state("hangup", { cause: "UNALLOCATED_NUMBER", sipCode: 404 });
    await tick();
    expect(reemits).toBeLessThan(3);
    expect(p.idle()).toBe(true);
    expect(p.el("status").textContent).toContain("SIP 404");
    p.done();
  });

  test("far end rejects → cause and SIP code shown, page reset", async () => {
    const p = page();
    p.el("start").onclick!({ preventDefault() {} });
    await tick();
    const rtc = FakeRtc.last!;
    rtc.emit("telnyx.ready");
    rtc.state("trying");
    rtc.state("hangup", { cause: "CALL_REJECTED", causeCode: 21, sipCode: 488, sipReason: "Not Acceptable Here" });
    expect(p.el("status").textContent).toContain("SIP 488 Not Acceptable Here");
    expect(p.log()).toContain("cause CALL_REJECTED (21)");
    expect(p.idle()).toBe(true);
    p.done();
  });

  test("Telnyx error → page reset with the error", async () => {
    const p = page();
    p.el("start").onclick!({ preventDefault() {} });
    await tick();
    FakeRtc.last!.emit("telnyx.error", { error: { message: "Login failed" } });
    expect(p.el("status").textContent).toBe("Telnyx error: Login failed");
    expect(p.idle()).toBe(true);
    p.done();
  });
});
