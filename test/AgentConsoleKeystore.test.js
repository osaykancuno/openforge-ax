const { expect } = require("chai");
const ethers = require("ethers");

// web/js/agent/keystore.js: the agent key lives in this browser only, encrypted with the holder's passphrase. The
// storage (IndexedDB in the page) is injected, so everything here runs in Node with a Map.
describe("Agent console: browser key (web/js/agent/keystore.js)", () => {
  let K;
  const PASS = "violet anchor pebble lantern";
  const SCRYPT = 16; // tests only: the page uses ethers' default cost
  const holder = ethers.Wallet.createRandom().address;
  const meta = { chainId: 1, account: "0x" + "ab".repeat(20), tokenId: 7, holder };
  before(async () => {
    K = await import("../web/js/agent/keystore.js");
  });

  it("scopes the key id to chain, account and token, ignoring address case", () => {
    const id = K.keyId(1, "0x" + "AB".repeat(20), 7);
    expect(id).to.equal(K.keyId(1, "0x" + "ab".repeat(20), "7"));
    expect(id).to.not.equal(K.keyId(11155111, meta.account, 7));
    expect(id).to.not.equal(K.keyId(1, meta.account, 8));
    expect(id).to.not.equal(K.keyId(1, "0x" + "ac".repeat(20), 7));
  });

  describe("passphrase strength (H1b)", () => {
    it("asks for at least 12 characters", () => {
      for (const p of ["", "short", undefined, null, 12345678901234, "Zt7!kQ2m#Lp"]) expect(K.checkPassphrase(p), String(p)).to.be.a("string");
      expect(K.checkPassphrase("Zt7!kQ2m#Lp9")).to.equal(null);
    });
    it("refuses repeated characters, sequences, and common words, however long", () => {
      for (const p of ["aaaaaaaaaaaaaaaa", "abababababababab", "Passw0rd!Passw0rd!", "Password1234!", "Qwerty-123456-Zx", "abcdefghijkl1A!", "Zt7!ABCDEFg9xK", "mypassword Zt7!kQ2m", "OpenForge2026!!xY", "correct horse battery staple"]) {
        expect(K.checkPassphrase(p), p).to.be.a("string");
      }
    });
    it("needs three kinds of characters, or four separate words", () => {
      expect(K.checkPassphrase("alllowercaseletters")).to.be.a("string"); // one kind, one word
      expect(K.checkPassphrase("lower UPPER onlyletters")).to.be.a("string"); // two kinds, three words
      expect(K.checkPassphrase("Zt7kQ2mLp9vXbN")).to.equal(null); // lower, upper, digit
      expect(K.checkPassphrase("zt!kq?mlp#vxbn")).to.be.a("string"); // lower, symbol: two kinds
    });
    it("accepts a long random-looking passphrase and a four-word one", () => {
      expect(K.checkPassphrase("Zt7!kQ2m#Lp9vX")).to.equal(null);
      expect(K.checkPassphrase("violet anchor pebble lantern")).to.equal(null);
      expect(K.checkPassphrase("orbit-quartz-maple-harbor")).to.equal(null);
    });
    it("refuses the same word four times", () => {
      expect(K.checkPassphrase("maple maple maple maple")).to.be.a("string");
    });
    it("says what to do", () => {
      expect(K.checkPassphrase("short")).to.match(/12 characters/);
    });
  });

  describe("create, store, unlock", () => {
    let store, made, rec;
    beforeEach(async () => {
      store = K.memoryStore();
      made = await K.createKey({ ethers, passphrase: PASS, scryptN: SCRYPT });
      rec = await K.saveKey(store, meta, made.json, made.address);
    });

    it("makes a fresh random key each time and returns an encrypted keystore, never the private key", async () => {
      const other = await K.createKey({ ethers, passphrase: PASS, scryptN: SCRYPT });
      expect(other.address).to.not.equal(made.address);
      expect(ethers.isKeystoreJson(made.json)).to.equal(true);
      expect(made.json).to.not.include(made.wallet.privateKey.slice(2));
      expect(Object.keys(made).sort()).to.deep.equal(["address", "json", "wallet"]);
    });

    it("stores the record under the id, with the holder it was made for, and no plaintext secret", async () => {
      const id = K.keyId(meta.chainId, meta.account, meta.tokenId);
      const got = await K.loadRecord(store, id);
      expect(got.address).to.equal(made.address);
      expect(got.holder).to.equal(holder);
      expect(got.tokenId).to.equal(7);
      const dump = JSON.stringify(got);
      expect(dump).to.not.include(made.wallet.privateKey);
      expect(dump).to.not.include(made.wallet.privateKey.slice(2));
      expect(await K.loadRecord(store, K.keyId(1, meta.account, 8))).to.equal(null);
    });

    it("unlocks with the passphrase to the same address", async () => {
      const w = await K.unlockKey({ ethers, record: rec, passphrase: PASS });
      expect(w.address).to.equal(made.address);
    });

    it("refuses a wrong passphrase with a plain message", async () => {
      let err;
      try {
        await K.unlockKey({ ethers, record: rec, passphrase: "wrong passphrase!" });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(Error);
      expect(err.message).to.equal("Wrong passphrase.");
    });

    it("exports the encrypted file as stored, named for the agent", () => {
      const f = K.exportKeystore(rec);
      expect(f.filename).to.equal("openforge-agent-7-key.json");
      expect(f.text).to.equal(made.json);
      expect(f.text).to.not.include(made.wallet.privateKey.slice(2));
    });

    it("never overwrites an existing key silently (put-if-absent); replacing must be asked for", async () => {
      const other = await K.createKey({ ethers, passphrase: PASS, scryptN: SCRYPT });
      let err;
      try {
        await K.saveKey(store, meta, other.json, other.address);
      } catch (e) {
        err = e;
      }
      expect(err?.code).to.equal("EXISTS");
      expect(err.message).to.match(/already/i);
      expect((await K.loadRecord(store, rec.id)).address).to.equal(made.address); // untouched
      const next = await K.saveKey(store, meta, other.json, other.address, { replace: true });
      expect(next.address).to.equal(other.address);
      expect((await K.loadRecord(store, rec.id)).address).to.equal(other.address);
    });

    it("forget removes the key; a second forget is harmless", async () => {
      const id = K.keyId(meta.chainId, meta.account, meta.tokenId);
      await K.forgetKey(store, id);
      expect(await K.loadRecord(store, id)).to.equal(null);
      await K.forgetKey(store, id);
    });
  });

  describe("import", () => {
    let json, address;
    const IMPORT_N = 2 ** 14; // the lowest cost an imported file may have
    before(async () => {
      const made = await K.createKey({ ethers, passphrase: PASS, scryptN: IMPORT_N });
      json = made.json;
      address = made.address;
    });
    const imp = (over) => K.importKeystore({ ethers, text: json, passphrase: PASS, meta, scryptN: IMPORT_N, ...over });
    const withN = (n, kdf = "scrypt") => {
      const j = JSON.parse(json);
      const c = j.crypto ?? j.Crypto;
      c.kdf = kdf;
      c.kdfparams.n = n;
      return JSON.stringify(j);
    };

    it("accepts the exported file with its passphrase and keeps its address", async () => {
      const rec = await imp();
      expect(rec.address).to.equal(address);
      expect(rec.holder).to.equal(holder);
      const w = await ethers.Wallet.fromEncryptedJson(rec.keystore, PASS);
      expect(w.address).to.equal(address);
    });
    it("stores the key re-encrypted at the page's own cost, not the file's (M3)", async () => {
      const rec = await imp({ scryptN: 2 ** 15 });
      expect((JSON.parse(rec.keystore).crypto ?? JSON.parse(rec.keystore).Crypto).kdfparams.n).to.equal(2 ** 15);
      expect(rec.keystore).to.not.equal(json);
    });
    it("refuses a file whose scrypt cost is outside 2^14..2^20 or that is not scrypt (M3)", async () => {
      for (const n of [16, 2 ** 13, 2 ** 21, 2 ** 30, 0, -1, "16384", 3 * 2 ** 14, 1.5 * 2 ** 14]) {
        let err;
        try {
          await imp({ text: withN(n) });
        } catch (e) {
          err = e;
        }
        expect(err?.message, String(n)).to.match(/strength|cost|not an agent key file/i);
      }
      for (const n of [2 ** 14, 2 ** 17, 2 ** 20]) expect(K.kdfCostOk(JSON.parse(withN(n))), String(n)).to.equal(true);
      let err;
      try {
        await imp({ text: withN(2 ** 14, "pbkdf2") });
      } catch (e) {
        err = e;
      }
      expect(err?.message).to.match(/strength|cost|not an agent key file/i);
    });
    it("refuses a wrong passphrase, text that is not JSON, and JSON that is not a keystore", async () => {
      const fails = async (over, re) => {
        let err;
        try {
          await imp(over);
        } catch (e) {
          err = e;
        }
        expect(err?.message, JSON.stringify(Object.keys(over))).to.match(re);
      };
      await fails({ passphrase: "not the passphrase" }, /Wrong passphrase/);
      await fails({ text: "not json at all" }, /keystore/i);
      await fails({ text: JSON.stringify({ privateKey: "0x" + "11".repeat(32) }) }, /keystore/i);
      await fails({ text: "" }, /keystore/i);
      await fails({ text: undefined }, /keystore/i);
      await fails({ text: "x".repeat(200_000) }, /keystore/i);
    });
    it("never accepts a raw private key pasted in place of a keystore file", async () => {
      let err;
      try {
        await imp({ text: "0x" + "11".repeat(32) });
      } catch (e) {
        err = e;
      }
      expect(err?.message).to.match(/keystore/i);
    });
  });
});
