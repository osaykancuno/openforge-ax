const { expect } = require("chai");
const http = require("node:http");

// AI Pilot model client (web/js/pilot/ai/model-client.js) against a fake OpenAI-compatible server on 127.0.0.1:0
// (what Ollama, LM Studio and llama-server expose). The model is untrusted: this layer only moves bytes, caps them
// and finds the plan in them; tools.js validates it.
describe("AI Pilot model client (web/js/pilot/ai/model-client.js)", () => {
  let MC, T, AP, P, D, TT;
  before(async () => {
    MC = await import("../web/js/pilot/ai/model-client.js");
    T = await import("../web/js/pilot/ai/tools.js");
    AP = await import("../web/js/pilot/ai/ai-pilot.js");
    P = await import("../web/js/pilot/ax-proto.js");
    D = await import("../web/js/pilot/drive-loop.js");
    TT = await import("../web/js/pilot/twin-transport.js");
  });

  const servers = [];
  /** Fake server. handler(req, res, body, n). Records every request (method, url, headers, parsed body, closed). */
  function fakeServer(handler) {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {}
        const rec = { method: req.method, url: req.url, headers: req.headers, body, closed: false };
        server.requests.push(rec);
        res.on("close", () => (rec.closed = !res.writableFinished));
        handler(req, res, body, server.requests.length - 1, rec);
      });
    });
    server.requests = [];
    servers.push(server);
    return new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        server.url = `http://127.0.0.1:${server.address().port}`;
        resolve(server);
      }),
    );
  }
  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop();
      s.closeAllConnections && s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  });

  const json = (res, obj, status = 200) => {
    const s = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
    res.end(s);
  };
  const completion = (message) => ({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: null, ...message }, finish_reason: "stop" }] });
  const call = (name, args, asString = true) => ({ id: `c_${name}`, type: "function", function: { name, arguments: asString ? JSON.stringify(args) : args } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MESSAGES = [{ role: "system", content: "sys" }, { role: "user", content: "forward 1.5 seconds" }];
  const ctx = () => ({ tools: T.toolsFor("rover"), messages: MESSAGES });

  describe("plan()", () => {
    it("POSTs /v1/chat/completions with tools, tool_choice auto, stream false, and no credentials", async () => {
      const s = await fakeServer((req, res) => json(res, completion({ tool_calls: [call("drive", { direction: "forward", seconds: 1.5 })] })));
      const client = MC.createModelClient({ url: s.url, model: "qwen2.5:3b" });
      const r = await client.plan(ctx());
      const q = s.requests[0];
      expect(q.method).to.equal("POST");
      expect(q.url).to.equal("/v1/chat/completions");
      expect(q.headers["content-type"]).to.match(/application\/json/);
      expect(q.headers).to.not.have.property("authorization");
      expect(q.headers).to.not.have.property("cookie");
      expect(q.body.model).to.equal("qwen2.5:3b");
      expect(q.body.stream).to.equal(false);
      expect(q.body.tool_choice).to.equal("auto");
      expect(q.body.tools.map((t) => t.function.name)).to.have.members(["wait", "say", "stop", "drive", "turn", "look"]);
      expect(q.body.messages).to.deep.equal(MESSAGES);
      expect(q.body.temperature).to.be.at.most(0.5);
      expect(r.via).to.equal("tool_calls");
      expect(r.steps).to.deep.equal([{ tool: "drive", args: { direction: "forward", seconds: 1.5 } }]);
    });

    it("uses the injected fetch with the hardened options (no cookies, no referrer, no redirects, no cache)", async () => {
      let seen = null;
      const fetch = async (url, opts) => ((seen = { url, opts }), new Response(JSON.stringify(completion({ content: "hi" })), { status: 200 }));
      const client = MC.createModelClient({ url: "http://localhost:11434/", model: "m", fetch });
      await client.plan(ctx());
      expect(seen.url).to.equal("http://localhost:11434/v1/chat/completions");
      expect(seen.opts).to.include({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      expect(typeof seen.opts.signal).to.equal("object");
    });

    it("arguments may be a JSON string or an object; content next to tool_calls becomes the say text", async () => {
      const s = await fakeServer((req, res) =>
        json(res, completion({ content: "On my way.", tool_calls: [call("drive", { direction: "forward", seconds: 2 }, false), call("turn", { degrees: -90 }, true), call("wait", { seconds: 1 })] })),
      );
      const r = await MC.createModelClient({ url: s.url, model: "m" }).plan(ctx());
      expect(r.say).to.equal("On my way.");
      expect(r.steps.map((x) => x.tool)).to.deep.equal(["drive", "turn", "wait"]);
      expect(r.steps[0].args).to.deep.equal({ direction: "forward", seconds: 2 });
      expect(r.steps[1].args).to.deep.equal({ degrees: -90 });
      // the same plan survives validation unchanged in meaning
      expect(T.validatePlan(r.steps, "rover").steps.map((x) => x.tool)).to.deep.equal(["drive", "turn", "wait"]);
    });

    it("broken arguments JSON on one call leaves that call without args (validation rejects it), the rest is kept", async () => {
      const s = await fakeServer((req, res) => json(res, completion({ tool_calls: [{ type: "function", function: { name: "drive", arguments: "{direction: forward" } }, call("wait", { seconds: 1 })] })));
      const r = await MC.createModelClient({ url: s.url, model: "m" }).plan(ctx());
      expect(r.steps).to.have.length(2);
      const v = T.validatePlan(r.steps, "rover");
      expect(v.steps.map((x) => x.tool)).to.deep.equal(["wait"]);
      expect(v.rejected).to.have.length(1);
    });

    it("fallback: {say, steps} in the content", async () => {
      const content = JSON.stringify({ say: "Sure!", steps: [{ tool: "drive", direction: "forward", seconds: 1 }, { name: "turn", arguments: { degrees: 90 } }] });
      const s = await fakeServer((req, res) => json(res, completion({ content })));
      const r = await MC.createModelClient({ url: s.url, model: "m" }).plan(ctx());
      expect(r.via).to.equal("content");
      expect(r.say).to.equal("Sure!");
      expect(T.validatePlan(r.steps, "rover").steps.map((x) => x.tool)).to.deep.equal(["drive", "turn"]);
    });

    it("fallback: <tool_call> blocks (Qwen style), one per call", async () => {
      const content = 'Okay.\n<tool_call>\n{"name": "drive", "arguments": {"direction": "forward", "seconds": 1}}\n</tool_call>\n<tool_call>{"name":"look","arguments":{"pan":30}}</tool_call>';
      const s = await fakeServer((req, res) => json(res, completion({ content })));
      const r = await MC.createModelClient({ url: s.url, model: "m" }).plan(ctx());
      expect(r.via).to.equal("content");
      expect(r.steps.map((x) => x.tool)).to.deep.equal(["drive", "look"]);
      expect(r.steps[1].args).to.deep.equal({ pan: 30 });
    });

    it("fallback: the first balanced {...} in prose or a code fence, braces inside strings do not confuse it", async () => {
      const content = 'Here is my plan: ```json\n{"say": "a } tricky { string", "steps": [{"tool": "wait", "seconds": 1}]}\n``` hope it helps {not json}';
      const s = await fakeServer((req, res) => json(res, completion({ content })));
      const r = await MC.createModelClient({ url: s.url, model: "m" }).plan(ctx());
      expect(r.via).to.equal("content");
      expect(r.say).to.equal("a } tricky { string");
      expect(r.steps).to.deep.equal([{ tool: "wait", args: { seconds: 1 } }]);
    });

    it("garbage: nothing usable means via none and no steps (the app then runs the built-in parser)", async () => {
      for (const content of ["I'm sorry, I can't move.", "{", "}{", '{"say": "x"', "[1,2,3]", "{{{{{{{{{{", "", "<tool_call>not json</tool_call>", '{"foo": 1}']) {
        const s = await fakeServer((req, res) => json(res, completion({ content })));
        const r = await MC.createModelClient({ url: s.url, model: "m" }).plan(ctx());
        expect(r.via, JSON.stringify(content)).to.equal("none");
        expect(r.steps).to.deep.equal([]);
        expect(r.text).to.be.a("string");
      }
    });

    it("extractPlan is pure and total", () => {
      expect(MC.extractPlan(null).via).to.equal("none");
      expect(MC.extractPlan(undefined).steps).to.deep.equal([]);
      expect(MC.extractPlan('{"name":"stop","arguments":{}}').steps).to.deep.equal([{ tool: "stop", args: {} }]);
      expect(MC.extractPlan('[{"tool":"stop"}]').steps).to.have.length(1);
      expect(MC.extractPlan("{".repeat(50000)).via).to.equal("none"); // no quadratic blow-up
      expect(MC.extractPlan('{"steps":"drive"}').steps).to.deep.equal([]);
    });

    it("an HTTP error is reported with its status; so are a bad JSON body and an empty answer", async () => {
      let mode = 500;
      const s = await fakeServer((req, res) => {
        if (mode === 500) return json(res, { error: { message: "model not found" } }, 404);
        if (mode === "text") return res.writeHead(200, { "content-type": "text/plain" }).end("hello");
        if (mode === "empty") return json(res, { choices: [] });
        return json(res, { nope: 1 });
      });
      const client = MC.createModelClient({ url: s.url, model: "m" });
      let e = await client.plan(ctx()).catch((x) => x);
      expect(e).to.be.instanceOf(MC.ModelError);
      expect(e.code).to.equal("http");
      expect(e.status).to.equal(404);
      expect(e.message).to.match(/404/);
      mode = "text";
      e = await client.plan(ctx()).catch((x) => x);
      expect(e.code).to.equal("bad_response");
      mode = "empty";
      e = await client.plan(ctx()).catch((x) => x);
      expect(e.code).to.equal("bad_response");
      mode = "other";
      e = await client.plan(ctx()).catch((x) => x);
      expect(e.code).to.equal("bad_response");
    });

    it("a server that is not there is a network error, not a hang", async () => {
      const s = await fakeServer(() => {});
      const url = s.url;
      await new Promise((r) => (s.closeAllConnections(), s.close(r)));
      servers.length = 0;
      const e = await MC.createModelClient({ url, model: "m", timeoutMs: 2000 }).plan(ctx()).catch((x) => x);
      expect(e).to.be.instanceOf(MC.ModelError);
      expect(e.code).to.equal("network");
    });

    it("slow server: times out after timeoutMs with code timeout", async () => {
      const s = await fakeServer(() => {}); // never answers
      const t0 = Date.now();
      const e = await MC.createModelClient({ url: s.url, model: "m", timeoutMs: 150 }).plan(ctx()).catch((x) => x);
      expect(e).to.be.instanceOf(MC.ModelError);
      expect(e.code).to.equal("timeout");
      expect(Date.now() - t0).to.be.within(100, 1500);
      expect(MC.DEFAULT_TIMEOUT_MS).to.equal(20000);
      expect(MC.DEFAULT_MAX_BYTES).to.equal(65536);
    });

    it("a body that stalls half way also times out", async () => {
      const s = await fakeServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"choices":[{"message":{"content":"');
      });
      const e = await MC.createModelClient({ url: s.url, model: "m", timeoutMs: 200 }).plan(ctx()).catch((x) => x);
      expect(e.code).to.equal("timeout");
    });

    it("caller abort: AbortError (not a model error), and the server sees the connection close", async () => {
      const s = await fakeServer(() => {});
      const ctl = new AbortController();
      const p = MC.createModelClient({ url: s.url, model: "m" }).plan({ ...ctx(), signal: ctl.signal });
      await sleep(80);
      ctl.abort();
      const e = await p.catch((x) => x);
      expect(e.name).to.equal("AbortError");
      expect(e).to.not.be.instanceOf(MC.ModelError);
      await sleep(80);
      expect(s.requests[0].closed).to.equal(true);
      // already aborted: no request is made at all
      const pre = new AbortController();
      pre.abort();
      const e2 = await MC.createModelClient({ url: s.url, model: "m" }).plan({ ...ctx(), signal: pre.signal }).catch((x) => x);
      expect(e2.name).to.equal("AbortError");
      expect(s.requests).to.have.length(1);
    });

    it("oversized answer: refused by Content-Length before reading it", async () => {
      const big = JSON.stringify(completion({ content: "x".repeat(200000) }));
      const s = await fakeServer((req, res) => (res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(big) }), res.end(big)));
      const e = await MC.createModelClient({ url: s.url, model: "m" }).plan(ctx()).catch((x) => x);
      expect(e).to.be.instanceOf(MC.ModelError);
      expect(e.code).to.equal("too_large");
    });

    it("oversized answer without Content-Length: cut off at maxBytes while streaming", async () => {
      let sent = 0;
      const s = await fakeServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" }); // chunked
        res.write('{"choices":[{"message":{"content":"');
        const iv = setInterval(() => {
          sent += 4096;
          if (!res.write("x".repeat(4096)) && res.destroyed) clearInterval(iv);
          if (sent > 4 * 1024 * 1024) (clearInterval(iv), res.end());
        }, 1);
        res.on("close", () => clearInterval(iv));
      });
      const e = await MC.createModelClient({ url: s.url, model: "m", maxBytes: 8192 }).plan(ctx()).catch((x) => x);
      expect(e.code).to.equal("too_large");
      expect(sent).to.be.below(4 * 1024 * 1024); // the client hung up long before the end
    });

    it("an answer just under the cap still works", async () => {
      const s = await fakeServer((req, res) => json(res, completion({ content: JSON.stringify({ say: "ok", steps: [{ tool: "wait", seconds: 1 }], pad: "p".repeat(60000) }) })));
      const r = await MC.createModelClient({ url: s.url, model: "m" }).plan(ctx());
      expect(r.steps).to.have.length(1);
    });

    it("never follows a redirect (it could point anywhere)", async () => {
      const s = await fakeServer((req, res) => (res.writeHead(302, { location: "http://example.invalid/steal" }), res.end()));
      const e = await MC.createModelClient({ url: s.url, model: "m", timeoutMs: 2000 }).plan(ctx()).catch((x) => x);
      expect(e).to.be.instanceOf(MC.ModelError);
      expect(["network", "http"]).to.include(e.code);
    });

    it("the say text is capped and cleaned like any other model output", async () => {
      const s = await fakeServer((req, res) => json(res, completion({ content: "<b>" + "y".repeat(1000) + "\u0000" })));
      const r = await MC.createModelClient({ url: s.url, model: "m" }).plan(ctx());
      expect(r.say.length).to.be.at.most(200);
      expect(r.say).to.not.contain("\u0000");
    });
  });

  describe("probe()", () => {
    it("lists the models the server offers", async () => {
      const s = await fakeServer((req, res) => (req.url === "/v1/models" ? json(res, { data: [{ id: "qwen2.5:3b" }, { id: "llama3.2:3b" }] }) : json(res, {}, 404)));
      const r = await MC.createModelClient({ url: s.url, model: "qwen2.5:3b" }).probe();
      expect(r).to.deep.include({ ok: true, models: ["qwen2.5:3b", "llama3.2:3b"], hasModel: true });
      const r2 = await MC.createModelClient({ url: s.url, model: "other" }).probe();
      expect(r2.ok).to.equal(true);
      expect(r2.hasModel).to.equal(false);
    });
    it("reports instead of throwing: HTTP errors, nothing listening, timeouts, abort", async () => {
      const s = await fakeServer((req, res) => json(res, {}, 500));
      const r = await MC.createModelClient({ url: s.url, model: "m" }).probe();
      expect(r.ok).to.equal(false);
      expect(r.error).to.match(/500/);
      const dead = await fakeServer(() => {});
      const url = dead.url;
      await new Promise((rs) => (dead.closeAllConnections(), dead.close(rs)));
      servers.length = 1;
      const r2 = await MC.createModelClient({ url, model: "m", timeoutMs: 1500 }).probe();
      expect(r2.ok).to.equal(false);
      expect(r2.error).to.be.a("string");
      const hang = await fakeServer(() => {});
      const r3 = await MC.createModelClient({ url: hang.url, model: "m", timeoutMs: 150 }).probe();
      expect(r3.ok).to.equal(false);
      expect(r3.error).to.match(/time/i);
      const ctl = new AbortController();
      const p = MC.createModelClient({ url: hang.url, model: "m" }).probe(ctl.signal);
      ctl.abort();
      expect((await p).ok).to.equal(false);
    });
  });

  describe("parseModelUrl()", () => {
    const ok = (u, o) => MC.parseModelUrl(u, o);
    it("accepts http(s) on loopback hosts and normalises", () => {
      expect(ok("http://localhost:11434")).to.deep.include({ ok: true, url: "http://localhost:11434", loopback: true });
      expect(ok("  http://localhost:11434/  ").url).to.equal("http://localhost:11434");
      expect(ok("http://127.0.0.1:1234/v1").url).to.equal("http://127.0.0.1:1234");
      expect(ok("http://[::1]:8080").url).to.equal(undefined); // the page CSP cannot allow [::1]
      expect(ok("https://localhost:8443").ok).to.equal(true);
      expect(ok("http://LOCALHOST:11434").url).to.equal("http://localhost:11434");
    });
    it("refuses everything else unless 'other hosts' is on", () => {
      for (const u of ["http://example.com", "http://192.168.1.20:11434", "http://localhost.evil.com", "http://127.0.0.1.evil.com", "http://0.0.0.0:80", "http://[::2]:1", "http://evil.com#@localhost", "http://localhost@evil.com"]) {
        const r = ok(u);
        expect(r.ok, u).to.equal(false);
        expect(r.error).to.be.a("string");
      }
      const r = ok("http://192.168.1.20:11434", { allowOtherHosts: true });
      expect(r).to.deep.include({ ok: true, url: "http://192.168.1.20:11434", loopback: false });
    });
    it("refuses other schemes, credentials in the URL, and junk, even with other hosts allowed", () => {
      for (const u of ["file:///etc/passwd", "ftp://localhost", "javascript:alert(1)", "data:text/html,x", "ws://localhost:1", "//localhost", "localhost:11434", "", "   ", null, undefined, 42, {}, "http://", "http://user:pw@localhost:11434", "not a url"]) {
        expect(ok(u).ok, String(u)).to.equal(false);
        expect(ok(u, { allowOtherHosts: true }).ok, String(u)).to.equal(false);
      }
    });
  });

  describe("with the orchestrator", () => {
    it("a stale reply after a re-plan is ignored and its request is aborted", async () => {
      const s = await fakeServer((req, res, body, n) => {
        const text = body.messages[body.messages.length - 1].content;
        if (/slow/.test(text)) return setTimeout(() => !res.destroyed && json(res, completion({ tool_calls: [call("drive", { direction: "forward", seconds: 1 })] })), 400);
        json(res, completion({ content: "Looking.", tool_calls: [call("look", { pan: 30 })] }));
      });
      const clock = { now: () => 0, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
      const tr = TT.createTwinTransport({ body: P.BODY.ROVER, clock, latencyMs: 0 });
      const loop = D.createDriveLoop({ transport: tr, clock });
      await loop.connect();
      const client = MC.createModelClient({ url: s.url, model: "m" });
      const ai = AP.createAiPilot({ getLoop: () => loop, getBodyKey: () => "rover", getMode: () => "ble", clock, getModel: () => client });
      const first = ai.submit("do the slow thing");
      await sleep(60);
      expect(ai.state).to.equal("thinking");
      await ai.submit("look left");
      expect(ai.state).to.equal("ready"); // not armed: the plan waits for a human ARM
      await first;
      await sleep(500);
      const plans = ai.view.messages.filter((m) => m.role === "plan");
      expect(plans).to.have.length(1);
      expect(plans[0].plan.steps.map((x) => x.tool)).to.deep.equal(["look"]);
      expect(ai.view.plan.source).to.equal("model");
      expect(ai.view.messages.filter((m) => m.role === "model").map((m) => m.text)).to.deep.equal(["Looking."]);
      expect(s.requests[0].closed, "the stale request was aborted").to.equal(true);
    });
  });

  describe("<tool_call> scan (security review fix)", () => {
    it("is case-insensitive, keeps the prose around the blocks as say text, and stops at 40 calls", () => {
      const r = MC.extractPlan('Sure.<TOOL_CALL>{"name":"wait","arguments":{"seconds":1}}</Tool_Call> Done.');
      expect(r.via).to.equal("content");
      expect(r.say).to.equal("Sure. Done.");
      expect(r.steps).to.deep.equal([{ tool: "wait", args: { seconds: 1 } }]);
      const many = MC.extractPlan(`go ${'<tool_call>{"name":"wait","arguments":{"seconds":1}}</tool_call>'.repeat(100)} end`);
      expect(many.steps).to.have.length(40);
      expect(many.say).to.equal("go end");
      expect(many.say).to.not.contain("tool_call");
    });

    it("unclosed or nested tags cost linear time and yield nothing unsafe", () => {
      const t0 = Date.now();
      const r = MC.extractPlan("<tool_call>".repeat(20000));
      expect(Date.now() - t0).to.be.below(500);
      expect(r.via).to.equal("none");
      const odd = MC.extractPlan('<tool_call><tool_call>{"name":"wait","arguments":{"seconds":2}}</tool_call>');
      expect(odd.steps).to.deep.equal([{ tool: "wait", args: { seconds: 2 } }]); // same as the old lazy regex; validatePlan still decides
    });
  });
});
