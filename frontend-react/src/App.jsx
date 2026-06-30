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
    { timestamp: new Date().toLocaleTimeString(), text: "Ready. Connect your wallet to get started.", type: "info" }
  ]);
  const [walletProviders, setWalletProviders] = useState([]);
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('agentpayos-theme') || 'dark');

  const [serviceName, setServiceName] = useState("Weather Telemetry API");
  const [servicePrice, setServicePrice] = useState("1000000");
  const [tokenAddress, setTokenAddress] = useState("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d");
  const [serviceUrl, setServiceUrl] = useState("http://localhost:8080/");

  const [agentAddress, setAgentAddress] = useState("0x141C22D955f5dF0f54bffD8695CDC7e92b38551c");
  const [agentAllowance, setAgentAllowance] = useState("5000000");
  const [sessionDuration, setSessionDuration] = useState("86400");

  const [payUserAddress, setPayUserAddress] = useState("");
  const [payServiceID, setPayServiceID] = useState("");

  const [activeTab, setActiveTab] = useState("dashboard");
  const [registeredServices, setRegisteredServices] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [fetchingServices, setFetchingServices] = useState(false);

  const [agentSessions, setAgentSessions] = useState([]);
  const [fetchingSessionsList, setFetchingSessionsList] = useState(false);

  const [myServices, setMyServices] = useState([]);
  const [fetchingMyServices, setFetchingMyServices] = useState(false);
  const [priceUpdateInputs, setPriceUpdateInputs] = useState({});

  const [activityStats, setActivityStats] = useState({ totalPayments: 0, totalVolume: 0, uniqueUsers: 0, uniqueProviders: 0, totalServices: 0 });
  const [recentTxns, setRecentTxns] = useState([]);
  const [fetchingActivity, setFetchingActivity] = useState(false);

  const [loading, setLoading] = useState(false);
  const consoleEndRef = useRef(null);

  const addLog = (text, type = "info") => {
    setLogs(prev => [...prev, { timestamp: new Date().toLocaleTimeString(), text, type }]);
  };

  const fetchAgentSessions = async (ci, userAddress) => {
    const c = ci || contract;
    const user = userAddress || account;
    if (!c || !user) return;
    try {
      setFetchingSessionsList(true);
      const startBlock = 282600000;
      const [approvals, payments] = await Promise.all([
        c.queryFilter(c.filters.AgentApproved(user), startBlock),
        c.queryFilter(c.filters.PaymentProcessed(null, user), startBlock)
      ]);

      const agentMap = {};
      const sortedApprovals = [...approvals].sort((a, b) => a.blockNumber - b.blockNumber);
      
      sortedApprovals.forEach(evt => {
        const agent = evt.args.agent.toLowerCase();
        agentMap[agent] = {
          agent: evt.args.agent,
          initialAllowance: evt.args.allowance,
          expiration: Number(evt.args.expiration),
          blockNumber: evt.blockNumber,
          hash: evt.transactionHash
        };
      });

      const sessions = Object.values(agentMap).map(sess => {
        const agentLower = sess.agent.toLowerCase();
        const spent = payments
          .filter(p => p.args.agent.toLowerCase() === agentLower && p.blockNumber >= sess.blockNumber)
          .reduce((sum, p) => sum + p.args.amount, 0n);

        const remaining = sess.initialAllowance > spent ? sess.initialAllowance - spent : 0n;
        const nowSec = Math.floor(Date.now() / 1000);
        const isExpired = nowSec > sess.expiration;

        return {
          ...sess,
          remaining: remaining.toString(),
          spent: spent.toString(),
          isExpired,
          status: isExpired ? "Expired" : (remaining === 0n ? "Depleted" : "Active")
        };
      });

      sessions.sort((a, b) => {
        if (a.isExpired !== b.isExpired) return a.isExpired ? 1 : -1;
        return b.expiration - a.expiration;
      });

      setAgentSessions(sessions);
    } catch (err) {
      addLog(`Failed to query agent sessions: ${err.message}`, "error");
    } finally {
      setFetchingSessionsList(false);
    }
  };

  const handleRevokeAgent = async (agentAddr) => {
    if (!contract) { addLog("Wallet not connected.", "error"); return; }
    try {
      setLoading(true);
      addLog(`Revoking agent session for ${agentAddr}...`, "info");
      const tx = await contract.approveAgent(agentAddr, 0n, 0n, {
        maxFeePerGas: ethers.parseUnits("0.5", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
      });
      addLog(`Revoke transaction sent: ${tx.hash}`, "info");
      await tx.wait();
      addLog(`Agent session revoked successfully!`, "success");
      fetchAgentSessions();
    } catch (err) {
      addLog(`Revocation failed: ${err.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const fetchMyServices = async (ci, userAddress) => {
    const c = ci || contract;
    const user = userAddress || account;
    if (!c || !user) return;
    try {
      setFetchingMyServices(true);
      const startBlock = 282600000;
      const filter = c.filters.ServiceRegistered(null, user);
      const events = await c.queryFilter(filter, startBlock);
      
      const uniqueServices = {};
      events.forEach(evt => {
        const sid = evt.args.service_id;
        uniqueServices[sid] = {
          serviceId: sid,
          name: evt.args.name,
          provider: evt.args.provider,
          token: evt.args.token,
          price: evt.args.price.toString(),
          url: evt.args.url,
          blockNumber: evt.blockNumber
        };
      });

      const list = await Promise.all(Object.values(uniqueServices).map(async (srv) => {
        try {
          const provider = c.runner.provider;
          const paddedSlotActive = ethers.zeroPadValue(ethers.toBeHex(2), 32);
          const slotActive = ethers.keccak256(ethers.concat([srv.serviceId, paddedSlotActive]));
          const activeVal = await provider.getStorage(CONTRACT_ADDRESS, slotActive);
          const isActive = BigInt(activeVal) !== 0n;

          const paddedSlotPrice = ethers.zeroPadValue(ethers.toBeHex(1), 32);
          const slotPrice = ethers.keccak256(ethers.concat([srv.serviceId, paddedSlotPrice]));
          const priceVal = await provider.getStorage(CONTRACT_ADDRESS, slotPrice);
          const currentPrice = BigInt(priceVal).toString();

          return {
            ...srv,
            price: currentPrice,
            isActive
          };
        } catch (err) {
          return {
            ...srv,
            isActive: true
          };
        }
      }));

      setMyServices(list);
    } catch (err) {
      addLog(`Failed to query provider services: ${err.message}`, "error");
    } finally {
      setFetchingMyServices(false);
    }
  };

  const handleToggleServiceActive = async (srv) => {
    if (!contract) { addLog("Wallet not connected.", "error"); return; }
    try {
      setLoading(true);
      const action = srv.isActive ? "Deactivating" : "Reactivating";
      addLog(`${action} service "${srv.name}"...`, "info");
      
      const tx = srv.isActive 
        ? await contract.deactivateService(srv.serviceId, {
            maxFeePerGas: ethers.parseUnits("0.5", "gwei"),
            maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
          })
        : await contract.reactivateService(srv.serviceId, {
            maxFeePerGas: ethers.parseUnits("0.5", "gwei"),
            maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
          });

      addLog(`Transaction sent: ${tx.hash}`, "info");
      await tx.wait();
      addLog(`Service updated successfully!`, "success");
      fetchMyServices();
    } catch (err) {
      addLog(`Failed to update service: ${err.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePrice = async (srv, newPrice) => {
    if (!contract) { addLog("Wallet not connected.", "error"); return; }
    if (!newPrice) { addLog("Enter a valid price.", "error"); return; }
    try {
      setLoading(true);
      const price = ethers.toBigInt(newPrice);
      addLog(`Updating price for "${srv.name}" to ${price} USDC units...`, "info");
      const tx = await contract.registerService(srv.name, price, srv.token, srv.url, {
        maxFeePerGas: ethers.parseUnits("0.5", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
      });
      addLog(`Transaction sent: ${tx.hash}`, "info");
      await tx.wait();
      addLog(`Price updated successfully!`, "success");
      fetchMyServices();
    } catch (err) {
      addLog(`Failed to update price: ${err.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('agentpayos-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');

  const fetchRegisteredServices = async (ci) => {
    const c = ci || contract;
    if (!c) return;
    try {
      setFetchingServices(true);
      addLog("Querying on-chain service registry...", "info");
      const filter = c.filters.ServiceRegistered();
      const events = await c.queryFilter(filter, 282600000);
      const parsed = events.map(evt => ({
        serviceId: evt.args.service_id,
        provider: evt.args.provider,
        token: evt.args.token,
        name: evt.args.name,
        price: evt.args.price.toString(),
        url: evt.args.url,
        blockNumber: evt.blockNumber
      }));
      parsed.sort((a, b) => b.blockNumber - a.blockNumber);
      setRegisteredServices(parsed);
      addLog(`Found ${parsed.length} registered services.`, "success");
    } catch (err) {
      addLog(`Registry query failed: ${err.message}`, "error");
    } finally {
      setFetchingServices(false);
    }
  };

  const filteredServices = registeredServices.filter(s => {
    const q = searchQuery.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.serviceId.toLowerCase().includes(q) || s.provider.toLowerCase().includes(q);
  });

  const fetchActivity = async (ci) => {
    const c = ci || contract;
    if (!c) return;
    try {
      setFetchingActivity(true);
      const startBlock = 282600000;

      const [payments, approvals, registrations] = await Promise.all([
        c.queryFilter(c.filters.PaymentProcessed(), startBlock),
        c.queryFilter(c.filters.AgentApproved(), startBlock),
        c.queryFilter(c.filters.ServiceRegistered(), startBlock),
      ]);

      const users = new Set();
      const providers = new Set();
      let volume = 0n;

      payments.forEach(e => {
        users.add(e.args.user.toLowerCase());
        providers.add(e.args.provider.toLowerCase());
        volume += e.args.amount;
      });
      registrations.forEach(e => providers.add(e.args.provider.toLowerCase()));
      approvals.forEach(e => users.add(e.args.user.toLowerCase()));

      setActivityStats({
        totalPayments: payments.length,
        totalVolume: Number(volume) / 1e6,
        uniqueUsers: users.size,
        uniqueProviders: providers.size,
        totalServices: registrations.length,
      });

      // Build unified timeline
      const allTxns = [
        ...payments.map(e => ({ type: 'payment', hash: e.transactionHash, block: e.blockNumber, from: e.args.user, to: e.args.provider, amount: (Number(e.args.amount) / 1e6).toFixed(2), serviceId: e.args.service_id })),
        ...approvals.map(e => ({ type: 'approval', hash: e.transactionHash, block: e.blockNumber, from: e.args.user, to: e.args.agent, amount: (Number(e.args.allowance) / 1e6).toFixed(2) })),
        ...registrations.map(e => ({ type: 'registration', hash: e.transactionHash, block: e.blockNumber, from: e.args.provider, name: e.args.name })),
      ];
      allTxns.sort((a, b) => b.block - a.block);
      setRecentTxns(allTxns.slice(0, 50));

      addLog(`Activity loaded: ${payments.length} payments, ${approvals.length} approvals, ${registrations.length} registrations.`, "success");
    } catch (err) {
      addLog(`Activity fetch failed: ${err.message}`, "error");
    } finally {
      setFetchingActivity(false);
    }
  };

  useEffect(() => {
    if (consoleEndRef.current) consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    const handleAnnounce = (event) => {
      const { info, provider } = event.detail;
      setWalletProviders(prev => prev.some(p => p.info.uuid === info.uuid) ? prev : [...prev, { info, provider }]);
    };
    window.addEventListener("eip6963:announceProvider", handleAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", handleAnnounce);
  }, []);

  const connectWallet = async (selectedDetail) => {
    const injected = selectedDetail ? selectedDetail.provider : window.ethereum;
    if (!injected) { addLog("No Web3 wallet found. Please install MetaMask.", "error"); return; }
    try {
      setLoading(true);
      setShowWalletPicker(false);
      const name = selectedDetail ? selectedDetail.info.name : "Wallet";
      addLog(`Connecting to ${name}...`, "info");
      const prov = new ethers.BrowserProvider(injected);
      await prov.send("eth_requestAccounts", []);
      const signer = await prov.getSigner();
      const addr = await signer.getAddress();
      const network = await prov.getNetwork();
      if (network.chainId !== 421614n) {
        try {
          await injected.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x66eee" }] });
        } catch { addLog("Please switch to Arbitrum Sepolia manually.", "error"); setLoading(false); return; }
      }
      const inst = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
      setContract(inst); setAccount(addr);
      addLog(`Connected: ${addr}`, "success");
      fetchRegisteredServices(inst);
      fetchAgentSessions(inst, addr);
      fetchMyServices(inst, addr);
    } catch (err) { addLog(`Connection failed: ${err.message}`, "error"); }
    finally { setLoading(false); }
  };

  const handleConnectClick = () => {
    if (walletProviders.length <= 1) {
      connectWallet(walletProviders[0] || null);
    } else {
      setShowWalletPicker(!showWalletPicker);
    }
  };

  const handleRegisterService = async () => {
    if (!contract) { addLog("Wallet not connected.", "error"); return; }
    if (!serviceName || !servicePrice || !tokenAddress || !serviceUrl) { addLog("Fill in all fields.", "error"); return; }
    try {
      setLoading(true);
      const price = ethers.toBigInt(servicePrice);
      addLog(`Registering "${serviceName}"...`, "info");
      const tx = await contract.registerService(serviceName, price, tokenAddress, serviceUrl, {
        maxFeePerGas: ethers.parseUnits("0.5", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
      });
      addLog(`Tx: ${tx.hash}`, "info");
      const receipt = await tx.wait();
      addLog(`Confirmed in block ${receipt.blockNumber}`, "success");
      const sid = ethers.solidityPackedKeccak256(["bytes", "address"], [ethers.toUtf8Bytes(serviceName), account]);
      addLog(`Service ID: ${sid}`, "success");
      fetchMyServices();
    } catch (err) { addLog(`Registration failed: ${err.message}`, "error"); }
    finally { setLoading(false); }
  };

  const handleApproveAgent = async () => {
    if (!contract) { addLog("Wallet not connected.", "error"); return; }
    if (!agentAddress || !agentAllowance || !sessionDuration) { addLog("Fill in all fields.", "error"); return; }
    try {
      setLoading(true);
      addLog(`Approving agent ${agentAddress.substring(0,8)}...`, "info");
      const tx = await contract.approveAgent(agentAddress, ethers.toBigInt(agentAllowance), ethers.toBigInt(sessionDuration), {
        maxFeePerGas: ethers.parseUnits("0.5", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
      });
      addLog(`Tx: ${tx.hash}`, "info");
      await tx.wait();
      addLog("Agent session approved!", "success");
      const key = ethers.solidityPackedKeccak256(["address", "address"], [account, agentAddress]);
      addLog(`Session Key: ${key}`, "success");
      fetchAgentSessions();
    } catch (err) { addLog(`Approval failed: ${err.message}`, "error"); }
    finally { setLoading(false); }
  };

  const handlePayForService = async () => {
    if (!contract) { addLog("Wallet not connected.", "error"); return; }
    if (!payUserAddress || !payServiceID) { addLog("Fill in all fields.", "error"); return; }
    try {
      setLoading(true);
      addLog(`Paying for service...`, "info");
      const tx = await contract.payForService(payUserAddress, payServiceID, {
        maxFeePerGas: ethers.parseUnits("0.5", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
      });
      addLog(`Tx: ${tx.hash}`, "info");
      await tx.wait();
      addLog(`Payment confirmed! Use this Tx Hash in X-Payment-Tx-Hash header.`, "success");
    } catch (err) { addLog(`Payment failed: ${err.message}`, "error"); }
    finally { setLoading(false); }
  };

  const handleGenerateAgent = () => {
    const w = ethers.Wallet.createRandom();
    setAgentAddress(w.address);
    addLog(`New Agent: ${w.address}`, "success");
    addLog(`Private Key: ${w.privateKey}`, "success");
    addLog("Save this private key for your agent client.", "info");
  };

  const handleApproveUSDC = async () => {
    if (!account || !tokenAddress) { addLog("Connect wallet and set token address first.", "error"); return; }
    try {
      setLoading(true);
      const erc20 = new ethers.Contract(tokenAddress, ["function approve(address spender, uint256 amount) external returns (bool)"], contract.runner);
      const tx = await erc20.approve(CONTRACT_ADDRESS, ethers.toBigInt("10000000000"), {
        maxFeePerGas: ethers.parseUnits("0.5", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("0.05", "gwei")
      });
      addLog(`Approve tx: ${tx.hash}`, "info");
      await tx.wait();
      addLog("USDC spending approved!", "success");
    } catch (err) { addLog(`Approval failed: ${err.message}`, "error"); }
    finally { setLoading(false); }
  };

  const disconnectWallet = () => {
    setAccount("");
    setContract(null);
    setRegisteredServices([]);
    setAgentSessions([]);
    setMyServices([]);
    addLog("Wallet disconnected.", "info");
  };

  return (
    <div className="container">
      <header>
        <div className="header-left">
          <img src="/logo.png" alt="AgentPayOS Logo" style={{ width: '36px', height: '36px', borderRadius: '50%' }} />
          <h1>AgentPayOS</h1>
          <span className="badge">Arbitrum Stylus</span>
        </div>
        <div className="header-right">
          <button className="theme-toggle" onClick={toggleTheme} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <div className="wallet-area">
            {account ? (
              <>
                <div className="wallet-connected">{account.substring(0, 6)}...{account.substring(38)}</div>
                <button onClick={disconnectWallet} className="btn-ghost" title="Disconnect wallet" style={{ fontSize: '0.8rem', padding: '0.4rem 0.6rem' }}>Disconnect</button>
              </>
            ) : (
              <>
                <button onClick={handleConnectClick} className="btn-primary" disabled={loading}>
                  Connect Wallet
                </button>
                {showWalletPicker && walletProviders.length > 1 && (
                  <div className="wallet-dropdown">
                    {walletProviders.map(p => (
                      <button key={p.info.uuid} onClick={() => connectWallet(p)}>{p.info.name}</button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </header>

      <div className="tabs">
        <button className={`tab-btn ${activeTab === "dashboard" ? "active" : ""}`} onClick={() => setActiveTab("dashboard")}>Console</button>
        <button className={`tab-btn ${activeTab === "directory" ? "active" : ""}`} onClick={() => { setActiveTab("directory"); fetchRegisteredServices(); }}>Service Directory</button>
        <button className={`tab-btn ${activeTab === "activity" ? "active" : ""}`} onClick={() => { setActiveTab("activity"); fetchActivity(); }}>Activity</button>
      </div>

      {activeTab === "dashboard" ? (
        <main className="grid">
          <section className="card">
            <h2>Register Service</h2>
            <p className="card-description">Register an API endpoint on-chain so agents can discover and pay for it.</p>
            <div className="form-group">
              <label>Service Name</label>
              <input type="text" value={serviceName} onChange={e => setServiceName(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Price (USDC units, 6 decimals)</label>
              <input type="number" value={servicePrice} onChange={e => setServicePrice(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Token Address</label>
              <input type="text" value={tokenAddress} onChange={e => setTokenAddress(e.target.value)} />
            </div>
            <div className="form-group">
              <label>API Endpoint URL</label>
              <input type="text" value={serviceUrl} onChange={e => setServiceUrl(e.target.value)} />
            </div>
            <button onClick={handleRegisterService} className="btn-primary" disabled={loading || !account}>Register Service</button>
          </section>

          <section className="card">
            <h2>Approve Agent Session</h2>
            <p className="card-description">Grant a time-locked, budget-limited allowance to an agent wallet.</p>
            <div className="form-group">
              <label>Agent Address</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input type="text" value={agentAddress} onChange={e => setAgentAddress(e.target.value)} style={{ flex: 1 }} />
                <button onClick={handleGenerateAgent} className="btn-secondary" style={{ whiteSpace: 'nowrap', fontSize: '0.75rem' }}>Generate</button>
              </div>
            </div>
            <div className="form-group">
              <label>Allowance (USDC units)</label>
              <input type="number" value={agentAllowance} onChange={e => setAgentAllowance(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Duration (seconds)</label>
              <input type="number" value={sessionDuration} onChange={e => setSessionDuration(e.target.value)} />
            </div>
            <button onClick={handleApproveAgent} className="btn-primary" disabled={loading || !account}>Approve Agent</button>
            <button onClick={handleApproveUSDC} className="btn-secondary" disabled={loading || !account}>Approve USDC Spending</button>
          </section>

          <section className="card">
            <h2>Simulate Agent Payment</h2>
            <p className="card-description">Test the payForService call as an agent.</p>
            <div className="form-group">
              <label>User Address (Delegator)</label>
              <input type="text" value={payUserAddress} onChange={e => setPayUserAddress(e.target.value)} placeholder="0x..." />
            </div>
            <div className="form-group">
              <label>Service ID</label>
              <input type="text" value={payServiceID} onChange={e => setPayServiceID(e.target.value)} placeholder="0x..." />
            </div>
            <button onClick={handlePayForService} className="btn-primary" disabled={loading || !account}>Trigger Payment</button>
          </section>

          <section className="card" style={{ gridColumn: '1 / -1' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2>Manage My Services</h2>
              <button onClick={() => fetchMyServices()} className="btn-secondary" disabled={fetchingMyServices || !account} style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}>
                {fetchingMyServices ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            <p className="card-description">Toggle active status or modify pricing for services you registered from this provider account.</p>

            {fetchingMyServices ? (
              <div className="empty-state" style={{ padding: '2rem' }}>Querying services...</div>
            ) : !account ? (
              <div className="empty-state" style={{ padding: '2rem' }}>Connect wallet to manage your services.</div>
            ) : myServices.length === 0 ? (
              <div className="empty-state" style={{ padding: '2rem' }}>You have not registered any services yet.</div>
            ) : (
              <div className="txn-list">
                {myServices.map((srv, i) => {
                  const formattedPrice = (parseFloat(srv.price) / 1e6).toFixed(2);
                  const priceInputVal = priceUpdateInputs[srv.serviceId] ?? srv.price;
                  return (
                    <div key={`${srv.serviceId}-${i}`} className="txn-row" style={{ padding: '1rem 0', flexWrap: 'wrap', gap: '1rem' }}>
                      <div className="txn-left" style={{ flex: 1, minWidth: '280px' }}>
                        <span className={`txn-badge ${srv.isActive ? 'txn-payment' : 'txn-registration'}`}>
                          {srv.isActive ? 'Active' : 'Inactive'}
                        </span>
                        <div className="txn-details">
                          <span style={{ fontWeight: '500' }}>{srv.name}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                            ID: {srv.serviceId}
                          </span>
                          <span style={{ color: 'var(--accent)', fontSize: '0.75rem', fontFamily: 'SF Mono, monospace' }}>
                            Endpoint: {srv.url}
                          </span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <input 
                            type="number" 
                            value={priceInputVal} 
                            onChange={e => setPriceUpdateInputs(prev => ({ ...prev, [srv.serviceId]: e.target.value }))}
                            style={{ width: '120px', padding: '0.4rem 0.6rem', fontSize: '0.8rem' }}
                            placeholder="Price"
                          />
                          <button 
                            onClick={() => handleUpdatePrice(srv, priceUpdateInputs[srv.serviceId])}
                            className="btn-secondary"
                            disabled={loading || priceInputVal === srv.price}
                            style={{ fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}
                          >
                            Update Price
                          </button>
                        </div>
                        <button 
                          onClick={() => handleToggleServiceActive(srv)}
                          className="btn-secondary"
                          disabled={loading}
                          style={{ fontSize: '0.75rem', padding: '0.45rem 0.75rem', borderColor: srv.isActive ? 'var(--red)' : 'var(--green)', color: srv.isActive ? 'var(--red)' : 'var(--green)' }}
                        >
                          {srv.isActive ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="card" style={{ gridColumn: '1 / -1' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2>Active Agent Sessions</h2>
              <button onClick={() => fetchAgentSessions()} className="btn-secondary" disabled={fetchingSessionsList || !account} style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}>
                {fetchingSessionsList ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            <p className="card-description">Track or revoke time-locked budgets granted to agent wallets from this account.</p>

            {fetchingSessionsList ? (
              <div className="empty-state" style={{ padding: '2rem' }}>Querying approvals...</div>
            ) : !account ? (
              <div className="empty-state" style={{ padding: '2rem' }}>Connect wallet to view active sessions.</div>
            ) : agentSessions.length === 0 ? (
              <div className="empty-state" style={{ padding: '2rem' }}>No approved agent sessions found.</div>
            ) : (
              <div className="txn-list">
                {agentSessions.map((sess, i) => {
                  const remainingUSDC = (parseFloat(sess.remaining) / 1e6).toFixed(2);
                  const initialUSDC = (parseFloat(sess.initialAllowance) / 1e6).toFixed(2);
                  const expiryDate = new Date(sess.expiration * 1000).toLocaleString();
                  return (
                    <div key={`${sess.agent}-${i}`} className="txn-row" style={{ padding: '1rem 0' }}>
                      <div className="txn-left">
                        <span className={`txn-badge ${sess.status === 'Active' ? 'txn-payment' : sess.status === 'Expired' ? 'txn-registration' : 'txn-approval'}`}>
                          {sess.status}
                        </span>
                        <div className="txn-details">
                          <span style={{ fontWeight: '500' }}>Agent: {sess.agent}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                            Expires: {expiryDate} • Initial: {initialUSDC} USDC
                          </span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <span className="txn-amount" style={{ color: sess.status === 'Active' ? 'var(--green)' : 'var(--text-muted)' }}>
                          {remainingUSDC} USDC left
                        </span>
                        {sess.status === 'Active' && (
                          <button onClick={() => handleRevokeAgent(sess.agent)} className="btn-secondary" disabled={loading} style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem', borderColor: 'var(--red)', color: 'var(--red)' }}>
                            Revoke
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="card console-card">
            <div className="console-header">
              <h2>Transaction Log</h2>
              <button onClick={() => setLogs([])} className="btn-ghost" style={{ fontSize: '0.75rem' }}>Clear</button>
            </div>
            <div className="console-logs">
              {logs.map((log, i) => (
                <div key={i} className={`log-item log-${log.type}`}>[{log.timestamp}] {log.text}</div>
              ))}
              <div ref={consoleEndRef} />
            </div>
          </section>
        </main>
      ) : activeTab === "directory" ? (
        <main style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="card">
            <div className="search-bar">
              <input
                type="text"
                placeholder="Search by name, service ID, or provider..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              <button onClick={() => fetchRegisteredServices()} className="btn-secondary" disabled={fetchingServices || !account}>
                {fetchingServices ? "Loading..." : "Refresh"}
              </button>
            </div>
          </div>

          {fetchingServices ? (
            <div className="empty-state">Querying Arbitrum Sepolia...</div>
          ) : filteredServices.length === 0 ? (
            <div className="empty-state">{account ? "No services found." : "Connect your wallet to browse services."}</div>
          ) : (
            <div className="grid">
              {filteredServices.map(srv => (
                <div key={srv.serviceId} className="card service-card">
                  <div className="service-card-header">
                    <h3>{srv.name}</h3>
                    <span className="price-tag">{(parseFloat(srv.price) / 1e6).toFixed(2)} USDC</span>
                  </div>
                  <div>
                    <span className="field-label">Endpoint</span>
                    <code className="field-value">{srv.url}</code>
                  </div>
                  <div>
                    <span className="field-label">Service ID</span>
                    <div className="copy-row">
                      <code className="field-value">{srv.serviceId}</code>
                      <button className="btn-secondary" onClick={() => { navigator.clipboard.writeText(srv.serviceId); addLog(`Copied: ${srv.serviceId}`, "info"); }}>Copy</button>
                    </div>
                  </div>
                  <div>
                    <span className="field-label">Provider</span>
                    <code className="field-value">{srv.provider}</code>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      ) : activeTab === "activity" ? (
        <main style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-value">{activityStats.totalPayments}</span>
              <span className="stat-label">Total Payments</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{activityStats.totalVolume.toFixed(2)}</span>
              <span className="stat-label">Volume (USDC)</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{activityStats.uniqueUsers}</span>
              <span className="stat-label">Unique Users</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{activityStats.uniqueProviders}</span>
              <span className="stat-label">Providers</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{activityStats.totalServices}</span>
              <span className="stat-label">Services</span>
            </div>
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2>Recent Transactions</h2>
              <button onClick={() => fetchActivity()} className="btn-secondary" disabled={fetchingActivity || !account} style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}>
                {fetchingActivity ? "Loading..." : "Refresh"}
              </button>
            </div>

            {fetchingActivity ? (
              <div className="empty-state">Querying on-chain events...</div>
            ) : !account ? (
              <div className="empty-state">Connect your wallet to view activity.</div>
            ) : recentTxns.length === 0 ? (
              <div className="empty-state">No transactions found yet.</div>
            ) : (
              <div className="txn-list">
                {recentTxns.map((tx, i) => (
                  <div key={`${tx.hash}-${i}`} className="txn-row">
                    <div className="txn-left">
                      <span className={`txn-badge txn-${tx.type}`}>
                        {tx.type === 'payment' ? 'Payment' : tx.type === 'approval' ? 'Approval' : 'Register'}
                      </span>
                      <div className="txn-details">
                        {tx.type === 'payment' ? (
                          <span>{tx.from.substring(0,6)}...{tx.from.substring(38)} → {tx.to.substring(0,6)}...{tx.to.substring(38)}</span>
                        ) : tx.type === 'approval' ? (
                          <span>{tx.from.substring(0,6)}...{tx.from.substring(38)} approved {tx.to.substring(0,6)}...{tx.to.substring(38)}</span>
                        ) : (
                          <span>{tx.from.substring(0,6)}...{tx.from.substring(38)} registered "{tx.name}"</span>
                        )}
                        <a href={`https://sepolia.arbiscan.io/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer" className="txn-hash">{tx.hash.substring(0,10)}...</a>
                      </div>
                    </div>
                    {tx.amount && <span className="txn-amount">{tx.amount} USDC</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      ) : null}
    </div>
  );
}

export default App;
