// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IOpenForgeAgentsHooks {
    function ownerOf(uint256 tokenId) external view returns (address);
    function refreshMetadata(uint256 tokenId) external;
}

/// @title AgentReputation
/// @notice Reputation and data-attestation registry for OpenForge Agents.
///         Attesters attest tasks and data contributions, INCLUDING failures:
///         an attestation's value is its `quality` (informativeness, 0-10000 bps), not its outcome.
///         Designed to sit alongside an ERC-8004 identity/validation registry: `uri` and `dataHash`
///         should point to verifiable off-chain evidence.
contract AgentReputation is Ownable2Step {
    struct Stats {
        uint32 tasks;
        uint32 successes;
        uint32 failures;
        uint64 dataPoints; // sum of quality/100 (0-100 per attestation)
        uint64 lastAttestedAt;
    }

    struct SimResult {
        uint256 tokenId;
        bool success;
        uint16 quality;
        bytes32 dataHash;
    }

    struct SimStats {
        uint32 runs;
        uint32 successes;
        uint64 lastRunAt;
        uint32 day; // block.timestamp / 1 days of the last run
        uint32 dayCount; // runs on that day
        uint64 points; // sum of quality/100 over successful runs (not part of real dataPoints)
    }

    IOpenForgeAgentsHooks public immutable agents;

    mapping(uint256 tokenId => Stats) private _stats;
    mapping(uint256 tokenId => SimStats) private _simStats;
    mapping(address => bool) public isAttester;
    mapping(address => bool) public isSimAttester;
    uint32 public constant SIM_DAILY_CAP = 10;
    mapping(bytes32 tokenAndDataKey => bool) public dataUsed; // keccak256(abi.encode(tokenId, dataHash))

    // dataPoints tier thresholds: Dormant <50, Apprentice 50, Operator 250, Veteran 1000, Elite 5000
    // (AgentRenderer._tierName hardcodes the same thresholds)
    uint64[4] public tierThresholds = [50, 250, 1000, 5000];

    event AttesterSet(address indexed attester, bool allowed);
    event Attested(
        uint256 indexed tokenId,
        address indexed attester,
        bytes32 indexed taskType,
        bool success,
        uint16 quality,
        bytes32 dataHash,
        string uri
    );

    event SimAttesterSet(address indexed attester, bool allowed);
    event SimAttested(uint256 indexed tokenId, address indexed attester, bool success, uint16 quality, bytes32 dataHash);
    event SimBatch(address indexed attester, uint256 count, uint256 accepted, string uri);
    event SimRejected(uint256 indexed tokenId, bytes32 dataHash, uint8 reason); // 1 quality 2 hash 3 dup 4 unknown 5 cap

    error BatchSize();
    error NotAttester();
    error InvalidQuality();
    error DataAlreadyAttested();
    error EmptyDataHash();
    error UnknownAgent();
    error InvalidAgents();
    error RenounceDisabled();

    constructor(address agents_, address initialOwner) Ownable(initialOwner) {
        if (agents_.code.length == 0) revert InvalidAgents();
        agents = IOpenForgeAgentsHooks(agents_);
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled(); // an ownerless registry could never add or remove attesters
    }

    function setAttester(address attester, bool allowed) external onlyOwner {
        isAttester[attester] = allowed;
        emit AttesterSet(attester, allowed);
    }

    function setSimAttester(address attester, bool allowed) external onlyOwner {
        isSimAttester[attester] = allowed;
        emit SimAttesterSet(attester, allowed);
    }

    function attest(
        uint256 tokenId,
        bytes32 taskType,
        bool success,
        uint16 quality,
        bytes32 dataHash,
        string calldata uri
    ) external {
        if (!isAttester[msg.sender]) revert NotAttester();
        if (quality > 10_000) revert InvalidQuality();
        if (dataHash == bytes32(0)) revert EmptyDataHash();
        bytes32 key = keccak256(abi.encode(tokenId, dataHash)); // per-agent: nobody can squat another agent's hashes
        if (dataUsed[key]) revert DataAlreadyAttested();
        // reverts if the token does not exist
        try agents.ownerOf(tokenId) returns (address) {} catch {
            revert UnknownAgent();
        }

        dataUsed[key] = true;
        Stats storage s = _stats[tokenId];
        unchecked {
            ++s.tasks;
            if (success) ++s.successes;
            else ++s.failures;
            s.dataPoints += quality / 100;
        }
        s.lastAttestedAt = uint64(block.timestamp);

        emit Attested(tokenId, msg.sender, taskType, success, quality, dataHash, uri);
        // a metadata refresh must never block an attestation
        try agents.refreshMetadata(tokenId) {} catch {}
    }

    /// @notice Batch-attest simulation runs (the verifier checks each holder's EIP-712 signature off-chain; on-chain
    ///         trust is the sim attester role, capped per token per day). Sim stats never touch real task stats.
    function attestSimBatch(SimResult[] calldata results, string calldata uri) external {
        if (!isSimAttester[msg.sender]) revert NotAttester();
        uint256 n = results.length;
        if (n == 0 || n > 100) revert BatchSize();
        uint256 accepted;
        uint256 lastToken = type(uint256).max;
        for (uint256 i = 0; i < n; i++) {
            SimResult calldata r = results[i];
            uint8 reason = _simReject(r);
            if (reason != 0) {
                emit SimRejected(r.tokenId, r.dataHash, reason); // a bad item never blocks the batch
                continue;
            }
            dataUsed[_simKey(r)] = true;
            SimStats storage ss = _simStats[r.tokenId];
            unchecked {
                ++accepted;
                ++ss.runs;
                ++ss.dayCount;
                if (r.success) {
                    ++ss.successes;
                    ss.points += r.quality / 100;
                }
            }
            ss.lastRunAt = uint64(block.timestamp);
            emit SimAttested(r.tokenId, msg.sender, r.success, r.quality, r.dataHash);
            if (r.tokenId != lastToken) {
                lastToken = r.tokenId;
                try agents.refreshMetadata(r.tokenId) {} catch {}
            }
        }
        emit SimBatch(msg.sender, n, accepted, uri);
    }

    /// @dev 0 = ok, 1 InvalidQuality, 2 EmptyDataHash, 3 Duplicate, 4 UnknownAgent, 5 DailyCap. Rolls the daily counter.
    function _simReject(SimResult calldata r) private returns (uint8) {
        if (r.quality > 10_000) return 1;
        if (r.dataHash == bytes32(0)) return 2;
        if (dataUsed[_simKey(r)]) return 3;
        try agents.ownerOf(r.tokenId) returns (address) {} catch {
            return 4;
        }
        SimStats storage ss = _simStats[r.tokenId];
        uint32 today = uint32(block.timestamp / 1 days);
        if (ss.day != today) {
            ss.day = today;
            ss.dayCount = 0;
        }
        if (ss.dayCount >= SIM_DAILY_CAP) return 5;
        return 0;
    }

    /// @dev Separate key space from attest(): a sim attester must not be able to squat hashes of real attestations.
    function _simKey(SimResult calldata r) private pure returns (bytes32) {
        return keccak256(abi.encode("SIM", r.tokenId, r.dataHash));
    }

    function simPointsOf(uint256 tokenId) external view returns (uint64) {
        return _simStats[tokenId].points;
    }

    function simStatsOf(uint256 tokenId) external view returns (uint32 runs, uint32 successes) {
        SimStats storage s = _simStats[tokenId];
        return (s.runs, s.successes);
    }

    function statsOf(uint256 tokenId)
        external
        view
        returns (uint32 tasks, uint32 successes, uint32 failures, uint64 dataPoints)
    {
        Stats storage s = _stats[tokenId];
        return (s.tasks, s.successes, s.failures, s.dataPoints);
    }

    /// @return tier 0 Rookie, 1 Apprentice, 2 Operator, 3 Veteran, 4 Elite
    function tierOf(uint256 tokenId) public view returns (uint8 tier) {
        uint64 p = _stats[tokenId].dataPoints;
        for (uint8 i = 0; i < 4; i++) {
            if (p >= tierThresholds[i]) tier = i + 1;
        }
    }

    function tierName(uint8 tier) public pure returns (string memory) {
        if (tier == 0) return "Rookie"; // same as AgentRenderer ("Dormant" means unrevealed)
        if (tier == 1) return "Apprentice";
        if (tier == 2) return "Operator";
        if (tier == 3) return "Veteran";
        return "Elite";
    }
}
