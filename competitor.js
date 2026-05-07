import fs from "fs";
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const rpcLogFilePath = new URL("./competitor_rpc.log", import.meta.url);

function appendRpcLog(message) {
    fs.appendFileSync(rpcLogFilePath, `${message}\n`);
}

const pairAbi = [
    {
        inputs: [
            { internalType: "address", name: "tokenIn", type: "address" },
            { internalType: "uint256", name: "amountIn", type: "uint256" },
            { internalType: "uint256", name: "minAmountOut", type: "uint256" },
            { internalType: "address", name: "to", type: "address" },
        ],
        name: "swap",
        outputs: [{ name: "amountOut", type: "uint256" }],
        stateMutability: "nonpayable",
        type: "function",
    },
];

const arbitrageBotAbi = [
    {
        inputs: [
            { internalType: "uint256", name: "amountKita", type: "uint256" },
            { internalType: "uint256", name: "amountYatta", type: "uint256" },
            { internalType: "uint256", name: "amountItta", type: "uint256" },
            { internalType: "address", name: "recipient", type: "address" },
        ],
        name: "executeTripleSwap",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
];

async function prepareArbitrageSignedTx(wallet, arbitrageBotAddress, amountKita, amountYatta, amountItta, recipient, nonce, feeData, chainId, gasLimit) {
    const iface = new ethers.Interface(arbitrageBotAbi);
    const data = iface.encodeFunctionData("executeTripleSwap", [amountKita, amountYatta, amountItta, recipient]);

    const txRequest = {
        to: arbitrageBotAddress,
        data,
        value: 0,
        gasLimit,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        nonce,
        chainId,
    };

    const signedTx = await wallet.signTransaction(txRequest);
    return signedTx;
}

async function sendRawTxLocalHash({ wallet, rpcUrl, nonce, feeData, chainId, id, signedTx = null }) {
    let signed = signedTx;

    if (!signedTx) {
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
    console.log(`[${id}] POSTing tx nonce=${nonce} hash=${txHash} at ${sentAt}`);
    appendRpcLog(`[${id}] POSTing tx nonce=${nonce} hash=${txHash} at ${sentAt}`);

    fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    })
        .then(async (res) => {
            const body = await res.json().catch(() => undefined);
            console.log(`[${id}] RPC response status=${res.status} body=${JSON.stringify(body)}`);
            appendRpcLog(`[${id}] RPC response status=${res.status} body=${JSON.stringify(body)}`);
        })
        .catch((err) => {
            console.error(`[${id}] RPC send error: ${err.message || err}`);
            appendRpcLog(`[${id}] RPC send error: ${err.message || err}`);
        });

    return { txHash, sentAt };
}

async function main() {
        // Cache to store block numbers where swaps have already been detected and processed
        const detectedSwapBlocks = new Set();
    const privateKey = process.env.PRIVATE_KEY_COMPETITOR;
    const targetPool = process.env.SEPOLIA_ITTA_KITA_POOL_ADDR;
    const arbitrageAddress = process.env.SEPOLIA_ARBITRAGE_ADDRESS;
    const arbitrageRecipient = process.env.SEPOLIA_ARBITRAGE_COMPETITOR_RECIPIENT;
    const amountRaw = 1n * 10n ** 18n;    // Compete with 16,666 ITTA;
    const fixedGasLimit = BigInt(process.env.COMPETITOR_FIXED_GAS_LIMIT ?? "500000");
    const feeRefreshMs = Number(process.env.COMPETITOR_FEE_REFRESH_MS ?? "1200");

    if (!privateKey) throw new Error("PRIVATE_KEY_COMPETITOR missing in .env");
    if (!targetPool) throw new Error("SEPOLIA_ITTA_KITA_POOL_ADDR missing in .env");
    if (!arbitrageAddress) throw new Error("SEPOLIA_ARBITRAGE_ADDRESS missing in .env");
    if (!arbitrageRecipient) throw new Error("SEPOLIA_ARBITRAGE_COMPETITOR_RECIPIENT missing in .env");

    const amount = amountRaw ? BigInt(amountRaw) : 1n * 10n ** 18n;

    const rpcUrl = "https://sepolia-rollup-sequencer.arbitrum.io/rpc";
    const rpcNodeUrl = "https://sepolia-rollup.arbitrum.io/rpc";

    const provider = new ethers.JsonRpcProvider(rpcNodeUrl);
    provider.pollingInterval = 200;
    const wallet = new ethers.Wallet(privateKey, provider);

    const targetPoolChecksum = ethers.getAddress(targetPool);
    const targetPoolLower = targetPoolChecksum.toLowerCase();
    const swapSelector = new ethers.Interface(pairAbi).getFunction("swap").selector;

    let localNonce = await provider.getTransactionCount(wallet.address, "pending");
    let latestProcessedBlock = await provider.getBlockNumber();
    let sending = false;

    console.log(`Competitor wallet: ${wallet.address}`);
    console.log(`Watching pool: ${targetPoolChecksum}`);
    console.log(`Arbitrage contract: ${ethers.getAddress(arbitrageAddress)}`);
    console.log(`Arbitrage recipient: ${ethers.getAddress(arbitrageRecipient)}`);
    console.log(`Arbitrage amount (wei): ${amount}`);
    console.log(`Fixed gas limit: ${fixedGasLimit}`);
    console.log(`Fee refresh interval (ms): ${feeRefreshMs}`);
    console.log(`Starting from block: ${latestProcessedBlock}`);

    let feeData = await provider.getFeeData();
    const chainId = (await provider.getNetwork()).chainId;
    const arbitrageAddressChecksum = ethers.getAddress(arbitrageAddress);
    const arbitrageRecipientChecksum = ethers.getAddress(arbitrageRecipient);

    const feeRefreshTimer = setInterval(async () => {
        try {
            // Skip if this block was already processed for a swap
            if (detectedSwapBlocks.has(blockNumber)) {
                // console.log(`[block ${blockNumber}] Already processed swap for this block, skipping.`);
                return;
            }
            const refreshed = await provider.getFeeData();
            if (refreshed.maxFeePerGas && refreshed.maxPriorityFeePerGas) {
                feeData = refreshed;
            }
        } catch {
            // keep using last known fee data on refresh failures
        }
    }, feeRefreshMs);

    let signed = null;
    let prepareInFlight = null;

    const refillSignedTx = async (reason) => {
        if (prepareInFlight) return prepareInFlight;

        prepareInFlight = (async () => {
            const nextSigned = await prepareArbitrageSignedTx(
                wallet,
                arbitrageAddressChecksum,
                amount,
                amount,
                amount,
                arbitrageRecipientChecksum,
                localNonce,
                feeData,
                chainId,
                fixedGasLimit,
            );
            signed = nextSigned;
            console.log(`[prep] Ready signed tx for nonce ${localNonce} (${reason})`);
        })()
            .catch((err) => {
                signed = null;
                console.error(`[prep] Failed to prepare signed tx (${reason}): ${err.message || err}`);
            })
            .finally(() => {
                prepareInFlight = null;
            });

        return prepareInFlight;
    };

    await refillSignedTx("startup");

    const findMatchingSwapTx = async (block) => {
        for (const tx of block.transactions) {
            const txObj = typeof tx === "string" ? await provider.getTransaction(tx) : tx;
            if (!txObj || !txObj.to || !txObj.data) continue;
            if (txObj.to.toLowerCase() === targetPoolLower && txObj.data.startsWith(swapSelector)) {
                return txObj;
            }
        }
        return null;
    };

    const processBlock = async (blockNumber) => {
        try {
            // console.log(`[block ${blockNumber}] Retrieving block data...`);
            const block = await provider.getBlock(blockNumber, true);
            if (!block) {
                // console.log(`[block ${blockNumber}] Block retrieval returned null.`);
                return;
            }

            if (!Array.isArray(block.transactions) || block.transactions.length === 0) {
                // console.log(`[block ${blockNumber}] Retrieved. No transactions in block.`);
                return;
            }

            // console.log(`[block ${blockNumber}] Retrieved ${block.transactions.length} transactions.`);

            const matchingTx = await findMatchingSwapTx(block);

            if (!matchingTx) {
                // console.log(`[block ${blockNumber}] No target-pool swap found.`);
                return;
            }

            // Mark this block as processed for swap
            detectedSwapBlocks.add(blockNumber);

            console.log(`[block ${blockNumber}] Detected target-pool swap tx: ${matchingTx.hash}`);
            appendRpcLog(`[block ${blockNumber}] Detected target-pool swap tx: ${matchingTx.hash}`);
            if (sending) {
                console.log(`[block ${blockNumber}] Send already in progress; skipping trigger.`);
                return;
            }

            if (!signed) {
                console.log(`[block ${blockNumber}] No pre-signed tx ready; preparing now.`);
                await refillSignedTx("missing-at-trigger");
                if (!signed) {
                    console.log(`[block ${blockNumber}] Pre-sign still unavailable; skipping trigger.`);
                    return;
                }
            }

            sending = true;
            const nonce = localNonce;
            const signedToSend = signed;
            signed = null;

            const sent = await sendRawTxLocalHash({
                wallet,
                rpcUrl,
                nonce,
                feeData,
                chainId,
                id: `competitor-b${blockNumber}`,
                signedTx: signedToSend,
            });

            localNonce += 1;
            console.log(`[block ${blockNumber}] Competitor tx submitted: ${sent.txHash}`);
            appendRpcLog(`[block ${blockNumber}] Competitor tx submitted: ${sent.txHash}`);

            // Refill in background so trigger path can stay minimal.
            void refillSignedTx("post-send");
        } catch (err) {
            console.error(`[block ${blockNumber}] Competitor handler error: ${err.message || err}`);
            try {
                localNonce = await provider.getTransactionCount(wallet.address, "pending");
            } catch {
                // keep previous nonce if refresh fails
            }
            signed = null;
            void refillSignedTx("error-recovery");
        } finally {
            sending = false;
        }
    };

    provider.on("block", async (blockNumber) => {
        if (blockNumber <= latestProcessedBlock) return;

        // Process newest first to minimize reaction delay on the freshest head.
        for (let b = blockNumber; b > latestProcessedBlock; b--) {
            await processBlock(b);
        }

        latestProcessedBlock = blockNumber;
    });

    process.on("SIGINT", () => {
        console.log("Stopping competitor watcher...");
        clearInterval(feeRefreshTimer);
        provider.removeAllListeners("block");
        process.exit(0);
    });
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});

    