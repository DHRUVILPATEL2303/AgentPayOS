package main

import (
	"encoding/json"
	"log"
	"net/http"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		serviceID := r.Header.Get("X-Verified-Service-Id")
		userAddr := r.Header.Get("X-Verified-User-Address")
		agentAddr := r.Header.Get("X-Verified-Agent-Address")
		providerAddr := r.Header.Get("X-Verified-Provider-Address")
		amount := r.Header.Get("X-Verified-Amount")

		log.Printf("Received authorized request!")
		log.Printf(" -> Service ID: %s", serviceID)
		log.Printf(" -> User: %s", userAddr)
		log.Printf(" -> Agent: %s", agentAddr)
		log.Printf(" -> Provider: %s", providerAddr)
		log.Printf(" -> Amount: %s units", amount)

		w.Header().Set("Content-Type", "application/json")
		response := map[string]string{
			"message":  "Hello from the Upstream API! Request was successfully authorized.",
			"data":     "Autonomous transaction telemetry has been unlocked.",
			"service":  serviceID,
			"user":     userAddr,
			"agent":    agentAddr,
			"provider": providerAddr,
			"amount":   amount,
		}
		json.NewEncoder(w).Encode(response)
	})

	log.Println("Starting dummy upstream backend on port 8081")
	if err := http.ListenAndServe(":8081", nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
