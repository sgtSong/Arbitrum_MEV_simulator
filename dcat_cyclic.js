import { ethers } from "ethers";
import { spawn } from "child_process";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { publicKeyToAddress } from "viem/accounts";

dotenv.config();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_FOLLOW_UP_STAGGER_MS = 40;

// ABI for getting reserve
const reservesAbi = [
{ inputs: [], name: 'getReserves', outputs: [
    { internalType: 'uint112', name: '_reserve0', type: 'uint112' },
    { internalType: 'uint112', name: '_reserve1', type: 'uint112' },
    { internalType: 'uint32', name: '_blockTimestampLast', type: 'uint32' },
    ], stateMutability: 'view', type: 'function' },
]

// Swap ABI for swap call to pool contract
const pairAbi = [
  {
    inputs: [
      { internalType: 'address', name: 'tokenIn', type: 'address' },
      { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
      { internalType: 'uint256', name: 'minAmountOut', type: 'uint256' },
      { internalType: 'address', name: 'to', type: 'address' },
    ],
    name: 'swap',
    outputs: [{ "name": "amountOut", "type": "uint256" }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
]

const arbitrageBotAbi = [
    {
        inputs: [
            { internalType: 'uint256', name: 'amountKita', type: 'uint256' },
            { internalType: 'uint256', name: 'amountYatta', type: 'uint256' },
            { internalType: 'uint256', name: 'amountItta', type: 'uint256' },
            { internalType: 'address', name: 'recipient', type: 'address' },
        ],
        name: 'executeTripleSwap',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
    },
]

const transferEventSigHash = ethers.id("Transfer(address,address,uint256)");

function formatThresholdForFilename(value) {
    return String(value).replace(/\./g, "p");
}

function buildTransferDataFileName(delayMs, threshold, competitor) {
    const competitorTag = competitor ? "yes" : "no";
    return `transfer_data_delay-${delayMs}_threshold-${formatThresholdForFilename(threshold)}_competitor-${competitorTag}.json`;
}

function topicToAddress(topic) {
    return ethers.getAddress(`0x${topic.slice(26)}`);
}

async function getTransferTotals(provider, txHash, tokenInOwner, tokenOutRecipient) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error(`Receipt not found for ${txHash} while parsing transfers`);

    const tokenInOwnerLc = tokenInOwner.toLowerCase();
    const tokenOutRecipientLc = tokenOutRecipient.toLowerCase();

    let tokenInAmount = 0n;
    let tokenOutAmount = 0n;

    for (const log of receipt.logs) {
        if (!Array.isArray(log.topics) || log.topics.length < 3) continue;
        if ((log.topics[0] || "").toLowerCase() !== transferEventSigHash.toLowerCase()) continue;

        const from = topicToAddress(log.topics[1]).toLowerCase();
        const to = topicToAddress(log.topics[2]).toLowerCase();
        const amount = BigInt(log.data);

        if (from === tokenInOwnerLc) tokenInAmount += amount;
        if (to === tokenOutRecipientLc) tokenOutAmount += amount;
    }

    return {
        tokenInRaw: tokenInAmount.toString(),
        tokenOutRaw: tokenOutAmount.toString(),
    };
}

async function prepareSwapSignedTx(provider, wallet, pairContract, poolPair, tokenIn, amountTokenIn, nonce, feeData, chainId) {
    const reserves = await pairContract.getReserves();
    
    const reserveItta = reserves[0];
    const reserveKita = reserves[1];

    // console.log("[swap] ITTA reserve:", reserveItta.toString());
    // console.log("[swap] KITA reserve:", reserveKita.toString());
    
    let reserveIn, reserveOut;

    if (tokenIn === poolPair[0].address) {
        reserveIn = reserveItta;
        reserveOut = reserveKita;
    } else if (tokenIn === poolPair[1].address) {
        reserveIn = reserveKita;
        reserveOut = reserveItta;
    } else {
        throw new Error("[swap] Wrong name for tokenIn.");
    }


    // Calculate amountOut (0.3% fee)
    const amountInWithFee = amountTokenIn * 997n / 1000n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn + amountInWithFee;
    const amountOut = numerator / denominator;

    const iface = new ethers.Interface(pairAbi);
    const data = iface.encodeFunctionData("swap", [tokenIn, amountTokenIn, 0n, wallet.address]);

    // console.log("pairContract address:", pairContract.target);

    const gasEstimate = await provider.estimateGas({
        to: pairContract.target,
        from: wallet.address,
        data,
    });

    const txRequest = {
        to: pairContract.target,
        data,
        value: 0,
        gasLimit: gasEstimate + 20000n, // add buffer
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        nonce,
        chainId: chainId,
    };

    const signedTx = await wallet.signTransaction(txRequest);

    // console.log("[swap] Prepared signed transaction with nonce", txRequest, nonce);

    return signedTx;
}


async function prepareArbitrageSignedTx(provider, wallet, arbitrageBotAddress, amountKita, amountYatta, amountItta, recipient, nonce, feeData, chainId) {
    const iface = new ethers.Interface(arbitrageBotAbi);
    const data = iface.encodeFunctionData("executeTripleSwap", [amountKita, amountYatta, amountItta, recipient]);

    const gasEstimate = await provider.estimateGas({
        to: arbitrageBotAddress,
        from: wallet.address,
        data,
    });

    const txRequest = {
        to: arbitrageBotAddress,
        data,
        value: 0,
        gasLimit: gasEstimate + 30000n, // add buffer for token transfers + 3 external swaps
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        nonce,
        chainId: chainId,
    };

    const signedTx = await wallet.signTransaction(txRequest);
    return signedTx;
}

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

// Variant that derives tx hash locally and returns immediately after dispatching.
async function sendRawTxLocalHash({ wallet, rpcUrl, nonce, feeData, chainId, id, signedTx = null }) {
    let signed = signedTx;
    
    if (!signedTx){
        const tx = {
            to: wallet.address,
            value: 0,
            nonce,
            gasLimit: 100000n,
            maxFeePerGas: feeData.maxFeePerGas,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
            chainId,
        };

        signed = await wallet.signTransaction(tx);
    }

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


async function sendTwoRawTransactions({ wallet, rpcUrl, nonce, feeData, chainId, id, signedTx = null, followUpStaggerMs = DEFAULT_FOLLOW_UP_STAGGER_MS }) {
    let signed = signedTx;

    if (!signed) {
        const txs = [nonce, nonce + 1].map((n) => ({
            to: wallet.address,
            value: 0,
            nonce: n,
            gasLimit: 100000n,
            maxFeePerGas: feeData.maxFeePerGas,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
            chainId,
        }));

        signed = [];
        for (const tx of txs) {
            signed.push(await wallet.signTransaction(tx));
        }
        console.log("[Warning] You should increment nonce value by 2 when calling this function without signedTx to avoid nonce collision.");
    }
    else {
        signed = Array.isArray(signedTx) ? signedTx : [signedTx];
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
        const delay = idx * followUpStaggerMs; // stagger second tx by configured delay; first fires immediately

        return new Promise((resolve) => {
            setTimeout(() => {
                const sentAt = new Date().toISOString();
                console.log(`[${sentAt}] Sending raw tx ${idx + 1}/2 ...`);
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
    const followUpStaggerMs = args[4] !== undefined ? parseInt(args[4]) : DEFAULT_FOLLOW_UP_STAGGER_MS;
    const runCompetitor = args[5] !== undefined
        ? ["1", "true", "yes", "competitor"].includes(String(args[5]).toLowerCase())
        : false;

    if (isNaN(rounds) || rounds <= 0 || isNaN(periodMs) || periodMs <= 0) {
        console.error("Usage: node conduct_ditto.js <rounds> <period_ms> [start_ms] [relative_threshold] [follow_up_stagger_ms] [competitor]");
        console.error("Example: node conduct_ditto.js 5 1500 700 0.5 290 competitor");
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

    if (isNaN(followUpStaggerMs) || followUpStaggerMs < 0) {
        console.error("If provided, <follow_up_stagger_ms> must be a non-negative integer");
        process.exit(1);
    }

    let competitorProcess = null;
    const stopCompetitor = () => {
        if (competitorProcess && !competitorProcess.killed) {
            competitorProcess.kill("SIGINT");
        }
        competitorProcess = null;
    };

    const privateKey1 = process.env.PRIVATE_KEY2;   // DCAT Sender
    const privateKey2 = process.env.PRIVATE_KEY1;   // DCAT Receiver
    const privateKey3 = process.env.PRIVATE_KEY3;   // Background Tx sender (optional, can reuse sender keys if not provided)
    const privateKey4 = process.env.PRIVATE_KEY4;   // Probe Tx sender
    if (!privateKey1 || !privateKey2 || !privateKey3 || !privateKey4) throw new Error("One or more PRIVATE_KEYS missing in .env");

    // // main net
    // const rpcUrl = "https://arb1-sequencer.arbitrum.io/rpc";    // Sequencer
    // const rpcNodeUrl = "https://arb1.arbitrum.io/rpc"; // RPC Node
    // test net
    const rpcUrl = "https://sepolia-rollup-sequencer.arbitrum.io/rpc";    // Sequencer
    const rpcNodeUrl = "https://sepolia-rollup.arbitrum.io/rpc"; // RPC Node

    const provider = new ethers.JsonRpcProvider(rpcNodeUrl);
    const wallet1 = new ethers.Wallet(privateKey1, provider);
    const wallet2 = new ethers.Wallet(privateKey2, provider);
    const wallet3 = new ethers.Wallet(privateKey3, provider);
    const wallet4 = new ethers.Wallet(privateKey4, provider);
    const pairAddress = process.env.SEPOLIA_ITTA_KITA_POOL_ADDR;
    const itta_addr = process.env.SEPOLIA_ITTA_ADDRESS;
    const kita_addr = process.env.SEPOLIA_KITA_ADDRESS;
    const arbitrage_addr = process.env.SEPOLIA_ARBITRAGE_ADDRESS;
    const arbitrage_recipient_addr = process.env.SEPOLIA_ARBITRAGE_RECIPIENT;
    const pairContract = new ethers.Contract(pairAddress, reservesAbi, provider);
    const poolPair = [{ name: "ITTA", address: itta_addr }, { name: "KITA", address: kita_addr }];

    console.log(`Running ${rounds} rounds for ${wallet1.address} ${wallet2.address} (period ${periodMs}ms, threshold ${relativeThreshold})`);

    let nextNonce1 = await provider.getTransactionCount(wallet1.address);
    let nextNonce2 = await provider.getTransactionCount(wallet2.address);
    let nextNonce3 = await provider.getTransactionCount(wallet3.address);
    let nextNonce4 = await provider.getTransactionCount(wallet4.address);
    const feeData = await provider.getFeeData();
    const chainId = (await provider.getNetwork()).chainId;
    console.log(`Starting nonce: ${nextNonce1}, ${nextNonce2}, ${nextNonce3}, ${nextNonce4}, chainId: ${chainId}`);

    if (runCompetitor) {
        competitorProcess = spawn("node", ["competitor.js"], {
            cwd: process.cwd(),
            stdio: "inherit",
            env: process.env,
        });
        console.log("Competitor process started before DCAT sending.");
        competitorProcess.on("exit", (code, signal) => {
            console.log(`Competitor process exited with code=${code} signal=${signal || "none"}`);
            competitorProcess = null;
        });
    }

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

        // Prepare DCAT Sender and Receiver transactions ahead of probing
        const nonce1 = nextNonce1;
        const nonce2 = nextNonce2;
        const sendswapAmount = 20_000n * 10n ** 18n; // 1n * 10n ** 18n;  //20,000 KITA
        const receiveswapAmount = 16_666n * 10n ** 18n; // 1n * 10n ** 18n; //16,666 ITTA
        const signedDCATSend = await prepareSwapSignedTx(provider, wallet1, pairContract, poolPair, kita_addr, sendswapAmount, nonce1, feeData, chainId);
        const signedDCATReceive = await prepareArbitrageSignedTx(provider, wallet2, arbitrage_addr, receiveswapAmount, receiveswapAmount, receiveswapAmount, arbitrage_recipient_addr, nonce2, feeData, chainId);

        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                // Sending Probe Transaction with wallet4
                const nonce4 = nextNonce4++;
                console.log(`[round ${round + 1}] Sending first tx (nonce ${nonce4})...`);
                const firstSend = await sendRawTxLocalHash({ wallet: wallet4, rpcUrl, nonce: nonce4, feeData, chainId, id: `r${round + 1}-t1` });
                const placement1 = await getPlacement(provider, firstSend.txHash);
                roundInfo.first = { ...firstSend, placement: placement1 };
                console.log(`[round ${round + 1}] First tx placed rel=${placement1.relative.toFixed(4)} block=${placement1.blockNumber} (getPlacement ${placement1.durationMs}ms)`);

                if (placement1.relative >= relativeThreshold && placement1.relative < 1.0) {    //exclude when the threshold is exactly 1.0
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

                        const sendRes = await sendTwoRawTransactions({ 
                        wallet: wallet1,
                        rpcUrl,
                        nonce: nextNonce1,
                        feeData,
                        chainId,
                        id: `r${round + 1}-t2`,
                        signedTx: [signedDCATSend, signedDCATReceive],
                        followUpStaggerMs,
                    });
                    let secondSends = [];
                    secondSends.push({ idx: 0, sendRes: sendRes[0]});
                    secondSends.push({ idx: 1, sendRes: sendRes[1]});
                    nextNonce1 += 1;
                    nextNonce2 += 1;

                    for (const { idx, sendRes } of secondSends) {
                        const placement = await getPlacement(provider, sendRes.txHash);
                        const tokenInOwner = idx === 0 ? wallet1.address : wallet2.address;
                        const tokenOutRecipient = idx === 0 ? wallet1.address : arbitrage_recipient_addr;
                        const transferTotals = await getTransferTotals(provider, sendRes.txHash, tokenInOwner, tokenOutRecipient);
                        roundInfo.seconds.push({ ...sendRes, placement, transferTotals });
                        console.log(
                            `[round ${round + 1}] Follow-up tx ${idx + 1}/2 placed rel=${placement.relative.toFixed(4)} block=${placement.blockNumber} ` +
                            `(in=${ethers.formatUnits(BigInt(transferTotals.tokenInRaw), 18)}, out=${ethers.formatUnits(BigInt(transferTotals.tokenOutRaw), 18)})`
                        );
                    }

                    if (runCompetitor) {  //If there's a competitor, rebalance the swap pool distorted by competitor's backrun before the next round
                        await sleep(5000); //wait a bit before competetor
                        const balance = 32_000n * 10n ** 18n; //amount to rebalance back to pool (both sides of the swap)
                        const signedRebalanceTx = await prepareSwapSignedTx(provider, wallet1, pairContract, poolPair, kita_addr, balance, nextNonce1, feeData, chainId);
                        await sendRawTxLocalHash({ wallet: wallet1, rpcUrl, nonce: nextNonce1, feeData, chainId, id: `r${round + 1}-rebalance`, signedTx: signedRebalanceTx });
                        nextNonce1 += 1;
                        console.log(`[round ${round + 1}] Sent rebalance transaction to counter competitor's distortion.`);
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
        }
        await sleep(periodMs);
        console.log("");
    }

    console.log("All rounds completed. Writing transfer_data.json ...");

    const outputDir = path.join(process.cwd(), "data");
    fs.mkdirSync(outputDir, { recursive: true });

    let senderInTotal = 0n;
    let senderOutTotal = 0n;
    let senderAmountCount = 0n;
    let receiverInTotal = 0n;
    let receiverOutTotal = 0n;
    let receiverAmountCount = 0n;
    const incidents = [];
    let dcatSuccessCount = 0;
    let dcatAttemptCount = 0;

    for (const r of results) {
        const sender = r.seconds[0];
        const receiver = r.seconds[1];

        const senderInRaw = sender?.transferTotals?.tokenInRaw;
        const senderOutRaw = sender?.transferTotals?.tokenOutRaw;
        const receiverInRaw = receiver?.transferTotals?.tokenInRaw;
        const receiverOutRaw = receiver?.transferTotals?.tokenOutRaw;

        if (senderInRaw !== undefined && senderOutRaw !== undefined) {
            senderInTotal += BigInt(senderInRaw);
            senderOutTotal += BigInt(senderOutRaw);
            senderAmountCount += 1n;
        }
        if (receiverInRaw !== undefined && receiverOutRaw !== undefined) {
            receiverInTotal += BigInt(receiverInRaw);
            receiverOutTotal += BigInt(receiverOutRaw);
            receiverAmountCount += 1n;
        }

        const senderTxHash = sender?.txHash ?? null;
        const receiverTxHash = receiver?.txHash ?? null;
        const senderBlockNumber = sender?.placement?.blockNumber ?? null;
        const receiverBlockNumber = receiver?.placement?.blockNumber ?? null;

        let success = null;
        if (senderBlockNumber !== null && receiverBlockNumber !== null) {
            dcatAttemptCount += 1;
            success = receiverBlockNumber === senderBlockNumber + 2;
            if (success) dcatSuccessCount += 1;
        }

        incidents.push({
            round: r.round,
            sender: {
                tx_hash: senderTxHash,
                block_number: senderBlockNumber,
            },
            receiver: {
                tx_hash: receiverTxHash,
                block_number: receiverBlockNumber,
            },
            success,
        });

    }

    const success_ratio = dcatAttemptCount > 0 ? dcatSuccessCount / dcatAttemptCount : 0;
    const avgSenderInRaw = senderAmountCount > 0n ? senderInTotal / senderAmountCount : null;
    const avgSenderOutRaw = senderAmountCount > 0n ? senderOutTotal / senderAmountCount : null;
    const avgReceiverInRaw = receiverAmountCount > 0n ? receiverInTotal / receiverAmountCount : null;
    const avgReceiverOutRaw = receiverAmountCount > 0n ? receiverOutTotal / receiverAmountCount : null;

    const avgSenderIn = avgSenderInRaw !== null ? Number(ethers.formatUnits(avgSenderInRaw, 18)) : 0;
    const avgSenderOut = avgSenderOutRaw !== null ? Number(ethers.formatUnits(avgSenderOutRaw, 18)) : 0;
    const avgReceiverIn = avgReceiverInRaw !== null ? Number(ethers.formatUnits(avgReceiverInRaw, 18)) : 0;
    const avgReceiverOut = avgReceiverOutRaw !== null ? Number(ethers.formatUnits(avgReceiverOutRaw, 18)) : 0;
    const reportTitle = `delay=${followUpStaggerMs}ms threshold=${relativeThreshold} competitor=${runCompetitor ? "yes" : "no"}`;
    const outputFileName = buildTransferDataFileName(followUpStaggerMs, relativeThreshold, runCompetitor);

    fs.writeFileSync(
        path.join(outputDir, outputFileName),
        JSON.stringify({
            createdAt: new Date().toISOString(),
            title: reportTitle,
            output_file: outputFileName,
            delay_ms: followUpStaggerMs,
            threshold: relativeThreshold,
            competitor: runCompetitor,
            schema: "asset_transfer_plot_v1",
            unit: "token_units_18_decimals",
            roles: ["DCAT Sender", "DCAT Receiver"],
            samples: {
                sender: Number(senderAmountCount),
                receiver: Number(receiverAmountCount),
            },
            dcat_attempts: dcatAttemptCount,
            dcat_successes: dcatSuccessCount,
            success_ratio,
            avgTokenIn: [avgSenderIn, avgReceiverIn],
            avgTokenOut: [avgSenderOut, avgReceiverOut],
            incidents,
        }, null, 2)
    );
    console.log(`Wrote ${outputFileName} to ${outputDir}`);

    stopCompetitor();
}

main();
