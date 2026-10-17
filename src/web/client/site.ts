// The public site's plain pages (src/web/listen.ts botPage, src/web/legal.ts): page analytics
// (track.ts: the view, links, [data-track]) and the bot page's waitlist form.

import { startTracking, track } from "./track";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const base = document.body.dataset.base || "/";
startTracking(base);

const form = $<HTMLFormElement>("wl"), input = $<HTMLInputElement>("wl-in"), ok = $<HTMLButtonElement>("wl-ok"), err = $("wl-err");
if (form && input && ok && err) {
  const fail = (m: string) => {
    err.textContent = m;
    err.hidden = false;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = input.value.trim();
    err.hidden = true;
    if (!email) return input.focus();
    ok.disabled = true;
    try {
      const r = await fetch(`${base}call/waitlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      track("click", { action: "waitlist", target: r.ok ? "ok" : `http_${r.status}` });
      if (r.ok) {
        form.hidden = true;
        $("wl-done")!.hidden = false;
      } else fail(((await r.json().catch(() => ({}))) as { message?: string }).message || "Something went wrong.");
    } catch {
      track("click", { action: "waitlist", target: "offline" });
      fail("Couldn't send. Try again.");
    } finally {
      ok.disabled = false;
    }
  });
  // Enabled only now: without the script, submitting would put the email in a URL.
  ok.disabled = false;
}
