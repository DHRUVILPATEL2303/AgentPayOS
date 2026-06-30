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
	ServiceID    string
	ProviderAddr string
	Price        *big.Int
	PaymentToken string
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

func (p *ProxyServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	txHashStr := r.Header.Get("X-Payment-Tx-Hash")
	userAddrStr := r.Header.Get("X-User-Address")

	if txHashStr == "" || userAddrStr == "" {
		p.respondWithPaymentRequired(w, "Missing transaction hash or user address header")
		return
	}

	txHashStr = strings.TrimSpace(txHashStr)
	userAddrStr = strings.TrimSpace(userAddrStr)

	txHash := common.HexToHash(txHashStr)
	userAddr := common.HexToAddress(userAddrStr)

	if p.cache.IsSpent(txHashStr) {
		p.respondWithPaymentRequired(w, "Transaction hash has already been spent (replay protection)")
		return
	}

	err := p.verifyPayment(r.Context(), txHash, userAddr)
	if err != nil {
		log.Printf("Payment verification failed: %v", err)
		p.respondWithPaymentRequired(w, fmt.Sprintf("Payment verification failed: %v", err))
		return
	}

	p.cache.Spend(txHashStr)
	p.proxy.ServeHTTP(w, r)
}

func (p *ProxyServer) verifyPayment(ctx context.Context, txHash common.Hash, user common.Address) error {
	receipt, err := p.client.TransactionReceipt(ctx, txHash)
	if err != nil {
		return fmt.Errorf("failed to fetch transaction receipt: %v", err)
	}

	if receipt.Status != 1 {
		return fmt.Errorf("transaction failed on-chain")
	}

	contractAddress := common.HexToAddress(p.config.ContractAddr)
	serviceIDBytes := common.HexToHash(p.config.ServiceID)
	providerAddress := common.HexToAddress(p.config.ProviderAddr)

	var validEventFound bool

	for _, logEntry := range receipt.Logs {
		if logEntry.Address != contractAddress {
			continue
		}
		if len(logEntry.Topics) < 3 || logEntry.Topics[0] != paymentProcessedSigHash {
			continue
		}

		eventServiceID := logEntry.Topics[1]
		eventUser := common.BytesToAddress(logEntry.Topics[2].Bytes())

		if eventServiceID != serviceIDBytes {
			continue
		}
		if eventUser != user {
			continue
		}

		if len(logEntry.Data) < 96 {
			continue
		}

		eventProvider := common.BytesToAddress(logEntry.Data[32:64])
		eventAmount := new(big.Int).SetBytes(logEntry.Data[64:96])

		if eventProvider != providerAddress {
			continue
		}
		if eventAmount.Cmp(p.config.Price) < 0 {
			return fmt.Errorf("transaction amount (%s) is less than required price (%s)", eventAmount.String(), p.config.Price.String())
		}

		validEventFound = true
		break
	}

	if !validEventFound {
		return fmt.Errorf("matching PaymentProcessed event not found in logs")
	}

	return nil
}

func (p *ProxyServer) respondWithPaymentRequired(w http.ResponseWriter, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusPaymentRequired)

	response := map[string]interface{}{
		"error":       "Payment Required",
		"reason":      reason,
		"service_id":  p.config.ServiceID,
		"price":       p.config.Price.String(),
		"token":       p.config.PaymentToken,
		"recipient":   p.config.ProviderAddr,
		"contract":    p.config.ContractAddr,
	}

	json.NewEncoder(w).Encode(response)
}
