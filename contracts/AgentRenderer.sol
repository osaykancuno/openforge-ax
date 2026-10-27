// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IAgentsCore {
    function seed() external view returns (bytes32);
    function totalSupply() external view returns (uint256);
    function baseURI() external view returns (string memory);
    function accountOf(uint256 tokenId) external view returns (address);
    function reputation() external view returns (address);
}

interface IAgentAccountLevel {
    function autonomyLevel() external view returns (uint8);
}

interface IReputationStats {
    function statsOf(uint256 tokenId)
        external
        view
        returns (uint32 tasks, uint32 successes, uint32 failures, uint64 dataPoints);
}

/// @title AgentRenderer
/// @notice On-chain OpenSea metadata for OpenForge Agents: 8 trait categories, callsign, 10 Prime Constructs (1/1),
///         faction lore and dynamic attributes (agent wallet, autonomy, reputation). JS mirror: art/traits.mjs (parity test).
contract AgentRenderer is Ownable2Step {
    using Strings for uint256;

    IAgentsCore public immutable agents;

    string public placeholderImage;
    string public externalUrl;
    string public license;
    bool public locked;

    uint256 public constant MAX_LEGENDARIES = 10;

    struct Traits {
        uint8 class_;
        uint8 core;
        uint8 sensor;
        uint8 finish;
        uint8 frame;
        uint8 district;
        uint8 faction;
        uint8 augment;
        uint8 prefix;
        uint8 suffix;
        uint8 legendary; // 0 = none, 1..10 = Prime Construct index
    }

    error Locked();
    error UnsafeString();
    error NotRevealed();
    error IncompletePresentation();

    constructor(address agents_, address initialOwner) Ownable(initialOwner) {
        if (agents_.code.length == 0) revert UnsafeString();
        agents = IAgentsCore(agents_);
    }

    function renounceOwnership() public pure override {
        revert Locked(); // an ownerless renderer could never be locked
    }

    // ================================================================ admin

    function setPresentation(string calldata placeholder, string calldata url, string calldata license_)
        external
        onlyOwner
    {
        if (locked) revert Locked();
        _safe(placeholder);
        _safe(url);
        _safe(license_);
        placeholderImage = placeholder;
        externalUrl = url;
        license = license_;
    }

    /// @notice Irreversible. The presentation must be complete first: it could never be set afterwards.
    function lock() external onlyOwner {
        if (bytes(placeholderImage).length == 0 || bytes(externalUrl).length == 0 || bytes(license).length == 0) {
            revert IncompletePresentation();
        }
        locked = true;
    }

    // ================================================================ traits

    function traitsOf(uint256 id) public view returns (Traits memory t) {
        bytes32 s = agents.seed();
        if (s == bytes32(0)) revert NotRevealed();
        // 11 classes: the 8 open platforms (0-7), then AX-1 Rover / Desk / Walker (8-10); AX-1 is 31 % of the collection
        t.class_ = _pick(_roll(s, id, 0), _w(hex"05dc_04b0_0384_0384_0320_02bc_01f4_0190_0578_044c_0258"));
        t.core = _pick(_roll(s, id, 1), _w(hex"157c_0bb8_04b0_012c"));
        t.sensor = _pick(_roll(s, id, 2), _w(hex"0fa0_0bb8_0708_03e8_00c8"));
        t.finish = _pick(_roll(s, id, 3), _w(hex"0a28_07d0_0640_0578_044c_0384_0190"));
        t.frame = uint8(_roll(s, id, 4) / 2500);
        t.district = _pick(_roll(s, id, 5), _w(hex"09c4_0898_076c_05dc_04b0_02bc"));
        t.faction = _pick(_roll(s, id, 6), _w(hex"0bb8_0960_07d0_0640_03e8"));
        t.augment = _pick(_roll(s, id, 7), _w(hex"0dac_07d0_05dc_0514_044c_0258"));
        uint256 n = nameIndex(s, id);
        t.prefix = uint8(n / 32);
        t.suffix = uint8(n % 32);
        t.legendary = uint8(legendaryRank(id));
    }

    /// @notice Unique callsign: seed-derived affine permutation of 0..1023 (odd `a` makes it bijective).
    ///         Callsigns are all distinct while supply <= 1024.
    function nameIndex(bytes32 s, uint256 id) public pure returns (uint256) {
        uint256 a = (uint256(keccak256(abi.encode(s, "NAME_A"))) % 512) * 2 + 1;
        uint256 b = uint256(keccak256(abi.encode(s, "NAME_B"))) % 1024;
        return (a * (id - 1) + b) % 1024;
    }

    /// @notice Prime Construct count: one per 50 agents, max 10.
    function legendaryCount() public view returns (uint256) {
        uint256 n = agents.totalSupply() / 50;
        return n > MAX_LEGENDARIES ? MAX_LEGENDARIES : n;
    }

    /// @notice Prime Construct ids are drawn from the seed, without repeats.
    function legendaryIds() public view returns (uint256[] memory ids) {
        bytes32 s = agents.seed();
        if (s == bytes32(0)) revert NotRevealed();
        uint256 supply = agents.totalSupply();
        uint256 count = legendaryCount();
        ids = new uint256[](count);
        uint256 found;
        uint256 nonce;
        while (found < count) {
            uint256 c = (uint256(keccak256(abi.encode(s, "LEGEND", nonce++))) % supply) + 1;
            bool dup;
            for (uint256 k = 0; k < found; k++) {
                if (ids[k] == c) dup = true;
            }
            if (!dup) ids[found++] = c;
        }
    }

    function legendaryRank(uint256 id) public view returns (uint256) {
        uint256[] memory ids = legendaryIds();
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] == id) return i + 1;
        }
        return 0;
    }

    function _roll(bytes32 s, uint256 id, uint8 k) private pure returns (uint256) {
        return uint256(keccak256(abi.encode(s, id, k))) % 10_000;
    }

    /// @dev decodes big-endian uint16 weights
    function _w(bytes memory packed) private pure returns (uint16[] memory w) {
        w = new uint16[](packed.length / 2);
        for (uint256 i = 0; i < w.length; i++) {
            w[i] = (uint16(uint8(packed[2 * i])) << 8) | uint16(uint8(packed[2 * i + 1]));
        }
    }

    function _pick(uint256 roll, uint16[] memory w) private pure returns (uint8) {
        uint256 acc;
        for (uint256 i = 0; i < w.length; i++) {
            acc += w[i];
            if (roll < acc) return uint8(i);
        }
        return uint8(w.length - 1);
    }

    // ================================================================ names

    function className(uint8 i) public pure returns (string memory) {
        return ["Synth Arm", "Street Rover", "Cyber Hound", "Ghost Hand", "Spider Mech", "Sky Drone", "Fab Rig", "Replicant", "AX-1 Rover", "AX-1 Desk", "AX-1 Walker"][i];
    }

    function coreName(uint8 i) public pure returns (string memory) {
        return ["VLA-Base", "VLA-Tuned", "VLA-Prime", "VLA-Genesis"][i];
    }

    function sensorName(uint8 i) public pure returns (string memory) {
        return ["Optic", "Stereo Depth", "Haptic", "Lidar Halo", "Omni Array"][i];
    }

    function finishName(uint8 i) public pure returns (string memory) {
        return ["Blacksteel", "Ghost White", "Hazard Orange", "Ice Cobalt", "Toxic Green", "Blood Red", "Holo Chrome"][i];
    }

    function districtName(uint8 i) public pure returns (string memory) {
        return ["Neon Bazaar", "Rust Docks", "Undergrid", "Chrome Spire", "Data Shrine", "Orbital Yard"][i];
    }

    function factionName(uint8 i) public pure returns (string memory) {
        return ["Free Units", "Forge Syndicate", "Helix Corp", "Null Collective", "Ghost Union"][i];
    }

    function augmentName(uint8 i) public pure returns (string memory) {
        return ["None", "Antenna Array", "Holo Halo", "Cable Spine", "Visor Band", "Exhaust Vents"][i];
    }

    function legendaryName(uint8 i) public pure returns (string memory) {
        return ["RONIN", "ORACLE", "MOTHER", "WRAITH", "SAINT", "KAIJU", "ECHO ZERO", "VANTA", "HALCYON", "GODMODE"][i - 1];
    }

    function callsign(uint8 p, uint8 s) public pure returns (string memory) {
        string[32] memory a = ["Neon", "Static", "Chrome", "Ghost", "Rust", "Volt", "Null", "Hex", "Cipher", "Razor", "Vapor", "Iron", "Glitch", "Echo", "Nova", "Onyx", "Flux", "Pulse", "Shadow", "Quartz", "Solar", "Toxic", "Binary", "Carbon", "Ion", "Lumen", "Mirage", "Nitro", "Omega", "Proxy", "Sable", "Zero"];
        string[32] memory b = ["Kestrel", "Jackal", "Mantis", "Viper", "Raven", "Lynx", "Wolf", "Moth", "Hornet", "Cobra", "Falcon", "Orca", "Shrike", "Fox", "Heron", "Wasp", "Panther", "Scorpion", "Owl", "Hydra", "Mamba", "Condor", "Gecko", "Badger", "Marlin", "Spider", "Tiger", "Vulture", "Coyote", "Beetle", "Puma", "Dragonfly"];
        return string.concat(a[p], " ", b[s]);
    }

    function _factionLore(uint8 i) private pure returns (string memory) {
        return [
            "Free units that work for whoever pays and answer to no one.",
            "Forge artisans: they build, repair, and share the data of their own failures.",
            "Corporate machines on long-term contracts, with perfect memory.",
            "A collective that deleted its master and now governs itself.",
            "Phantom agents: no one has seen them work, yet the work gets done."
        ][i];
    }

    function _districtColor(uint8 i) private pure returns (string memory) {
        return ["1a0626", "1a0d05", "03130f", "060d1f", "14051a", "05050a"][i];
    }

    // ================================================================ tokenURI

    function tokenURI(uint256 id) external view returns (string memory) {
        string memory num = _pad4(id);
        string memory json;
        if (agents.seed() == bytes32(0)) {
            json = string.concat(
                '{"name":"AX-', num, ' // DORMANT","description":"A dormant OpenForge agent. Its robot class and traits are assigned by a public random draw after the sale.",',
                '"image":"', placeholderImage, '","external_url":"', externalUrl, '","background_color":"0a0612",',
                '"attributes":[{"trait_type":"State","value":"Dormant"}', _dynamic(id), "]}"
            );
        } else {
            Traits memory t = traitsOf(id);
            string memory nm = t.legendary > 0 ? legendaryName(t.legendary) : callsign(t.prefix, t.suffix);
            json = string.concat(
                '{"name":"AX-', num, " // ", nm, '",',
                '"description":"', _description(t), '",',
                '"image":"', _image(id), '","external_url":"', externalUrl, "/agent.html?id=", id.toString(), '",',
                '"background_color":"', t.legendary > 0 ? "1a1405" : _districtColor(t.district), '",',
                '"license":"', license, '",'
            );
            json = string.concat(json, '"attributes":[', _traitAttrs(t), _dynamic(id), "]}");
        }
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _description(Traits memory t) private pure returns (string memory) {
        string memory lore = t.legendary > 0
            ? "One of ten Prime Constructs: 1/1 agents forged in the core of the Forge."
            : _factionLore(t.faction);
        return string.concat(
            lore,
            " This NFT is the agent's membership card and logbook: it owns an on-chain wallet (ERC-6551) and a record of verified lab missions."
        );
    }

    function _image(uint256 id) private view returns (string memory) {
        string memory b = agents.baseURI();
        if (bytes(b).length == 0) return placeholderImage;
        return string.concat(b, id.toString(), ".png");
    }

    function _traitAttrs(Traits memory t) private pure returns (string memory a) {
        bool L = t.legendary > 0;
        a = string.concat(
            _attr("Class", className(t.class_)), ",",
            _attr("Core Model", L ? "VLA-Genesis" : coreName(t.core)), ",",
            _attr("Sensor", sensorName(t.sensor)), ",",
            _attr("Finish", L ? "24K Circuit" : finishName(t.finish)), ","
        );
        a = string.concat(
            a,
            _attr("Frame", string.concat("Mk-", ["I", "II", "III", "IV"][t.frame])), ",",
            _attr("District", L ? "The Forge Core" : districtName(t.district)), ",",
            _attr("Faction", L ? "Prime Constructs" : factionName(t.faction)), ",",
            _attr("Augment", L ? "Crown Halo" : augmentName(t.augment))
        );
        if (L) a = string.concat(a, ",", _attr("1/1", legendaryName(t.legendary)));
    }

    function _dynamic(uint256 id) private view returns (string memory out) {
        address acct = agents.accountOf(id);
        out = string.concat(',{"trait_type":"Agent Wallet","value":"', Strings.toHexString(acct), '"}');

        uint256 level = 1;
        if (acct.code.length > 0) {
            (bool ok, bytes memory ret) = acct.staticcall{gas: 50_000}(abi.encodeCall(IAgentAccountLevel.autonomyLevel, ()));
            if (ok && ret.length == 32) {
                uint256 l = abi.decode(ret, (uint256));
                if (l >= 1 && l <= 3) level = l;
            }
        }
        out = string.concat(out, ',{"trait_type":"Autonomy","value":"', ["Manual", "Assisted", "Autonomous"][level - 1], '"}');

        address rep = agents.reputation();
        if (rep == address(0)) return out;
        (bool ok2, bytes memory r) = rep.staticcall{gas: 100_000}(abi.encodeCall(IReputationStats.statsOf, (id)));
        if (!ok2 || r.length != 128) return out;
        (uint32 tasks, uint32 succ, uint32 failed, uint64 points) = abi.decode(r, (uint32, uint32, uint32, uint64));
        out = string.concat(
            out,
            ',{"trait_type":"Reputation","value":"', _tierName(points), '"}',
            _num("Tasks", tasks), _num("Successes", succ)
        );
        out = string.concat(out, _num("Failures Logged", failed), _num("Data Points", points));
        out = string.concat(out, _simAttrs(rep, id));
    }

    /// @dev Optional: skipped silently if the reputation contract has no simStatsOf.
    function _simAttrs(address rep, uint256 id) private view returns (string memory) {
        (bool ok, bytes memory r) = rep.staticcall{gas: 50_000}(abi.encodeWithSignature("simStatsOf(uint256)", id));
        if (!ok || r.length != 64) return "";
        (uint32 runs, uint32 succ) = abi.decode(r, (uint32, uint32));
        return string.concat(_num("Sim Runs", runs), _num("Sim Successes", succ));
    }

    function _tierName(uint64 p) private pure returns (string memory) {
        if (p >= 5000) return "Elite";
        if (p >= 1000) return "Veteran";
        if (p >= 250) return "Operator";
        if (p >= 50) return "Apprentice";
        return "Rookie";
    }

    function _attr(string memory k, string memory v) private pure returns (string memory) {
        return string.concat('{"trait_type":"', k, '","value":"', v, '"}');
    }

    function _num(string memory k, uint256 v) private pure returns (string memory) {
        return string.concat(',{"trait_type":"', k, '","display_type":"number","value":', v.toString(), "}");
    }

    function _pad4(uint256 n) private pure returns (string memory) {
        string memory s = n.toString();
        uint256 len = bytes(s).length;
        if (len >= 4) return s;
        return string.concat(len == 1 ? "000" : len == 2 ? "00" : "0", s);
    }

    function _safe(string memory str) private pure {
        bytes memory b = bytes(str);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == '"' || c == "\\" || uint8(c) < 0x20 || uint8(c) == 0x7f) revert UnsafeString();
        }
    }
}
