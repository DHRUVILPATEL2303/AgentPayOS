package main

import (
	"log"
	"net/http"
	"os"
)

func getEnv(key, defaultValue string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return defaultValue
}

func main() {
	upstreamURL := getEnv("UPSTREAM_URL", "http://localhost:8081")
	rpcURL := getEnv("RPC_URL", "https://sepolia-rollup.arbitrum.io/rpc")
	contractAddr := getEnv("CONTRACT_ADDRESS", "0x7e56360fc8b6190abe5ecba15bc6a23683441c46")

	config := Config{
		UpstreamURL:  upstreamURL,
		RPCURL:       rpcURL,
		ContractAddr: contractAddr,
	}

	cache := NewTxCache()
	server, err := NewProxyServer(config, cache)
	if err != nil {
		log.Fatalf("Failed to initialize proxy server: %v", err)
	}

	port := getEnv("PORT", "8080")
	log.Printf("Starting AgentPayOS Go Gateway on port %s...", port)
	log.Printf("Proxying requests to upstream: %s", upstreamURL)
	log.Printf("Verifying payments on contract: %s", contractAddr)

	err = http.ListenAndServe(":"+port, server)
	if err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
