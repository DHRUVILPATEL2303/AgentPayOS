import { AgentClient } from "./index.js";

async function run() {
  const agentPrivateKey = process.env.AGENT_PRIVATE_KEY || "6174d65d8feb40de743a4e4f4b6fe012fcdeaf63bd5fea763d7a5d24987c402c";
  const userAddress = process.env.USER_ADDRESS || "0xCDD525F3302AB50a84864F9D8A4b05581952622F";
  const serviceId = process.env.SERVICE_ID || "0xab4e56b465df5bb934ea8f80c24372eb3c7a657716222977ce7f32b746451b21";
  
  const rpcUrl = "https://sepolia-rollup.arbitrum.io/rpc";
  const contractAddress = "0x262dd88d9120275e9e9dc659c66cf5f5c4e826c8";

  console.log("Initializing AgentPayOS Client SDK...");
  const client = new AgentClient({
    agentPrivateKey,
    userAddress,
    rpcUrl,
    contractAddress
  });

  try {
    const response = await client.callService(serviceId);
    console.log(`[Example] Response status: ${response.status} ${response.statusText}`);
    
    const body = await response.json();
    console.log("[Example] Response Body:", JSON.stringify(body, null, 2));
  } catch (err: any) {
    console.error("[Example] Execution failed:", err.message);
  }
}

run();
