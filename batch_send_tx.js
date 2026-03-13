import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch tx receipt + block to compute placement inside the block.
async function getPlacement(provider, txHash, attempts = 12, delayMs = 2000) {
    let receipt;
    for (let i = 0; i < attempts; i++) {
        receipt = await provider.getTransactionReceipt(txHash);
        if (receipt && receipt.blockNumber !== null) break;
        await sleep(delayMs);
    }
    if (!receipt || receipt.blockNumber === null) {
        throw new Error(`Receipt not found for ${txHash}`);
    }

    let block;
    for (let i = 0; i < attempts; i++) {
        block = await provider.getBlock(receipt.blockNumber);
        if (block && Array.isArray(block.transactions) && block.transactions.length) break;
        await sleep(delayMs);
    }
    if (!block || !Array.isArray(block.transactions) || block.transactions.length === 0) {
        throw new Error(`Block ${receipt.blockNumber} empty or unavailable for ${txHash}`);
    }

    const target = txHash.toLowerCase();
    const idx = block.transactions.findIndex((t) => (typeof t === "string" ? t.toLowerCase() : "") === target);
    if (idx === -1) throw new Error(`Tx ${txHash} not found in block ${receipt.blockNumber}`);

    const total = block.transactions.length;
    // Use 0..1 scale where last tx => 1. Guard when only 1 tx.
    const relative = total > 1 ? idx / (total - 1) : 0;
    return {
        txHash,
        blockNumber: block.number,
        txIndex: idx,
        totalTxs: total,
        relative,
    };
}



async function main() {
    // 1. Parse CLI Argument
    const args = process.argv.slice(2);
    const txsPerRound = parseInt(args[0]);
    const rounds = parseInt(args[1]);
    const txDelayMs = parseInt(args[2]); // delay between txs inside a round

    // Optional args: start ms (per second alignment) and gap between rounds
    const startArg = args[3];
    const roundGapArg = args[4];

    let startMs = undefined;
    let immediate = false;
    let roundGapMs = 1000; // default: one round per second

    if (startArg === undefined) {
        immediate = true;
    } else {
        startMs = parseInt(startArg);
    }

    if (roundGapArg !== undefined) {
        roundGapMs = parseInt(roundGapArg);
    }

    if (
        isNaN(txsPerRound) || txsPerRound <= 0 ||
        isNaN(rounds) || rounds <= 0 ||
        isNaN(txDelayMs) || txDelayMs < 0
    ) {
        console.error("Usage: node main_send_tx.js <txs_per_round> <rounds> <tx_delay_ms> [start_ms] [round_gap_ms]");
        console.error("Example: node main_send_tx.js 5 4 250 711 1500  (omit start_ms to send immediately, omit round_gap_ms for 1000ms)");
        process.exit(1);
    }

    if (!immediate && (isNaN(startMs) || startMs < 0 || startMs > 999)) {
        console.error("If provided, <start_ms> must be an integer between 0 and 999");
        process.exit(1);
    }

    if (isNaN(roundGapMs) || roundGapMs <= 0) {
        console.error("If provided, <round_gap_ms> must be a positive integer");
        process.exit(1);
    }
    
    // Safety Limits (Batch sizes > 100 often get rejected by public RPCs)
    if (txsPerRound > 50) {
        console.warn("Warning: Large tx counts (>50) might be rejected by public RPC endpoints.");
    }

    // 2. Setup (Arbitrum Sepolia)
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) throw new Error("PRIVATE_KEY missing in .env");


    // // 2. CONNECT: Arbitrum One RPC Endpoint (HTTPS)
    // // Chain ID: 42161
    // const rpcUrl = "https://arb1.arbitrum.io/rpc"; 
    // const rpcUrl = "https://sepolia-rollup.arbitrum.io/rpc";

    // // main net
    // const rpcUrl = "https://arb1-sequencer.arbitrum.io/rpc";    // Sequencer
    // const rpcNodeUrl = "https://arb1.arbitrum.io/rpc"; // RPC Node
    // test net
    const rpcUrl = "https://sepolia-rollup-sequencer.arbitrum.io/rpc";    // Sequencer
    const rpcNodeUrl = "https://sepolia-rollup.arbitrum.io/rpc"; // RPC Node
    const provider = new ethers.JsonRpcProvider(rpcNodeUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log(`Preparing ${txsPerRound} transactions per round for ${wallet.address}...`);

    // 3. Fetch Network Data ONCE
    // We get the starting nonce and current fee data
    let startNonce = await provider.getTransactionCount(wallet.address);
    const feeData = await provider.getFeeData();
    const chainId = (await provider.getNetwork()).chainId;

    console.log(`Starting Nonce: ${startNonce}`);
    console.log(`Chain ID: ${chainId}`);

    // 4. Create & Sign ALL Transactions Upfront
    console.log(`Generating and signing all ${rounds} rounds (txs per round: ${txsPerRound})...`);
    const allRounds = [];

    for (let round = 0; round < rounds; round++) {
        const signedRound = [];

        for (let i = 0; i < txsPerRound; i++) {
            const currentNonce = startNonce + i;

            const tx = {
                to: wallet.address,
                value: 0,
                nonce: currentNonce,
                gasLimit: 100000n,
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
                chainId: chainId
            };

            const signedTx = await wallet.signTransaction(tx);
            signedRound.push({
                jsonrpc: "2.0",
                method: "eth_sendRawTransaction",
                params: [signedTx],
                id: i + 1
            });
            console.log(JSON.stringify(signedRound[signedRound.length - 1]));
        }

        allRounds.push(signedRound);
        startNonce += txsPerRound;
    }

    // 5. Submit txs with Strict Scheduling
    console.log(`Scheduling ${rounds} rounds (tx delay inside round: ${txDelayMs}ms, round gap: ${roundGapMs}ms)...`);
    
    // Calculate initial delay to align with target milliseconds (or 0 when immediate)
    const now = Date.now();
    const currentMs = now % 1000;

    let initialDelay = 0;
    if (!immediate) {
        initialDelay = startMs - currentMs;
        if (initialDelay <= 0) {
            initialDelay += 1000;
        }

        console.log(`Current time ms: ${currentMs}, Target ms: ${startMs}`);
        console.log(`Waiting ${initialDelay}ms to align with target time...`);
    } else {
        console.log(`No target ms provided — sending immediately.`);
    }

    const submissionPromises = [];
    const perTxHashes = Array.from({ length: rounds }, () => Array(txsPerRound).fill(null));
    
    for (let round = 0; round < rounds; round++) {
        for (let i = 0; i < txsPerRound; i++) {
            const payload = allRounds[round][i];
            const delay = initialDelay + (round * roundGapMs) + (i * txDelayMs);

            const p = new Promise((resolve) => {
                setTimeout(() => {
                    console.log(`[${new Date().toISOString()}] Sending round ${round + 1}/${rounds}, tx ${i + 1}/${txsPerRound}...`);
                    const startTime = Date.now();

                    fetch(rpcUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    })
                    .then(async (response) => {
                        const result = await response.json();
                        const duration = Date.now() - startTime;

                        if (result && !result.error && result.result) {
                            perTxHashes[round][i] = result.result;
                            console.log(`Round ${round + 1}, tx ${i + 1} hash received in ${duration}ms`);
                        } else {
                            const msg = result && result.error ? result.error.message : "unknown";
                            console.error(`Round ${round + 1}, tx ${i + 1} failed: ${msg}`);
                        }
                    })
                    .catch((err) => {
                        console.error(`Round ${round + 1}, tx ${i + 1} network error: ${err.message}`);
                    })
                    .finally(() => {
                        resolve();
                    });

                }, delay);
            });
            
            submissionPromises.push(p);
        }
    }

    // Wait for all network requests to complete before exiting
    await Promise.all(submissionPromises);

    console.log("All tx submissions completed. Fetching placements and rendering chart...");

    const tasks = [];
    for (let round = 0; round < rounds; round++) {
        for (let i = 0; i < txsPerRound; i++) {
            const txHash = perTxHashes[round][i];
            if (!txHash) continue;
            tasks.push({ round, index: i, txHash });
        }
    }

    const placementsByIndex = Array.from({ length: txsPerRound }, () => []);
    const placementsByRound = Array.from({ length: rounds }, () => []);
    const roundBlockNumbers = Array.from({ length: rounds }, () => []);
    const errors = [];
    const chunkSize = 5;

    for (let k = 0; k < tasks.length; k += chunkSize) {
        const chunk = tasks.slice(k, k + chunkSize).map(info =>
            getPlacement(provider, info.txHash)
                .then(p => ({ ...p, round: info.round, index: info.index }))
                .catch(err => ({ error: err.message, ...info }))
        );
        const results = await Promise.all(chunk);
        for (const res of results) {
            if (res.error) {
                errors.push(res);
            } else {
                placementsByIndex[res.index].push(res);
                placementsByRound[res.round].push(res);
                roundBlockNumbers[res.round].push(res.blockNumber);
            }
        }
    }

    // Log all placements for visibility
    console.log("Relative positions (txIndexInRound, rel, block, txHash):");
    placementsByIndex.forEach((arr, idx) => {
        arr.forEach(p => {
            console.log(`round ${p.round + 1}, tx ${idx}, rel=${p.relative.toFixed(4)}, block=${p.blockNumber}, hash=${p.txHash}`);
        });
    });

    const roundFirstBlocks = roundBlockNumbers.map(arr => (arr.length ? Math.min(...arr) : null));
    const roundBlockDiffs = [];
    for (let i = 1; i < roundFirstBlocks.length; i++) {
        if (roundFirstBlocks[i] !== null && roundFirstBlocks[i - 1] !== null) {
            roundBlockDiffs.push(roundFirstBlocks[i] - roundFirstBlocks[i - 1]);
        } else {
            roundBlockDiffs.push(null);
        }
    }

    console.log("First block number per round:", roundFirstBlocks);
    console.log("Block number deltas between consecutive rounds:", roundBlockDiffs);

    const averages = placementsByIndex.map(arr => {
        if (!arr.length) return 0;
        return arr.reduce((acc, x) => acc + x.relative, 0) / arr.length;
    });

    const outputDir = path.join(process.cwd(), "data");
    fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(
        path.join(outputDir, "placement_data.json"),
        JSON.stringify({ placementsByIndex, averages, errors, roundFirstBlocks, roundBlockDiffs }, null, 2)
    );

    // Build a simple Chart.js scatter plot (x = i-th tx in round, y = relative position)
    const colors = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b"];
    const chartData = placementsByIndex.map((arr, idx) => ({
        label: `tx ${idx}`,
        data: arr.map(p => ({ x: idx, y: p.relative, round: p.round + 1, block: p.blockNumber, hash: p.txHash })),
        showLine: false,
        backgroundColor: colors[idx % colors.length],
        borderColor: colors[idx % colors.length],
        pointRadius: 4,
    }));

    // Round-level polylines connecting txs within the same round
    const roundLineColor = "#ff006e";
    placementsByRound.forEach((arr, roundIdx) => {
        if (!arr.length) return;
        const sorted = [...arr].sort((a, b) => a.index - b.index);
        chartData.push({
            type: "line",
            label: `round ${roundIdx + 1} path`,
            data: sorted.map(p => ({ x: p.index, y: p.relative, round: roundIdx + 1, block: p.blockNumber, hash: p.txHash })),
            borderColor: roundLineColor,
            backgroundColor: roundLineColor,
            pointRadius: 0,
            tension: 0.15,
            borderWidth: 2,
        });
    });

    chartData.push({
        type: "line",
        label: "average",
        data: averages.map((y, idx) => ({ x: idx, y })),
        borderColor: "#000",
        backgroundColor: "#000",
        pointRadius: 0,
        borderDash: [6, 4],
        tension: 0,
    });

    const html = `<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <title>Tx Placement Scatter</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
    <h3>Relative position inside block (tx index / tx count)</h3>
    <canvas id="chart" width="900" height="480"></canvas>
    <script>
        const data = ${JSON.stringify(chartData)};
        const ctx = document.getElementById('chart').getContext('2d');
        new Chart(ctx, {
            type: 'scatter',
            data: { datasets: data },
            options: {
                scales: {
                    x: { type: 'linear', min: -0.5, max: ${txsPerRound - 0.5}, ticks: { stepSize: 1, callback: v => v } },
                    y: { min: 0, max: 1, title: { display: true, text: 'relative position' } }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const d = ctx.raw;
                                if (ctx.dataset.label === 'average') return 'avg: ' + d.y.toFixed(4);
                                if (ctx.dataset.label && ctx.dataset.label.endsWith('path')) return 'round ' + d.round + ' path';
                                return 'round ' + d.round + ': ' + d.y.toFixed(4) + ' (block ' + d.block + ')';
                            }
                        }
                    },
                    legend: {
                        display: true,
                        labels: {
                            filter: (item) => {
                                // Hide round path series from legend; keep tx* and average.
                                return !(item.text && item.text.endsWith('path'));
                            }
                        }
                    }
                }
            }
        });
    </script>
</body>
</html>`;

    fs.writeFileSync(path.join(outputDir, "placement_chart.html"), html);
    console.log(`Wrote placement_data.json and placement_chart.html to ${outputDir}`);
    if (errors.length) {
        console.warn(`Placements with errors: ${errors.length}`);
    }
}

main();