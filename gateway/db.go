package main

import (
	"sync"
)

type TxCache struct {
	mu    sync.RWMutex
	spent map[string]bool
}

func NewTxCache() *TxCache {
	return &TxCache{
		spent: make(map[string]bool),
	}
}

func (c *TxCache) IsSpent(txHash string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.spent[txHash]
}

func (c *TxCache) Spend(txHash string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.spent[txHash] = true
}
