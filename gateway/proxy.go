package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

type Config struct {
	UpstreamURL  string
	RPCURL       string
	ContractAddr string
}

type ProxyServer struct {
	config Config
	client *ethclient.Client
	cache  *TxCache
	proxy  *httputil.ReverseProxy
}

func NewProxyServer(config Config, cache *TxCache) (*ProxyServer, error) {
	client, err := ethclient.Dial(config.RPCURL)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to Ethereum RPC: %v", err)
	}

	target, err := url.Parse(config.UpstreamURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse upstream URL: %v", err)
	}

	return &ProxyServer{
		config: config,
		client: client,
		cache:  cache,
		proxy:  httputil.NewSingleHostReverseProxy(target),
	}, nil
}

var paymentProcessedSigHash = crypto.Keccak256Hash([]byte("PaymentProcessed(bytes32,address,address,address,uint256)"))

type PaymentInfo struct {
	ServiceID string
	User      string
	Agent     string
	Provider  string
	Amount    string
}

func (p *ProxyServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	txHashStr := r.Header.Get("X-Payment-Tx-Hash")
	userAddrStr := r.Header.Get("X-User-Address")

	if txHashStr == "" || userAddrStr == "" {
		p.respondWithError(w, http.StatusPaymentRequired, "Missing transaction hash or user address header")
		return
	}

	txHashStr = strings.TrimSpace(txHashStr)
	userAddrStr = strings.TrimSpace(userAddrStr)

	txHash := common.HexToHash(txHashStr)
	userAddr := common.HexToAddress(userAddrStr)

	if p.cache.IsSpent(txHashStr) {
		p.respondWithError(w, http.StatusPaymentRequired, "Transaction hash has already been spent")
		return
	}

	payInfo, err := p.verifyPayment(r.Context(), txHash, userAddr)
	if err != nil {
		log.Printf("Payment verification failed: %v", err)
		p.respondWithError(w, http.StatusPaymentRequired, fmt.Sprintf("Payment verification failed: %v", err))
		return
	}

	p.cache.Spend(txHashStr)

	r.Header.Set("X-Verified-Service-Id", payInfo.ServiceID)
	r.Header.Set("X-Verified-User-Address", payInfo.User)
	r.Header.Set("X-Verified-Agent-Address", payInfo.Agent)
	r.Header.Set("X-Verified-Provider-Address", payInfo.Provider)
	r.Header.Set("X-Verified-Amount", payInfo.Amount)

	p.proxy.ServeHTTP(w, r)
}

func (p *ProxyServer) verifyPayment(ctx context.Context, txHash common.Hash, user common.Address) (*PaymentInfo, error) {
	receipt, err := p.client.TransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch transaction receipt: %v", err)
	}

	if receipt.Status != 1 {
		return nil, fmt.Errorf("transaction failed on-chain")
	}

	contractAddress := common.HexToAddress(p.config.ContractAddr)
	var payInfo *PaymentInfo

	for _, logEntry := range receipt.Logs {
		if logEntry.Address != contractAddress {
			continue
		}
		if len(logEntry.Topics) < 3 || logEntry.Topics[0] != paymentProcessedSigHash {
			continue
		}

		eventServiceID := logEntry.Topics[1]
		eventUser := common.BytesToAddress(logEntry.Topics[2].Bytes())

		if eventUser != user {
			continue
		}

		if len(logEntry.Data) < 96 {
			continue
		}

		eventAgent := common.BytesToAddress(logEntry.Data[0:32])
		eventProvider := common.BytesToAddress(logEntry.Data[32:64])
		eventAmount := new(big.Int).SetBytes(logEntry.Data[64:96])

		payInfo = &PaymentInfo{
			ServiceID: eventServiceID.Hex(),
			User:      eventUser.Hex(),
			Agent:     eventAgent.Hex(),
			Provider:  eventProvider.Hex(),
			Amount:    eventAmount.String(),
		}
		break
	}

	if payInfo == nil {
		return nil, fmt.Errorf("matching PaymentProcessed event not found in logs")
	}

	return payInfo, nil
}

func (p *ProxyServer) respondWithError(w http.ResponseWriter, statusCode int, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)

	response := map[string]interface{}{
		"error":    "Payment Required",
		"reason":   reason,
		"contract": p.config.ContractAddr,
	}

	json.NewEncoder(w).Encode(response)
}
