const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

// The agent page and its console, checked without a browser: the page's words, its ids, its imports, and the rules the
// console's code must keep (no HTML from strings, no network of its own, no inline script).
describe("Agent page and console (web/agent.html, web/js/agent.js, web/js/agent/*)", () => {
  const web = path.join(__dirname, "../web");
  const read = (p) => fs.readFileSync(path.join(web, p), "utf8");
  const html = read("agent.html");
  const agentJs = read("js/agent.js");
  const consoleJs = read("js/agent/console.js");
  const dir = fs.readdirSync(path.join(web, "js/agent")).filter((f) => f.endsWith(".js"));
  const PURE = dir.filter((f) => f !== "console.js");
  let P;
  before(async () => {
    P = await import("../web/js/agent/policy.js");
  });

  describe("the page's words", () => {
    it("no longer says the agent can move nothing in every mode; says what is true", () => {
      expect(html).to.not.include("In no mode can the agent move");
      expect(html).to.include(P.SAFETY_TEXT);
      expect(html).to.include("Approvals you gave other apps still stand");
    });
    it("carries the three mode texts exactly, and no longer says the software 'isn't released yet'", () => {
      for (const lv of [1, 2, 3]) expect(html, `mode ${lv}`).to.include(`<span>${P.MODE_TEXT[lv]}</span>`);
      expect(html).to.not.match(/isn't released yet/);
      expect(html).to.include("Recommended.");
    });
    it("never calls Assisted free", () => {
      const assisted = html.slice(html.indexOf('data-l="2"'), html.indexOf('data-l="3"'));
      expect(assisted).to.not.match(/\bfree\b/i);
      expect(consoleJs).to.not.match(/Assisted[^\n]*\bfree\b/i);
    });
    it("has the two robot links next to the existing ones", () => {
      expect(html).to.match(/id="arLink"[^>]*>Bring it to life \(AR\)</);
      expect(html).to.match(/id="buildLink"[^>]*>Build it for real</);
      expect(agentJs).to.include("arLink(id)");
      expect(agentJs).to.include('buildLink(attr(meta, "Class"))');
    });
    it("every limit confirmation carries the 'up to twice across the reset' note", () => {
      // the three places that ask the holder to confirm a limit all build their text with limitNote()
      const uses = consoleJs.match(/limitNote\(/g) || [];
      expect(uses.length).to.be.at.least(3); // own software, Assisted setup, the running panel
      expect(consoleJs).to.match(/configure\(address, lv, limitWei/);
      expect(consoleJs).to.match(/\.configure\(rec\.address, 2, limitWei/);
    });
    it("the built-in key offers no 0.5 ETH; own software may", () => {
      expect(consoleJs).to.match(/BUILTIN_LIMITS\.map/);
      expect(consoleJs).to.match(/OWN_SOFTWARE_LIMITS\.map/);
      expect(html).to.not.include('value="0.5"');
    });
    it("Autonomous needs the last 4 characters of the agent wallet typed (with no answer in the placeholder), and the operator address sits behind 'Use my own agent software'", () => {
      expect(consoleJs).to.include("L3_PLACEHOLDER");
      expect(consoleJs).to.match(/l3Confirmation\(/);
      expect(consoleJs).to.not.include("Type ${page.id}");
      expect(consoleJs).to.not.include('replace(/\\D/g'); // no lenient digit-stripping
      expect(consoleJs).to.include("Use my own agent software");
      expect(html).to.not.include('id="operator"');
      expect(html).to.not.include("applyMode");
    });
  });

  describe("security review fixes", () => {
    it("H1a: the setup prompt and the running panel say what the key can really do", () => {
      expect(consoleJs).to.match(/KEY_RISK_TEXT/);
      expect(consoleJs).to.not.match(/The key may only: \(1\)/);
      expect(consoleJs).to.not.match(/to itself, for gas/);
    });
    it("H1b: the passphrase fields ask for 12+ characters", () => {
      expect(consoleJs).to.include("Passphrase (12+ characters)");
      expect(consoleJs).to.not.include("10+ characters");
    });
    it("H1c: the key locks again on Stop, on forget, when the agent is switched to Manual, and when idle", () => {
      expect(consoleJs).to.match(/createIdleLock\(/);
      expect(consoleJs).to.match(/function relock\(/);
      expect(consoleJs).to.match(/wallet = null/);
      const stop = consoleJs.slice(consoleJs.indexOf("async function stopRunner"), consoleJs.indexOf("// the key sends its own ETH back"));
      expect(stop).to.match(/await runner\.stop\(\)/);
      expect(consoleJs).to.match(/active \? relock\(/); // the Stop button
    });
    it("H2: sweeping stops the runner first and goes through the gate; sends wait with a timeout and report their block", () => {
      const at = consoleJs.indexOf("async function sweepKey");
      const sweep = consoleJs.slice(at, consoleJs.indexOf("// ----", at));
      expect(sweep).to.match(/await stopRunner\(\)/);
      expect(sweep).to.match(/gate\.run\(/);
      expect(sweep).to.match(/withTimeout\(/);
      expect(consoleJs).to.match(/withTimeout\(tx\.wait\(\)/);
      expect(consoleJs).to.match(/blockNumber: receipt\.blockNumber/);
      expect(consoleJs).to.match(/\n {6}gate,\n/); // the runner shares the console's gate
    });
    it("M1: the balance to keep is parsed in one place, rejecting negatives", () => {
      expect(consoleJs).to.not.match(/parseEther\(keep\.value/);
      expect(consoleJs.match(/parseKeep\(/g).length).to.be.at.least(2); // the setup form and the saved value
    });
    it("M2: own-software prompts carry the rule, check the address, and Autonomous is not pre-filled", () => {
      expect(consoleJs).to.match(/OPERATOR_RULE/);
      expect(consoleJs).to.match(/checkOperator\(/);
      expect(consoleJs).to.match(/getCode\(/);
      expect(consoleJs).to.match(/lv === 3 \? "" :/);
    });
    it("M3: an imported file shows its address and the warning before it is stored", () => {
      expect(consoleJs).to.match(/Import only a file you exported yourself/);
      expect(consoleJs).to.match(/putRecord\(/);
    });
    it("M4: proposals are decoded with the project's own contracts as the only trusted targets", () => {
      expect(agentJs).to.match(/trusted: \[acctAddr, CONFIG\.agents, CONFIG\.reputation, CONFIG\.renderer\]/);
    });
    it("L: the activity log shows where each action went; the pane is not rebuilt under a half-typed field", () => {
      expect(consoleJs).to.match(/ETH to \$\{a\.to\}/);
      expect(consoleJs).to.match(/renderPane\(force\)/);
    });
    it("L: the journal says what a signature means, not that nothing was edited", () => {
      expect(consoleJs).to.not.match(/has not been edited/);
      expect(consoleJs).to.match(/the holder signed this head/i);
      expect(consoleJs).to.match(/unchanged since saved in this browser/i);
      expect(read("js/agent/journal.js")).to.not.match(/prove it was not edited/);
    });
    it("L: the page reads token metadata through cleanMeta", () => {
      expect(agentJs).to.match(/cleanMeta\(/);
    });
  });

  describe("security of the page", () => {
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
    it("keeps the strict CSP: no inline script, nothing new to connect to", () => {
      expect(csp).to.include("script-src 'self';");
      expect(csp).to.not.match(/script-src[^;]*'unsafe-(inline|eval)'/);
      expect(csp).to.include("connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*;");
      expect(csp).to.include("object-src 'none'");
      expect(html.match(/<script\b[^>]*>/g)).to.deep.equal(['<script src="js/theme-boot.js">', '<script type="module" src="js/agent.js">']);
      expect(html).to.not.match(/\son[a-z]+\s*=/i);
    });
    it("builds no HTML from strings anywhere in the page script or the console", () => {
      for (const [name, src] of [["agent.js", agentJs], ...dir.map((f) => [f, read(`js/agent/${f}`)])]) {
        expect(src, name).to.not.match(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
      }
    });
    it("the console has no network of its own (the page's RPC and wallet only)", () => {
      for (const f of dir) expect(read(`js/agent/${f}`), f).to.not.match(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/);
    });
    it("the pure modules import neither the page chrome nor ethers (they run in Node, in tests)", () => {
      for (const f of PURE) expect(read(`js/agent/${f}`), f).to.not.match(/from "\.\.\/(chain|config|servers|theme)\.js"|vendor\/ethers/);
    });
    it("a key is never written in plaintext: no localStorage/sessionStorage near a private key", () => {
      expect(consoleJs).to.not.match(/privateKey/);
      expect(read("js/agent/keystore.js")).to.not.match(/localStorage|sessionStorage/);
    });
  });

  describe("wiring", () => {
    const ids = (src) => [...src.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]);
    it("every id the scripts look up exists in agent.html", () => {
      for (const [name, src] of [["agent.js", agentJs], ["console.js", consoleJs]]) {
        for (const id of new Set(ids(src))) expect(html, `${name}: #${id}`).to.match(new RegExp(`id="${id}"`));
      }
    });
    it("every name the page script and the console import exists in the module it comes from", async () => {
      const chain = read("js/chain.js");
      const exportsOf = async (rel, from) => {
        const file = path.join(path.dirname(path.join(web, from)), rel);
        if (rel.endsWith("chain.js")) return new Set([...chain.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)].map((m) => m[1]));
        if (rel.endsWith("config.js")) return new Set(["CONFIG"]);
        return new Set(Object.keys(await import(require("node:url").pathToFileURL(file).href)));
      };
      for (const [from, src] of [["js/agent.js", agentJs], ["js/agent/console.js", consoleJs]]) {
        for (const m of src.matchAll(/import \{([^}]+)\} from "([^"]+)"/g)) {
          const have = await exportsOf(m[2], from);
          for (const n of m[1].split(",").map((x) => x.trim().split(" as ")[0]).filter(Boolean)) expect(have.has(n), `${from} imports ${n} from ${m[2]}`).to.equal(true);
        }
      }
    });
    it("agent.html announces the modules agent.js loads at start (the build keeps this block in step)", () => {
      for (const m of ["links.js", "policy.js", "decode.js", "dom.js"]) expect(html).to.include(`<link rel="modulepreload" href="js/agent/${m}">`);
      expect(html).to.not.include("agent/console.js"); // loaded when the holder is here, not for visitors
      expect(agentJs).to.match(/import\("\.\/agent\/console\.js"\)/);
    });
    it("the console is for the holder: it mounts only when the connected wallet owns the agent", () => {
      expect(agentJs).to.match(/if \(mine\) consoleReady \?\?= startConsole\(\)/);
    });
  });

  describe("dom.paneBusy (the 60-second refresh must not wipe what is being typed)", () => {
    let paneBusy;
    before(async () => {
      ({ paneBusy } = await import("../web/js/agent/dom.js"));
    });
    const field = (o) => ({ tagName: "INPUT", type: "text", value: "", defaultValue: "", ...o });
    const pane = (fields, focus = null) => ({ contains: (e) => fields.includes(e), querySelectorAll: () => fields, _doc: { activeElement: focus } });
    const busy = (fields, focus) => {
      const p = pane(fields, focus);
      return paneBusy(p, p._doc);
    };
    it("is idle when every field still holds what the page put there", () => {
      expect(busy([field({ value: "0x1", defaultValue: "0x1" }), field({})])).to.equal(false);
      expect(busy([])).to.equal(false);
      expect(paneBusy(null)).to.equal(false);
    });
    it("is busy when a field holds something typed, a file was chosen, or a choice changed", () => {
      expect(busy([field({ value: "hunter2 hunter2", type: "password" })])).to.equal(true);
      expect(busy([field({ type: "file", files: [{}] })])).to.equal(true);
      expect(busy([field({ type: "file", files: [] })])).to.equal(false);
      expect(busy([{ tagName: "SELECT", options: [{ selected: true, defaultSelected: false }] }])).to.equal(true);
      expect(busy([{ tagName: "SELECT", options: [{ selected: true, defaultSelected: true }] }])).to.equal(false);
    });
    it("is busy while focus is inside the pane", () => {
      const f = field({});
      expect(busy([f], f)).to.equal(true);
      expect(busy([f], {})).to.equal(false);
    });
    it("the console uses it before it rebuilds the pane on its own", () => {
      expect(consoleJs).to.match(/paneBusy\(pane\)/);
    });
  });

  describe("dom.h", () => {
    let h;
    before(async () => {
      ({ h } = await import("../web/js/agent/dom.js"));
    });
    const fake = () => {
      const make = () => ({ attrs: {}, kids: [], listeners: {}, className: "", setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.listeners[k] = f; }, append(...k) { this.kids.push(...k); } });
      globalThis.document = { createElement: () => make() };
    };
    afterEach(() => delete globalThis.document);
    it("sets text as text (a string that looks like HTML stays a string), skips false/null, wires handlers", () => {
      fake();
      const fn = () => {};
      const e = h("div", { class: "x", onclick: fn, hidden: true, disabled: false, title: null, "data-n": 3 }, "<img src=x onerror=alert(1)>", ["a", null, ["b"]], false);
      expect(e.className).to.equal("x");
      expect(e.listeners.click).to.equal(fn);
      expect(e.attrs).to.deep.equal({ hidden: "", "data-n": "3" });
      expect(e.kids).to.deep.equal(["<img src=x onerror=alert(1)>", "a", "b"]);
    });
  });

  describe("docs/18-FEASIBILITY.md", () => {
    const doc = fs.readFileSync(path.join(__dirname, "../docs/18-FEASIBILITY.md"), "utf8");
    const row = (start) => doc.split("\n").find((l) => l.startsWith(`| ${start}`));
    it("splits the agent-mode row into the five honest ones", () => {
      expect(row("Manual mode suggests, you act")).to.match(/\| Today once shipped \|/);
      expect(row("Assisted mode refuels its gas and sweeps surplus to you while the page is open")).to.match(/\| Today once shipped \|/);
      expect(row("Assisted mode refuels")).to.match(/caps the key at the daily limit/);
      expect(row("Assisted mode refuels")).to.match(/enforced by the page/);
      expect(row("Assisted mode refuels")).to.not.match(/two fixed actions/);
      expect(row("Autonomous mode for your own software")).to.match(/\| Today at contract level \|/);
      expect(row("Always-on agent on your computer")).to.match(/\| Groundwork \|/);
      expect(row("Assisted practice journal, never verified")).to.match(/\| Today once shipped \|/);
      expect(doc).to.not.include("| Assisted and Autonomous modes |");
    });
  });
});
