#!/bin/bash

# Production Deployment Script for Guardrails Tower Defense
# This script rebuilds and restarts the Docker container

set -e  # Exit on any error

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

CONTAINER_NAME="guardrails-tower-defense-guardrail-td-1"
SERVICE_URL="https://guardrails.zeneke.com"

echo "Starting deployment..."

# Build new image
echo "Building Docker image..."
docker compose build

# Stop and restart container
echo "Restarting container..."
docker compose down
docker compose up -d

# Wait for container to start
echo "Waiting for container to start..."
sleep 3

# Check if container is running
if ! docker ps | grep -q guardrail-td; then
    echo "Error: Container failed to start!"
    echo "Check logs with: docker compose logs"
    exit 1
fi

# Verify the app responds
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200"; then
    echo "Health check passed."
else
    echo "Warning: App not responding on port 3000 yet. It may still be starting."
    echo "Check logs with: docker compose logs -f"
fi

# Show status
echo ""
echo "Deployment completed successfully!"
echo ""
echo "Container status:"
docker ps --format "table {{.Names}}\t{{.Ports}}\t{{.Status}}" | grep guardrail-td
echo ""
echo "Quick commands:"
echo "  View logs:       docker compose logs -f"
echo "  Restart:         docker compose restart"
echo "  Stop:            docker compose down"
echo ""
echo "App available at: $SERVICE_URL"
