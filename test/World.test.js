const { expect } = require("chai");
const { ethers } = require("ethers");
const WebSocket = require("ws");

describe("Neo-Forge world", () => {
  let core, protocol, district, avatar, server, http, port, wallet, ownerOfMap;

  const client = () =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const inbox = [];
      ws.on("message", (d) => inbox.push(JSON.parse(d)));
      ws.next = (t, ms = 1500) =>
        new Promise((res, rej) => {
          const start = Date.now();
          (function poll() {
            const i = inbox.findIndex((m) => m.t === t);
            if (i >= 0) return res(inbox.splice(i, 1)[0]);
            if (Date.now() - start > ms) return rej(new Error(`timeout waiting for ${t}`));
            setTimeout(poll, 10);
          })();
        });
      ws.closed = new Promise((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })));
      ws.sendJ = (m) => ws.send(JSON.stringify(m));
      ws.on("open", () => resolve(ws));
    });
  const guest = async () => {
    const ws = await client();
    await ws.next("challenge");
    ws.sendJ({ t: "hello", v: 1, mode: "guest" });
    ws.welcome = await ws.next("welcome");
    return ws;
  };
  const holder = async (tokenId, signer = wallet) => {
    const ws = await client();
    const { nonce } = await ws.next("challenge");
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const td = protocol.joinTypedData({ chainId: 31337, verifyingContract: ethers.ZeroAddress, tokenId, owner: wallet.address, district: district.DISTRICT, nonce, deadline });
    ws.sendJ({ t: "hello", v: 1, mode: "holder", tokenId, owner: wallet.address, deadline, signature: await signer.signTypedData(td.domain, td.types, td.value) });
    return ws;
  };

  before(async () => {
    core = await import("../scripts/world/core.mjs");
    protocol = await import("../web/js/world/protocol.js");
    district = await import("../web/js/world/district.js");
    avatar = await import("../web/js/world/voxel-avatar.js");
    wallet = ethers.Wallet.createRandom();
    ownerOfMap = { 7: wallet.address };
    // let the OS pick a free port: a random fixed range can hit ports Windows reserves (Hyper-V exclusions)
    http = require("node:http").createServer();
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    port = http.address().port;
    server = core.createWorldServer({
      server: http,
      limits: { helloMs: 400 },
      deps: {
        chainId: 31337,
        verifyingContract: ethers.ZeroAddress,
        ownerOf: async (id) => {
          if (!ownerOfMap[id]) throw new Error("nope");
          return ownerOfMap[id];
        },
        agentInfo: async (id) => ({ name: `AX-${id}`, traits: { class_: 0, core: 1, finish: 2, augment: 1, faction: 3, legendary: 0 } }),
        verifySignature: async (owner, td, sig) => {
          try {
            return ethers.verifyTypedData(td.domain, td.types, td.value, sig) === owner;
          } catch {
            return false;
          }
        },
      },
    });
  });
  after(() => (server.close(), http.close()));

  it("avatars are deterministic for every class and the Visitor", () => {
    for (let c = -1; c < 8; c++) {
      const t = c < 0 ? null : { class_: c, core: c % 4, finish: c % 7, augment: c % 6, faction: c % 5, legendary: c === 7 ? 3 : 0 };
      const a = avatar.buildAvatar(t);
      expect(a.solid.length + a.glow.length).to.be.greaterThan(10);
      expect(avatar.buildAvatar(t)).to.deep.equal(a);
    }
  });

  it("district: spawn and station pad are walkable, containers and water are not", () => {
    const { walkable, blocks } = district.buildDistrict();
    expect(walkable(district.SPAWN.x, district.SPAWN.z)).to.equal(true);
    expect(walkable(district.STATION.x, district.STATION.z)).to.equal(true);
    expect(walkable(10, 2)).to.equal(false); // water
    expect(blocks.length).to.be.greaterThan(50);
  });

  it("guests join, see each other, and receive snapshots", async () => {
    const a = await guest();
    const b = await guest();
    const j = await a.next("join");
    expect(j.p.id).to.equal(b.welcome.you.id);
    expect(b.welcome.players.map((p) => p.id)).to.include(a.welcome.you.id);
    b.sendJ({ t: "move", x: district.SPAWN.x, z: district.SPAWN.z - 0.3, yaw: 1 });
    const snap = await a.next("snap");
    expect(snap.ps.some(([id]) => id === b.welcome.you.id)).to.equal(true);
    a.close();
    b.close();
  });

  it("server clamps speed and refuses blocked tiles", async () => {
    const a = await guest();
    a.sendJ({ t: "move", x: 40, z: 40, yaw: 0 }); // teleport attempt
    const c = await a.next("correct");
    const moved = Math.hypot(c.x / 100 - district.SPAWN.x, c.z / 100 - district.SPAWN.z);
    expect(moved).to.be.lessThan(1.5);
    a.close();
  });

  it("emotes are broadcast and rate-limited", async () => {
    const a = await guest();
    const b = await guest();
    b.sendJ({ t: "emote", e: "wave" });
    b.sendJ({ t: "emote", e: "gg" }); // within 1 s: dropped
    b.sendJ({ t: "emote", e: "dance" }); // not in the enum
    const e = await a.next("emote");
    expect(e.e).to.equal("wave");
    await new Promise((r) => setTimeout(r, 300));
    await a.next("emote", 100).then(() => expect.fail("second emote should be dropped"), () => {});
    a.close();
    b.close();
  });

  it("holder join needs a signature over this connection's nonce from the current owner", async () => {
    const ok = await holder(7);
    const w = await ok.next("welcome");
    expect(w.you).to.include({ kind: "holder", tokenId: 7, name: "AX-7" });
    expect(w.you.traits.class_).to.equal(0);

    const forged = await holder(7, ethers.Wallet.createRandom());
    expect((await forged.next("error")).code).to.equal("not_owner");
    ok.close();
  });

  it("a newer verified session replaces the old one; resume restores the session without a signature", async () => {
    const first = await holder(7);
    await first.next("welcome");
    const second = await holder(7);
    const w2 = await second.next("welcome");
    expect((await first.next("kicked")).reason).to.equal("session_replaced");

    second.close();
    await new Promise((r) => setTimeout(r, 100));
    const back = await client();
    await back.next("challenge");
    back.sendJ({ t: "hello", v: 1, mode: "resume", token: w2.resumeToken });
    const w3 = await back.next("welcome");
    expect(w3.you.tokenId).to.equal(7);
    back.close();
  });

  it("protocol hardening: oversized frames, missing hello, wrong version", async () => {
    const big = await client();
    big.send("x".repeat(2000));
    expect((await big.closed).code).to.be.oneOf([1006, 1009]);
    const alive = await guest(); // the server survived the bad frame
    alive.close();

    const idle = await client();
    expect((await idle.closed).reason).to.equal("hello_timeout");

    const old = await client();
    await old.next("challenge");
    old.sendJ({ t: "hello", v: 999, mode: "guest" });
    expect((await old.next("error")).code).to.equal("protocol");
  });

  it("a rejected socket (bad Origin) sending a malicious frame cannot crash the server", async () => {
    const p2 = port + 1;
    const strict = core.createWorldServer({ port: p2, origins: ["http://allowed.test"], deps: {} });
    await strict.ready;
    const evil = new WebSocket(`ws://127.0.0.1:${p2}`, { headers: { origin: "http://evil.test" } });
    evil.on("error", () => {});
    await new Promise((r) => evil.on("open", r));
    evil.send("x".repeat(5000));
    await new Promise((r) => evil.on("close", r));
    const ok = new WebSocket(`ws://127.0.0.1:${p2}`, { headers: { origin: "http://allowed.test" } });
    const first = await new Promise((r) => ok.on("message", (d) => r(JSON.parse(d))));
    expect(first.t).to.equal("challenge");
    ok.close();
    await strict.close();
  });

  it("movement: no burst speed and no walking through the station walls", async function () {
    this.timeout(15000);
    const a = await guest();
    const pos = async () => {
      a.sendJ({ t: "emote", e: "ping" }); // harmless traffic; position comes from the next keyframe/snapshot
      for (;;) {
        const s = await a.next("snap", 3000);
        const me = s.ps.find(([id]) => id === a.welcome.you.id);
        if (me) return { x: me[1] / 100, z: me[2] / 100 };
      }
    };
    // burst: 15 moves at once toward the station = at most ~1 m (banked budget), not 6+ m
    for (let i = 1; i <= 15; i++) a.sendJ({ t: "move", x: 24.5, z: 30.5 - i * 0.45, yaw: Math.PI });
    const afterBurst = await pos();
    expect(30.5 - afterBurst.z).to.be.lessThan(1.6);
    // walk legitimately to the station pad, then try to step into the building
    let z = afterBurst.z;
    while (z > 19.6) {
      z = Math.max(19.6, z - 0.3);
      a.sendJ({ t: "move", x: 24.5, z, yaw: Math.PI });
      await new Promise((r) => setTimeout(r, 90));
    }
    await new Promise((r) => setTimeout(r, 1200)); // bank the max budget
    a.sendJ({ t: "move", x: 24.5, z: 15, yaw: Math.PI });
    const end = await pos();
    expect(end.z).to.be.at.least(18); // building occupies z 13..18
    a.close();
  });

  it("resume is refused after the agent was sold", async () => {
    const h = await holder(7);
    const w = await h.next("welcome");
    h.close();
    await new Promise((r) => setTimeout(r, 100));
    ownerOfMap[7] = ethers.Wallet.createRandom().address;
    const back = await client();
    await back.next("challenge");
    back.sendJ({ t: "hello", v: 1, mode: "resume", token: w.resumeToken });
    expect((await back.next("error")).code).to.equal("not_owner");
    ownerOfMap[7] = wallet.address;
  });

  it("no ghost session when the socket closes during verification", async () => {
    const before = server.stats().players;
    const ws = await client();
    const { nonce } = await ws.next("challenge");
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const td = protocol.joinTypedData({ chainId: 31337, verifyingContract: ethers.ZeroAddress, tokenId: 7, owner: wallet.address, district: district.DISTRICT, nonce, deadline });
    ws.sendJ({ t: "hello", v: 1, mode: "holder", tokenId: 7, owner: wallet.address, deadline, signature: await wallet.signTypedData(td.domain, td.types, td.value) });
    ws.terminate(); // gone before the server finishes its async checks
    await new Promise((r) => setTimeout(r, 300));
    expect(server.stats().players).to.equal(before);
  });
});
