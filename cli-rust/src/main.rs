use clap::{Parser, Subcommand};
use ethers::prelude::*;
use std::convert::TryFrom;
use std::sync::Arc;

// Inline ABI generation for the AgentPayOS contract
abigen!(
    AgentPayOSContract,
    r#"[
        function getServiceUrl(bytes32 service_id) external view returns (string)
        function payForService(address user, bytes32 service_id) external
    ]"#
);

const CONTRACT_ADDRESS: &str = "0x262dd88d9120275e9e9dc659c66cf5f5c4e826c8";
const RPC_URL: &str = "https://sepolia-rollup.arbitrum.io/rpc";

#[derive(Parser)]
#[command(name = "agentpayos")]
#[command(about = "AgentPayOS Command Line Interface", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Pay for a service and make the HTTP request
    Pay {
        /// The target endpoint URL of the service provider
        url: String,
        /// The hex-encoded Service ID
        #[arg(name = "service-id")]
        service_id: String,
        /// The user (delegator) address who approved the agent session
        #[arg(name = "user-address")]
        user_address: String,
        /// The agent private key to sign the session payment transaction
        #[arg(name = "agent-private-key")]
        agent_private_key: String,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match &cli.command {
        Commands::Pay {
            url,
            service_id,
            user_address,
            agent_private_key,
        } => {
            println!("\x1b[1;32m[agentpayos pay]\x1b[0m Initializing Wallet Client...");
            
            // Set up provider and wallet
            let provider = Provider::<Http>::try_from(RPC_URL)?;
            let wallet = agent_private_key
                .parse::<LocalWallet>()?
                .with_chain_id(421614u64); // Arbitrum Sepolia Chain ID
            let client = Arc::new(SignerMiddleware::new(provider, wallet));

            // Instantiate smart contract
            let contract_addr = CONTRACT_ADDRESS.parse::<Address>()?;
            let contract = AgentPayOSContract::new(contract_addr, client);

            // Parse parameters
            let clean_service_id = service_id.trim_start_matches("0x");
            let service_id_bytes = ethers::utils::hex::decode(clean_service_id)?;
            let mut service_id_fixed = [0u8; 32];
            if service_id_bytes.len() != 32 {
                return Err("Invalid Service ID length. Must be 32 bytes (64 hex characters).".into());
            }
            service_id_fixed.copy_from_slice(&service_id_bytes);

            let user_addr = user_address.parse::<Address>()?;

            println!("\x1b[1;32m[agentpayos pay]\x1b[0m Submitting payForService on contract {}...", CONTRACT_ADDRESS);

            // Apply gas overrides to avoid Arbitrum Sepolia gas spikes
            // maxFeePerGas: 0.5 Gwei (500000000 Wei), maxPriorityFeePerGas: 0.05 Gwei (50000000 Wei)
            let tx = contract
                .pay_for_service(user_addr, service_id_fixed)
                .gas_price(500000000u64);

            let pending_tx = tx.send().await?;
            let tx_hash = format!("0x{:x}", pending_tx.tx_hash());
            println!("\x1b[1;32m[agentpayos pay]\x1b[0m Transaction sent! Hash: {}", tx_hash);

            println!("\x1b[1;32m[agentpayos pay]\x1b[0m Waiting for confirmation on-chain...");
            let receipt = pending_tx
                .await?
                .ok_or("Transaction failed to return a receipt")?;

            println!(
                "\x1b[1;32m[agentpayos pay]\x1b[0m Payment confirmed on-chain in block {}!",
                receipt.block_number.unwrap_or_default()
            );

            println!("\x1b[1;32m[agentpayos pay]\x1b[0m Executing authorized HTTP request to {}...", url);
            let http_client = reqwest::Client::new();
            let res = http_client
                .get(url)
                .header("X-Payment-Tx-Hash", &tx_hash)
                .header("X-User-Address", user_address)
                .send()
                .await?;

            println!("\x1b[1;32m[agentpayos pay]\x1b[0m Response status: {}", res.status());
            let body = res.text().await?;
            println!("{}", body);
        }
    }

    Ok(())
}
