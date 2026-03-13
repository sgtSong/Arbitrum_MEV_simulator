import { createPublicClient, createWalletClient, encodeFunctionData, http, parseUnits, parseSignature } from 'viem'
import { arbitrum, skaleEuropa } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

import 'dotenv/config'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//Importing constants from .env
const itta_addr = process.env.ITTA_ADDRESS;
const kita_addr = process.env.KITA_ADDRESS;
const itta_kita_pool_addr = process.env.ITTA_KITA_POOL_ADDR;

const private_key1 = process.env.PRIVATE_KEY1;
const private_key2 = process.env.PRIVATE_KEY2;
const account1 = privateKeyToAccount(private_key1);
const account2 = privateKeyToAccount(private_key2);

const publicClient = createPublicClient({
  chain: arbitrum,    //Use Arbitrum One
  transport: http('	https://arb1.arbitrum.io/rpc'),
})

const walletClient1 = createWalletClient({
  account1,
  chain: arbitrum,
  transport: http(process.env.ARBITRUM_RPC),
})

const walletClient2 = createWalletClient({
  account2,
  chain: arbitrum,
  transport: http(process.env.ARBITRUM_RPC),
})

//
// ----------------------------------- //
//               ABIs
// ----------------------------------- //
// Swap ABI for swap call to pool contract
const erc20PermitAbi = [
  {
    "inputs": [
      { "internalType": "address", "name": "owner", "type": "address" },
      { "internalType": "address", "name": "spender", "type": "address" },
      { "internalType": "uint256", "name": "value", "type": "uint256" },
      { "internalType": "uint256", "name": "deadline", "type": "uint256" },
      { "internalType": "uint8", "name": "v", "type": "uint8" },
      { "internalType": "bytes32", "name": "r", "type": "bytes32" },
      { "internalType": "bytes32", "name": "s", "type": "bytes32" }
    ],
    "name": "permit",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "owner", "type": "address" }
    ],
    "name": "nonces",
    "outputs": [
      { "internalType": "uint256", "name": "", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];

async function _givePermit(account, walletClient, token_addr, deadline) {
  const amount = 2n ** 256n - 1n; // infinite (max uint256)

  const nonce = await publicClient.readContract({
    address: token_addr,
    abi: erc20PermitAbi,
    functionName: "nonces",
    args: [account.address],
  });
  console.log("nonce: ", nonce);

  const signature = await walletClient.signTypedData({
    account: account,
    domain: {
      name: "Kessoku",
      version: "1",
      chainId: arbitrum.id,
      verifyingContract: token_addr,
    },
    primaryType: "Permit",
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ],
    },
    message: {
      owner: account.address,
      spender: itta_kita_pool_addr,
      value: amount,
      nonce,
      deadline,
    }
  });

  const { r, s, v } = parseSignature(signature);
  console.log ("r: ", r, ",s: " , s, ",v: ",v,);

  const tx = await walletClient.writeContract({
    account: account,
    address: token_addr,
    abi: erc20PermitAbi,
    functionName: "permit",
    args: [
      account.address,
      itta_kita_pool_addr,
      amount,
      deadline,
      v, r, s
    ],
  });

  console.log("Token PERMIT submitted: ", tx);
}


// ------ exports ------- //

export async function giveTokenPermitFor10Hrs(account, walletClient, token_addr) {
  const deadline = Math.floor(Date.now() / 1000) + 36000; // 10 hour
  await _givePermit(account, walletClient, token_addr, deadline);
}

export async function giveTokenPermitNoExpiration(account, walletClient, token_addr) {
  const deadline = 2n ** 256n - 1n; // max number; no expiration
  await _givePermit(account, walletClient, token_addr, deadline);
}


// --- "main" block ---
if (import.meta.url === `file://${process.argv[1]}`) {
  // Only runs if this file is executed directly
  await giveTokenPermitNoExpiration(account1, walletClient1, kita_addr);
  await giveTokenPermitNoExpiration(account2, walletClient2, kita_addr);
  await sleep(2000); // wait for 2 seconds to ensure the first two transactions are processed
  await giveTokenPermitNoExpiration(account1, walletClient1, itta_addr);
  await giveTokenPermitNoExpiration(account2, walletClient2, itta_addr);
}