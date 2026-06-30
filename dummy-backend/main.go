package main

import (
	"encoding/json"
	"log"
	"net/http"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		response := map[string]string{
			"message": "Hello from the Upstream API! Request was successfully authorized.",
			"data":    "Autonomous transaction telemetry has been unlocked.",
		}
		json.NewEncoder(w).Encode(response)
	})

	log.Println("Starting dummy upstream backend on port 8081")
	if err := http.ListenAndServe(":8081", nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
