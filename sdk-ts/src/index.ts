import { ethers } from "ethers";

const CONTRACT_ABI = [
  "function getServiceUrl(bytes32 service_id) external view returns (string)",
  "function payForService(address user, bytes32 service_id) external"
];

export interface AgentClientConfig {
  agentPrivateKey: string;
  userAddress: string;
  rpcUrl: string;
  contractAddress: string;
}

export class AgentClient {
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;
  private userAddress: string;

  constructor(config: AgentClientConfig) {
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.agentPrivateKey, provider);
    this.contract = new ethers.Contract(config.contractAddress, CONTRACT_ABI, this.wallet);
    this.userAddress = config.userAddress;
  }

  /**
   * Automatically resolves, pays, and requests a service endpoint on-chain.
   * @param serviceId The Service ID registered on the contract
   * @param requestInit Optional HTTP fetch parameters (method, body, custom headers)
   */
  async callService(serviceId: string, requestInit?: RequestInit): Promise<Response> {
    console.log(`[AgentClient] Querying smart contract to resolve API Endpoint URL for Service ID: ${serviceId}...`);
    let serviceUrl: string;
    try {
      serviceUrl = await this.contract.getServiceUrl(serviceId);
    } catch (err: any) {
      throw new Error(`Failed to resolve Service URL from contract: ${err.message}`);
    }

    if (!serviceUrl) {
      throw new Error(`Service URL is empty for Service ID: ${serviceId}`);
    }

    console.log(`[AgentClient] Resolved Endpoint URL: ${serviceUrl}`);

    console.log(`[AgentClient] Submitting on-chain payForService payment for delegator ${this.userAddress}...`);
    let txHash: string;
    try {
      const tx = await this.contract.payForService(this.userAddress, serviceId, {
        maxFeePerGas: ethers.parseUnits("0.5", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
      });
      console.log(`[AgentClient] Transaction sent! Hash: ${tx.hash}`);
      
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`Transaction reverted on-chain`);
      }
      txHash = tx.hash;
      console.log(`[AgentClient] Payment confirmed on-chain in block ${receipt.blockNumber}!`);
    } catch (err: any) {
      throw new Error(`Payment transaction failed: ${err.message}`);
    }

    console.log(`[AgentClient] Executing authorized HTTP request to ${serviceUrl}...`);
    const headers = new Headers(requestInit?.headers);
    headers.set("X-Payment-Tx-Hash", txHash);
    headers.set("X-User-Address", this.userAddress);

    const finalRequestInit: RequestInit = {
      ...requestInit,
      headers
    };

    return fetch(serviceUrl, finalRequestInit);
  }
}
