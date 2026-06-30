package main

import (
	"log"
	"math/big"
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
	serviceID := getEnv("SERVICE_ID", "0x0000000000000000000000000000000000000000000000000000000000000000")
	providerAddr := getEnv("PROVIDER_ADDRESS", "0x141C22D955f5dF0f54bffD8695CDC7e92b38551c")
	priceStr := getEnv("PRICE", "1000000")
	paymentToken := getEnv("PAYMENT_TOKEN", "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d")

	price, ok := new(big.Int).SetString(priceStr, 10)
	if !ok {
		log.Fatalf("Invalid price value: %s", priceStr)
	}

	config := Config{
		UpstreamURL:  upstreamURL,
		RPCURL:       rpcURL,
		ContractAddr: contractAddr,
		ServiceID:    serviceID,
		ProviderAddr: providerAddr,
		Price:        price,
		PaymentToken: paymentToken,
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
	log.Printf("Expected Service ID: %s", serviceID)
	log.Printf("Expected Price: %s units of token %s", price.String(), paymentToken)

	err = http.ListenAndServe(":"+port, server)
	if err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
