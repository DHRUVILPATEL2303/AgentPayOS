import React, { useState, useEffect, useRef } from 'react';
import { ethers } from 'ethers';

const CONTRACT_ADDRESS = "0x262dd88d9120275e9e9dc659c66cf5f5c4e826c8";

const CONTRACT_ABI = [
  "function registerService(string calldata name, uint256 price, address token, string calldata url) external returns (bytes32)",
  "function getServiceUrl(bytes32 service_id) external view returns (string)",
  "function deactivateService(bytes32 service_id) external",
  "function reactivateService(bytes32 service_id) external",
  "function approveAgent(address agent, uint256 allowance, uint256 duration_seconds) external",
  "function payForService(address user, bytes32 service_id) external",
  "function computeSessionKey(address user, address agent) external view returns (bytes32)",
  "event ServiceRegistered(bytes32 indexed service_id, address indexed provider, address indexed token, string name, uint256 price, string url)",
  "event AgentApproved(address indexed user, address indexed agent, uint256 allowance, uint256 expiration)",
  "event PaymentProcessed(bytes32 indexed service_id, address indexed user, address agent, address provider, uint256 amount)"
];

function App() {
  const [account, setAccount] = useState("");
  const [contract, setContract] = useState(null);
  const [logs, setLogs] = useState([
    { timestamp: new Date().toLocaleTimeString(), text: "System initialized. Please connect your Web3 wallet.", type: "info" }
  ]);
  const [providers, setProviders] = useState([]);

  // Form States
  const [serviceName, setServiceName] = useState("Weather Telemetry API");
  const [servicePrice, setServicePrice] = useState("1000000");
  const [tokenAddress, setTokenAddress] = useState("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d");
  const [serviceUrl, setServiceUrl] = useState("http://localhost:8080/");

  const [agentAddress, setAgentAddress] = useState("0x141C22D955f5dF0f54bffD8695CDC7e92b38551c");
  const [agentAllowance, setAgentAllowance] = useState("5000000");
  const [sessionDuration, setSessionDuration] = useState("86400");

  const [payUserAddress, setPayUserAddress] = useState("");
  const [payServiceID, setPayServiceID] = useState("");

  const [loading, setLoading] = useState(false);
  const consoleEndRef = useRef(null);

  const addLog = (text, type = "info") => {
    setLogs(prev => [...prev, { timestamp: new Date().toLocaleTimeString(), text, type }]);
  };

  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  useEffect(() => {
    const handleAnnounce = (event) => {
      const { info, provider } = event.detail;
      setProviders(prev => {
        if (prev.some(p => p.info.uuid === info.uuid)) return prev;
        return [...prev, { info, provider }];
      });
    };

    window.addEventListener("eip6963:announceProvider", handleAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    return () => {
      window.removeEventListener("eip6963:announceProvider", handleAnnounce);
    };
  }, []);

  const connectWallet = async (selectedProviderDetail) => {
    let injectedProvider = selectedProviderDetail ? selectedProviderDetail.provider : window.ethereum;
    if (!injectedProvider) {
      addLog("No injected Web3 provider found. Please install MetaMask.", "error");
      return;
    }

    try {
      setLoading(true);
      const walletName = selectedProviderDetail ? selectedProviderDetail.info.name : "Wallet";
      addLog(`Requesting connection to ${walletName}...`, "info");
      
      const providerInstance = new ethers.BrowserProvider(injectedProvider);
      await providerInstance.send("eth_requestAccounts", []);
      const signer = await providerInstance.getSigner();
      const walletAddress = await signer.getAddress();

      const network = await providerInstance.getNetwork();
      if (network.chainId !== 421614n) {
        addLog("WARNING: You are not connected to Arbitrum Sepolia. Attempting to switch...", "error");
        try {
          await injectedProvider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x66eee" }],
          });
        } catch (switchError) {
          addLog(`Please switch network manually in your wallet to Arbitrum Sepolia (421614).`, "error");
          setLoading(false);
          return;
        }
      }

      const instance = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
      setContract(instance);
      setAccount(walletAddress);
      addLog(`Connected: ${walletAddress} via ${walletName}`, "success");
    } catch (err) {
      addLog(`Connection failed: ${err.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterService = async () => {
    if (!contract) {
      addLog("Wallet not connected.", "error");
      return;
    }
    if (!serviceName || !servicePrice || !tokenAddress || !serviceUrl) {
      addLog("Please fill in all service registration inputs.", "error");
      return;
    }

    try {
      setLoading(true);
      const price = ethers.toBigInt(servicePrice);
      addLog(`Submitting registerService("${serviceName}", ${price}, ${tokenAddress}, "${serviceUrl}")...`, "info");
      
      const tx = await contract.registerService(serviceName, price, tokenAddress, serviceUrl, {
        maxFeePerGas: ethers.parseUnits("0.5", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
      });
      addLog(`Transaction sent! Hash: ${tx.hash}`, "info");
      
      const receipt = await tx.wait();
      addLog(`Transaction confirmed in block ${receipt.blockNumber}!`, "success");

      const calculatedServiceID = ethers.solidityPackedKeccak256(
        ["bytes", "address"],
        [ethers.toUtf8Bytes(serviceName), account]
      );
      addLog(`Service ID Generated: ${calculatedServiceID}`, "success");
      addLog(`Configure this Service ID in your Go Gateway environment.`, "info");
    } catch (err) {
      addLog(`Registration failed: ${err.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleApproveAgent = async () => {
    if (!contract) {
      addLog("Wallet not connected.", "error");
      return;
    }
    if (!agentAddress || !agentAllowance || !sessionDuration) {
      addLog("Please fill in all agent session inputs.", "error");
      return;
    }

    try {
      setLoading(true);
      const allowance = ethers.toBigInt(agentAllowance);
      const duration = ethers.toBigInt(sessionDuration);

      addLog(`Submitting approveAgent(${agentAddress}, ${allowance}, ${duration})...`, "info");
      const tx = await contract.approveAgent(agentAddress, allowance, duration, {
        maxFeePerGas: ethers.parseUnits("0.5", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
      });
      addLog(`Transaction sent! Hash: ${tx.hash}`, "info");

      await tx.wait();
      addLog(`Agent session approved successfully!`, "success");

      const sessionKey = ethers.solidityPackedKeccak256(
        ["address", "address"],
        [account, agentAddress]
      );
      addLog(`Calculated Session Key: ${sessionKey}`, "success");
    } catch (err) {
      addLog(`Agent approval failed: ${err.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handlePayForService = async () => {
    if (!contract) {
      addLog("Wallet not connected.", "error");
      return;
    }
    if (!payUserAddress || !payServiceID) {
      addLog("Please fill in all simulator inputs.", "error");
      return;
    }

    try {
      setLoading(true);
      addLog(`Submitting payForService(${payUserAddress}, "${payServiceID}")...`, "info");
      
      const tx = await contract.payForService(payUserAddress, payServiceID, {
        maxFeePerGas: ethers.parseUnits("0.5", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
      });
      addLog(`Transaction sent! Hash: ${tx.hash}`, "info");
      
      const receipt = await tx.wait();
      addLog(`Payment transaction confirmed! Hash: ${tx.hash}`, "success");
      addLog(`Copy this Tx Hash for your Gateway API request header: X-Payment-Tx-Hash`, "success");
    } catch (err) {
      addLog(`Payment failed: ${err.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateAgent = () => {
    try {
      const wallet = ethers.Wallet.createRandom();
      setAgentAddress(wallet.address);
      addLog(`Generated Random Agent Wallet:`, "success");
      addLog(`Agent Address: ${wallet.address}`, "success");
      addLog(`Agent Private Key: ${wallet.privateKey}`, "success");
      addLog(`IMPORTANT: Copy and save this private key to run payments from your agent client.`, "info");
    } catch (err) {
      addLog(`Failed to generate agent: ${err.message}`, "error");
    }
  };

  const handleApproveUSDC = async () => {
    if (!account) {
      addLog("Wallet not connected.", "error");
      return;
    }
    if (!tokenAddress) {
      addLog("Please enter the USDC Token Address in the registration form first.", "error");
      return;
    }

    try {
      setLoading(true);
      addLog(`Requesting approval for ${CONTRACT_ADDRESS} to spend USDC on token contract ${tokenAddress}...`, "info");
      
      const signerInstance = contract.runner;
      
      const erc20 = new ethers.Contract(
        tokenAddress,
        ["function approve(address spender, uint256 amount) external returns (bool)"],
        signerInstance
      );

      const tx = await erc20.approve(CONTRACT_ADDRESS, ethers.toBigInt("10000000000"), { // 10,000 USDC
        maxFeePerGas: ethers.parseUnits("0.5", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
      });
      addLog(`Approve transaction sent! Hash: ${tx.hash}`, "info");

      await tx.wait();
      addLog(`Successfully approved AgentPayOS contract to spend your USDC!`, "success");
    } catch (err) {
      addLog(`USDC approval failed: ${err.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <header>
        <h1>AgentPay OS <span className="badge">Arbitrum Stylus</span></h1>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {account ? (
            <button className="btn-secondary" disabled>
              {`${account.substring(0, 6)}...${account.substring(38)}`}
            </button>
          ) : providers.length > 0 ? (
            providers.map((p) => (
              <button key={p.info.uuid} onClick={() => connectWallet(p)} className="btn-primary" disabled={loading}>
                Connect {p.info.name}
              </button>
            ))
          ) : (
            <button onClick={() => connectWallet(null)} className="btn-primary" disabled={loading}>
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <h2>Register API Service</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Register your API metadata on-chain to allow AI agents to settle micro-payments.
          </p>
          
          <div className="form-group">
            <label>Service Name</label>
            <input type="text" value={serviceName} onChange={(e) => setServiceName(e.target.value)} />
          </div>

          <div className="form-group">
            <label>Price (in USDC units - 6 decimals)</label>
            <input type="number" value={servicePrice} onChange={(e) => setServicePrice(e.target.value)} />
          </div>

          <div className="form-group">
            <label>Token Address (USDC)</label>
            <input type="text" value={tokenAddress} onChange={(e) => setTokenAddress(e.target.value)} />
          </div>

          <div className="form-group">
            <label>API Endpoint URL</label>
            <input type="text" value={serviceUrl} onChange={(e) => setServiceUrl(e.target.value)} />
          </div>

          <button onClick={handleRegisterService} className="btn-secondary" disabled={loading || !account}>
            Register Service
          </button>
        </section>

        <section className="card">
          <h2>Approve AI Agent Session</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Delegate a time-locked, budget-limited allowance key to your AI agent.
          </p>

          <div className="form-group">
            <label>Agent Address</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input type="text" value={agentAddress} onChange={(e) => setAgentAddress(e.target.value)} style={{ flex: 1 }} />
              <button onClick={handleGenerateAgent} className="btn-secondary" style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
                Generate
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>Allowance (in USDC units)</label>
            <input type="number" value={agentAllowance} onChange={(e) => setAgentAllowance(e.target.value)} />
          </div>

          <div className="form-group">
            <label>Session Duration (seconds)</label>
            <input type="number" value={sessionDuration} onChange={(e) => setSessionDuration(e.target.value)} />
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={handleApproveAgent} className="btn-secondary" style={{ flex: 1 }} disabled={loading || !account}>
              Approve Agent Session
            </button>
            <button onClick={handleApproveUSDC} className="btn-secondary" style={{ flex: 1 }} disabled={loading || !account}>
              Approve USDC Spend
            </button>
          </div>
        </section>

        <section className="card">
          <h2>Simulate Agent Payment</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Trigger a manual payment using the connected wallet (acting as the agent key).
          </p>

          <div className="form-group">
            <label>User Address (Delegator)</label>
            <input type="text" value={payUserAddress} placeholder="0x..." onChange={(e) => setPayUserAddress(e.target.value)} />
          </div>

          <div className="form-group">
            <label>Service ID</label>
            <input type="text" value={payServiceID} placeholder="0x..." onChange={(e) => setPayServiceID(e.target.value)} />
          </div>

          <button onClick={handlePayForService} className="btn-secondary" disabled={loading || !account}>
            Trigger Agent Payment
          </button>
        </section>

        <section className="card console-card">
          <div className="console-header">
            <h2>Transaction Control Center</h2>
            <button onClick={() => setLogs([])} className="btn-secondary" style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}>
              Clear Logs
            </button>
          </div>
          
          <div className="console-logs">
            {logs.map((log, index) => (
              <div key={index} className={`log-item log-${log.type}`}>
                [{log.timestamp}] {log.text}
              </div>
            ))}
            <div ref={consoleEndRef} />
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
