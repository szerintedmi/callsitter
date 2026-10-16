// The terms and the privacy notice (/terms, /privacy; public.ts): two short plain pages in the public
// pages' look (listen.ts head, top). They name nobody: "I" am whoever runs the site, reachable through
// the GitHub repository. Every statement here follows what the code does; change them together.
import { head, legal, rootCss, top, topCss } from "./listen";

const REPO = "https://github.com/szerintedmi/callsitter";
const UPDATED = "16 October 2026";

const css = `
.lg{max-width:640px;margin:0 auto;padding:28px 0 40px;font-size:17px;line-height:1.5}
.lg h1{font-family:var(--disp);font-weight:400;font-size:56px;line-height:.9;letter-spacing:.03em;color:var(--amb);text-shadow:3px 3px 0 #000;margin:0 0 4px}
.lg h2{font-family:var(--disp);font-weight:400;font-size:28px;line-height:1;letter-spacing:.03em;margin:28px 0 8px}
.lg p,.lg li{margin:0 0 10px}
.lg ul{padding-left:22px;margin:0 0 10px}
.lg .upd{color:var(--dim);font-size:15px;margin-bottom:20px}
.lg a{color:var(--amb)}
@media (max-width:640px){.lg{padding:20px 16px 32px;font-size:16px}.lg h1{font-size:44px}}
`;

const page = (base: string, title: string, description: string, wastedSeconds: number, body: string) =>
  `${head(`${title} · CallSitter`, description, rootCss + topCss + css)}
<body>
<div class="rc-col">
${top(base, wastedSeconds, { botLink: false })}
<main class="lg">
<h1>${title.toUpperCase()}</h1>
<p class="upd">Last updated ${UPDATED}</p>
${body}
</main>
${legal(base)}
</div>
</body>
</html>`;

export const termsPage = (base: string, o: { wastedSeconds: number }) =>
  page(
    base,
    "Terms",
    "The terms of use of CallSitter, a hobby project.",
    o.wastedSeconds,
    `<p>CallSitter is a hobby project run by one person. By using this site you agree to these terms. If you don't, please don't use it.</p>
<h2>WHAT THIS IS</h2>
<p>The site plays recordings of real calls answered by a bot, and lets you call the bot from your browser as a game. It is provided as is, for fun, with no warranty of any kind, and it may change, break or go away at any time.</p>
<h2>CALLING THE BOT</h2>
<ul>
<li>Use the game only to play it. Don't try to break the site, run up its bills, or use the bot for anything illegal or abusive.</li>
<li>Calls are limited in number, length and daily spend, and may be cut off or refused at any time.</li>
<li>Calls are recorded and transcribed. See the <a href="${base}privacy">privacy notice</a>.</li>
<li>The bot is an AI. What it says is not advice, and it may say odd or wrong things.</li>
</ul>
<h2>CONTENT</h2>
<p>The recordings on this site are of real calls, edited to protect the people in them. All rights reserved: you may link to them, but don't copy, republish or reuse them, or use them to harass anyone. The site's code is open source under the <a href="${REPO}/blob/main/LICENSE">Apache License 2.0</a>; the recordings, the CallSitter name and the logo are not part of it.</p>
<h2>LIABILITY</h2>
<p>To the extent the law allows, I am not liable for any loss or damage from using this site. You use it at your own risk.</p>
<h2>CHANGES AND CONTACT</h2>
<p>I may update these terms by editing this page. Questions go to the project's <a href="${REPO}">GitHub repository</a>.</p>`,
  );

export const privacyPage = (base: string, o: { wastedSeconds: number }) =>
  page(
    base,
    "Privacy",
    "What CallSitter keeps about its visitors and why.",
    o.wastedSeconds,
    `<p>CallSitter is a hobby project run by one person. This is what the site keeps about you, and why.</p>
<h2>CALLS TO THE BOT</h2>
<p>When you call the bot from your browser, the call is recorded and transcribed, and kept with the player name you typed, the time, the outcome of the game and your IP address (used to limit calls). The audio is processed live by OpenAI and the transcript by other AI vendors to run the bot. I may listen to calls to improve it. Calls are kept for as long as the project runs; I won't publish them with anything that identifies you.</p>
<h2>VISITS</h2>
<p>The site has its own simple analytics: which pages and recordings get played, clicks and referrers, together with your IP address, browser, language and the country and city your connection comes from. No cookies and no third-party trackers; a random id per tab tells one visit from another. Analytics rows are deleted after 180 days, and server logs after 30 days.</p>
<h2>EMAIL</h2>
<p>If you join the waitlist or ask to be told when the game is back, your email address is kept for that purpose only and never shared.</p>
<h2>YOUR BROWSER</h2>
<p>Your player name and game choice are saved in your browser's local storage so you don't have to type them again. Clear your site data to remove them.</p>
<h2>WHERE AND WITH WHOM</h2>
<p>The site runs on a server in the EU behind Cloudflare, which sees all traffic to it. The AI vendors that run the bot receive the audio and text of your call. Nothing is sold or used for advertising.</p>
<h2>YOUR RIGHTS</h2>
<p>You can ask me to delete a call, your email address or anything else the site keeps about you by opening an issue in the project's <a href="${REPO}">GitHub repository</a>. I may update this notice by editing this page.</p>`,
  );
