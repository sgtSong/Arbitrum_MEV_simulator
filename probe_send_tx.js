import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { publicKeyToAddress } from "viem/accounts";

dotenv.config();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch tx receipt + block to compute placement inside the block.
async function getPlacement(provider, txHash, attempts = 140, delayMs = 20) {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
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
    const relative = total > 1 ? idx / (total - 1) : 0;
    const durationMs = Date.now() - startMs;
    const completedAt = new Date().toISOString();
    return {
        txHash,
        blockNumber: block.number,
        txIndex: idx,
        totalTxs: total,
        relative,
        startedAt,
        completedAt,
        durationMs,
    };
}

async function sendRawTx({ wallet, rpcUrl, nonce, feeData, chainId, id }) {
    const tx = {
        to: wallet.address,
        value: 0,
        nonce,
        gasLimit: 100000n,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        chainId,
    };

    const signed = await wallet.signTransaction(tx);
    const payload = {
        jsonrpc: "2.0",
        method: "eth_sendRawTransaction",
        params: [signed],
        id,
    };

    const sentAt = new Date().toISOString();
    const start = Date.now();
    console.log(`[${id}] POSTing tx (nonce ${nonce}) at ${sentAt}`);
    const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const body = await res.json();
    const durationMs = Date.now() - start;
    const responseAt = new Date().toISOString();

    console.log(`[${id}] RPC response in ${durationMs}ms (status ${res.status}) at ${responseAt}: ${JSON.stringify(body)}`);

    if (!body || body.error || !body.result) {
        const msg = body && body.error ? body.error.message : "unknown error";
        throw new Error(`RPC send failed (${msg})`);
    }

    return { txHash: body.result, sentAt, responseAt, durationMs };
}

// Variant that derives tx hash locally and returns immediately after dispatching.
async function sendRawTxLocalHash({ wallet, rpcUrl, nonce, feeData, chainId, id }) {
    const tx = {
        to: wallet.address,
        value: 0,
        nonce,
        gasLimit: 100000n,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        chainId,
    };

    const signed = await wallet.signTransaction(tx);
    const txHash = ethers.keccak256(signed);

    const payload = {
        jsonrpc: "2.0",
        method: "eth_sendRawTransaction",
        params: [signed],
        id,
    };

    const sentAt = new Date().toISOString();
    console.log(`[${id}] POSTing tx (nonce ${nonce}) locally hashed ${txHash} at ${sentAt}`);

    // Fire request but do not wait for response to return hash immediately.
    fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    })
        .then(async (res) => {
            const body = await res.json().catch(() => undefined);
            console.log(`[${id}] RPC response (status ${res.status}) for ${txHash}: ${JSON.stringify(body)}`);
        })
        .catch((err) => {
            console.error(`[${id}] RPC send error for ${txHash}: ${err.message || err}`);
        });

    return { txHash, sentAt };
}



async function sendTwoRawTransactions({ wallet, rpcUrl, nonce, feeData, chainId, id }) {
    const txs = [nonce, nonce + 1].map((n) => ({
        to: wallet.address,
        value: 0,
        nonce: n,
        gasLimit: 100000n,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        chainId,
    }));

    const signed = [];
    for (const tx of txs) {
        signed.push(await wallet.signTransaction(tx));
    }

    const makeId = (idx) => {
        if (typeof id === "number") return id + idx;
        if (id !== undefined) return `${id}-${idx + 1}`;
        return idx + 1;
    };

    const payloads = signed.map((raw, idx) => ({
        jsonrpc: "2.0",
        method: "eth_sendRawTransaction",
        params: [raw],
        id: makeId(idx),
    }));


    const txResults = [null, null];
    const submissions = payloads.map((payload, idx) => {
        const delay = idx * 50; // stagger second tx by 50ms; first fires immediately

        return new Promise((resolve) => {
            setTimeout(() => {
                const sentAt = new Date().toISOString();
                console.log(`[${sentAt}] Sending raw tx ${idx + 1}/2 (nonce ${txs[idx].nonce})...`);
                const startTime = Date.now();

                fetch(rpcUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                })
                .then(async (response) => {
                    const result = await response.json();
                    const duration = Date.now() - startTime;
                    const responseAt = new Date().toISOString();

                    if (result && !result.error && result.result) {
                        txResults[idx] = { txHash: result.result, sentAt, responseAt, durationMs: duration };
                        console.log(`Raw tx ${idx + 1} hash received in ${duration}ms`);
                    } else {
                        const msg = result && result.error ? result.error.message : "unknown";
                        console.error(`Raw tx ${idx + 1} failed: ${msg}`);
                    }
                })
                .catch((err) => {
                    console.error(`Raw tx ${idx + 1} network error: ${err.message}`);
                })
                .finally(() => {
                    resolve();
                });
            }, delay);
        });
    });

    await Promise.all(submissions);
    return txResults;
}

async function main() {
    const args = process.argv.slice(2);
    const rounds = parseInt(args[0]);
    const periodMs = parseInt(args[1]); // gap between first tx of each round
    const startMs = args[2] !== undefined ? parseInt(args[2]) : undefined; // optional target ms alignment (0-999)
    const relativeThreshold = args[3] !== undefined ? parseFloat(args[3]) : 0.5;

    if (isNaN(rounds) || rounds <= 0 || isNaN(periodMs) || periodMs <= 0) {
        console.error("Usage: node main_send_tx_history.js <rounds> <period_ms> [start_ms] [relative_threshold]");
        console.error("Example: node main_send_tx_history.js 5 1500 700 0.5");
        process.exit(1);
    }

    if (startMs !== undefined && (isNaN(startMs) || startMs < 0 || startMs > 999)) {
        console.error("If provided, <start_ms> must be an integer between 0 and 999");
        process.exit(1);
    }

    if (isNaN(relativeThreshold) || relativeThreshold < 0 || relativeThreshold > 1) {
        console.error("If provided, <relative_threshold> must be between 0 and 1");
        process.exit(1);
    }

    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) throw new Error("PRIVATE_KEY missing in .env");

    // // main net
    // const rpcUrl = "https://arb1-sequencer.arbitrum.io/rpc";    // Sequencer
    // const rpcNodeUrl = "https://arb1.arbitrum.io/rpc"; // RPC Node
    // test net
    const rpcUrl = "https://sepolia-rollup-sequencer.arbitrum.io/rpc";    // Sequencer
    const rpcNodeUrl = "https://sepolia-rollup.arbitrum.io/rpc"; // RPC Node

    const provider = new ethers.JsonRpcProvider(rpcNodeUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log(`Running ${rounds} rounds for ${wallet.address} (period ${periodMs}ms, threshold ${relativeThreshold})`);

    let nextNonce = await provider.getTransactionCount(wallet.address);
    const feeData = await provider.getFeeData();
    const chainId = (await provider.getNetwork()).chainId;
    console.log(`Starting nonce: ${nextNonce}, chainId: ${chainId}`);

    // Align to requested millisecond offset if provided (only before first round)
    const now = Date.now();
    const currentMs = now % 1000;
    if (startMs !== undefined) {
        let initialDelay = startMs - currentMs;
        if (initialDelay <= 0) initialDelay += 1000;
        console.log(`Current ms ${currentMs}, target ${startMs}, waiting ${initialDelay}ms before first tx`);
        await sleep(initialDelay);
    }

    const results = [];

    for (let round = 0; round < rounds; round++) {
        const roundInfo = { round: round + 1, first: null, seconds: [], conditionMet: false, error: null, elapsedMs: null };
        console.log(`=== Round ${round + 1}/${rounds} starting ===`);
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const nonce1 = nextNonce++;
                console.log(`[round ${round + 1}] Sending first tx (nonce ${nonce1})...`);
                // const firstSend = await sendRawTx({ wallet, rpcUrl, nonce: nonce1, feeData, chainId, id: `r${round + 1}-t1` });
                const firstSend = await sendRawTxLocalHash({ wallet, rpcUrl, nonce: nonce1, feeData, chainId, id: `r${round + 1}-t1` });
                // await sleep(20);
                const placement1 = await getPlacement(provider, firstSend.txHash);
                roundInfo.first = { ...firstSend, placement: placement1 };
                console.log(`[round ${round + 1}] First tx placed rel=${placement1.relative.toFixed(4)} block=${placement1.blockNumber} (getPlacement ${placement1.durationMs}ms)`);

                if (placement1.relative >= relativeThreshold && placement1.relative < 1.0) {
                    roundInfo.conditionMet = true;
                    console.log(`[round ${round + 1}] Threshold met (${placement1.relative.toFixed(4)} > ${relativeThreshold}); sending DCAT follow-up txs with 50ms gap...`);

                    const baseMs = Date.parse(firstSend.sentAt);
                    const nowMs = Date.now();
                    const elapsedMs = nowMs - baseMs;
                    roundInfo.elapsedMs = elapsedMs;
                    const remainder = elapsedMs % 250;
                    const waitMs = remainder === 0 ? 0 : 250 - remainder;
                    if (waitMs > 0) {
                        console.log(`[round ${round + 1}] Waiting ${waitMs}ms to align with 250ms boundary from first tx`);
                        await sleep(waitMs);
                    }

                    const sendRes = await sendTwoRawTransactions({ wallet, rpcUrl, nonce: nextNonce, feeData, chainId, id: `r${round + 1}-t2` });
                    let secondSends = [];
                    secondSends.push({ idx: 0, sendRes: sendRes[0]});
                    secondSends.push({ idx: 1, sendRes: sendRes[1]});
                    nextNonce += 2;

                    for (const { idx, sendRes } of secondSends) {
                        const placement = await getPlacement(provider, sendRes.txHash);
                        roundInfo.seconds.push({ ...sendRes, placement });
                        console.log(`[round ${round + 1}] Follow-up tx ${idx + 1}/2 placed rel=${placement.relative.toFixed(4)} block=${placement.blockNumber} (getPlacement ${placement.durationMs}ms)`);
                    }

                    break; // success, exit retry loop
                } else {
                    console.log(`[round ${round + 1}] Relative position ${placement1.relative.toFixed(4)} <= ${relativeThreshold}; skipping follow-up txs.`);
                    await sleep(53);
                }
            } catch (err) {
                roundInfo.error = err.message || String(err);
                console.error(`[round ${round + 1}] Error: ${roundInfo.error}`);
            }
        }
        results.push(roundInfo);

        // Wait periodMs before next round, except after the last round
        if (round < rounds - 1) {
            console.log(`[round ${round + 1}] Waiting ${periodMs}ms before next round...`);
            await sleep(periodMs);
        }
        console.log("");
    }

    console.log("All rounds completed. Writing placement_data.json and placement_chart.html...");

    const outputDir = path.join(process.cwd(), "data");
    fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(
        path.join(outputDir, "placement_data.json"),
        JSON.stringify({
            createdAt: new Date().toISOString(),
            address: wallet.address,
            periodMs,
            threshold: relativeThreshold,
            rounds: results,
        }, null, 2)
    );

    let dcatSuccessCount = 0;
    let dcatAttemptCount = 0;
    let elapsedTotalMs = 0;
    let elapsedCount = 0;

    const tableRows = results.map((r) => {
        const firstBlock = r.first?.placement?.blockNumber ?? "n/a";
        const firstRel = r.first?.placement?.relative !== undefined ? r.first.placement.relative.toFixed(4) : "n/a";
        const elapsedMsDisplay = Number.isFinite(r.elapsedMs) ? r.elapsedMs : "n/a";
        if (Number.isFinite(r.elapsedMs)) {
            elapsedTotalMs += r.elapsedMs;
            elapsedCount += 1;
        }

        const sender = r.seconds[0];
        const receiver = r.seconds[1];

        const senderBlock = sender?.placement?.blockNumber ?? "n/a";
        const receiverBlock = receiver?.placement?.blockNumber ?? "n/a";
        const senderRel = sender?.placement?.relative !== undefined ? sender.placement.relative.toFixed(4) : "n/a";
        const receiverRel = receiver?.placement?.relative !== undefined ? receiver.placement.relative.toFixed(4) : "n/a";

        const senderHasBlock = sender?.placement?.blockNumber !== undefined;
        const receiverHasBlock = receiver?.placement?.blockNumber !== undefined;

        let dcatSuccessDisplay = "n/a";
        if (senderHasBlock && receiverHasBlock) {
            dcatAttemptCount += 1;
            const success = sender.placement.blockNumber !== receiver.placement.blockNumber;
            if (success) dcatSuccessCount += 1;
            dcatSuccessDisplay = success ? "true" : "false";
        }

        return `<tr><td>${r.round}</td><td>${firstBlock}</td><td>${firstRel}</td><td>${elapsedMsDisplay}</td><td>${senderBlock}</td><td>${receiverBlock}</td><td>${senderRel}</td><td>${receiverRel}</td><td>${dcatSuccessDisplay}</td></tr>`;
    }).join("");

    const successRatio = dcatAttemptCount > 0
        ? `${dcatSuccessCount}/${dcatAttemptCount} (${((dcatSuccessCount / dcatAttemptCount) * 100).toFixed(1)}%)`
        : "n/a";

    const avgElapsedMs = elapsedCount > 0 ? (elapsedTotalMs / elapsedCount).toFixed(1) : "n/a";

    const txLabels = ["probe transaction", "DCAT_sender", "DCAT_receiver"];
    const colorPalette = ["#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"];
    const chartData = results.map((r, idx) => {
        const color = colorPalette[idx % colorPalette.length];
        const points = [];
        if (r.first?.placement?.relative !== undefined) {
            points.push({ x: "probe transaction", y: r.first.placement.relative, block: r.first.placement.blockNumber, sentAt: r.first.sentAt });
        }
        if (Array.isArray(r.seconds) && r.seconds.length) {
            r.seconds.forEach((s, idx) => {
                if (s?.placement?.relative !== undefined) {
                    const label = idx === 0 ? "DCAT_sender" : "DCAT_receiver";
                    points.push({ x: label, y: s.placement.relative, block: s.placement.blockNumber, sentAt: s.sentAt });
                }
            });
        }
        return {
            label: `round ${idx + 1}`,
            data: points,
            backgroundColor: color,
            pointBackgroundColor: color,
            pointBorderColor: color,
            borderColor: "rgba(248, 74, 74, 0.25)",
            showLine: points.length >= 2,
            borderWidth: 1,
            tension: 0,
        };
    });

    chartData.push({
        type: "line",
        label: "threshold",
        data: txLabels.map((x) => ({ x, y: relativeThreshold })),
        borderColor: "#000",
        backgroundColor: "#000",
        pointRadius: 0,
        borderDash: [4, 3],
        borderWidth: 2,
        tension: 0,
    });

    const html = `<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <title>Tx Placement Summary</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 16px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
        th { background: #f0f0f0; }
        .chart-wrap { margin-top: 18px; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
    <h3>Tx placement summary</h3>
    <p>Rounds: ${rounds}, period: ${periodMs}ms, threshold: ${relativeThreshold}, DCAT success: ${successRatio}, avg elapsed: ${avgElapsedMs}ms</p>
    <table>
        <thead><tr><th>Round</th><th>First block</th><th>First rel</th><th>Elapsed ms</th><th>DCAT Sender block</th><th>DCAT Receiver block</th><th>DCAT Sender rel</th><th>DCAT Receiver rel</th><th>DCAT success</th></tr></thead>
        <tbody>${tableRows}</tbody>
    </table>
    <div class="chart-wrap">
        <h4>Relative position per round</h4>
        <canvas id="chart" width="960" height="480"></canvas>
    </div>
    <script>
        const txLabels = ${JSON.stringify(txLabels)};
        const chartData = ${JSON.stringify(chartData)};
        const ctx = document.getElementById('chart').getContext('2d');
        new Chart(ctx, {
            type: 'scatter',
            data: { datasets: chartData },
            options: {
                scales: {
                    x: { type: 'category', labels: txLabels, title: { display: true, text: 'transaction role (probe / DCAT sender / DCAT receiver)' } },
                    y: { min: 0, max: 1, title: { display: true, text: 'relative position (tx index / tx count)' } }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const d = ctx.raw;
                                if (ctx.dataset.label === 'threshold') return 'threshold: ' + d.y.toFixed(4);
                                const block = d.block ? (' block ' + d.block) : '';
                                const sent = d.sentAt ? (' sent ' + d.sentAt) : '';
                                return ctx.dataset.label + ' ' + d.x + ' tx: ' + d.y.toFixed(4) + block + sent;
                            }
                        }
                    },
                    legend: {
                        display: true,
                        labels: {
                            filter: (item) => {
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
}

main();
