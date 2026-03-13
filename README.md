# Arbitrum MEV Simulator

Arbitrum mainnet and testnet MEV simulator.

This project allows you to schedule transactions on Arbitrum mainnet or
testnet and simulate MEV-related transaction placement conditions.

You can configure: 
- Number of transactions 
- Delay between transactions 
- Custom execution conditions

> ⚠️ **Disclaimer**\
> This project is intended **for academic and research purposes only**.\
> It is **not designed to exploit real MEV opportunities** or interact
> maliciously with live networks.

------------------------------------------------------------------------

## Installation

### 1. Install Node.js

Download and install Node.js from:\
https://nodejs.org/

The required version is >20.0.0

<br>

### 2. Initialize a Project

Create a new project directory and initialize npm.

``` bash
mkdir Arbitrum_MEV_simulator
cd Arbitrum_MEV_simulator
npm init
```

Make sure your `package.json` includes:

``` json
"type": "module"
```

Node.js must run in **ES Module mode**, not the default `commonjs`.

<br>

### 3. Install Dependencies

Install the required packages:

``` bash
npm install dotenv ethers node-fetch undici viem ws
```

These dependencies will appear in your `package.json`.

<br>

### 4. Create Environment File

Create a `.env` file in the project root.

Example template:

    PRIVATE_KEY=your_private_key_here
    ARBITRUM_RPC=https://arb1.arbitrum.io/rpc
    ARBITRUM_SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc

Adjust the RPC endpoints or variables as needed.

------------------------------------------------------------------------

## Usage

Test run the simulator with:

``` bash
node ./archive/main_send_tx.js 1 1 100
```

Example syntax:

    node ./archive/main_send_tx.js <num_tx> <delay> <condition>

Example:

    node ./archive/main_send_tx.js 1 1 100

This command will:
-   Send **1 transaction**
-   Execute on **Arbitrum mainnet**
-   Generate the following output files:

    placement_data.json
    placement_chart.html

These files contain transaction placement data and a visual chart for
analysis.

------------------------------------------------------------------------

## Output Files

  File                     Description

  `placement_data.json`   : Raw data of transaction placement results
  
  `placement_chart.html`  : Visualization of transaction ordering


## License

This project is intended for **academic research and educational use**.
