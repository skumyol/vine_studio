#!/bin/bash

# Production server runner
# Usage: ./run_prod.sh [--check]
#   --check: Check if production server is running

set -e

CHECK_MODE=false

# Parse arguments
for arg in "$@"; do
    case $arg in
        --check)
            CHECK_MODE=true
            shift
            ;;
        *)
            ;;
    esac
done

# Check mode - verify if production server is running
if [ "$CHECK_MODE" = true ]; then
    echo "🔍 Checking production server status..."
    
    # Check if Docker container is running
    if docker ps --format "table {{.Names}}" | grep -q "vinobuzz-app"; then
        echo "✅ Production container (vinobuzz-app) is running"
        
        # Check health endpoint
        if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
            echo "✅ Server is healthy (http://localhost:3000)"
            exit 0
        else
            echo "⚠️  Container running but health check failed"
            exit 1
        fi
    else
        echo "❌ Production container (vinobuzz-app) is not running"
        exit 1
    fi
fi

# Production mode - build and run with Docker
echo "🏭 Starting production server..."

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "⚠️  Warning: .env file not found. Copying from .env.example..."
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "📝 Please update .env with your actual API keys before running"
        exit 1
    else
        echo "❌ No .env or .env.example found"
        exit 1
    fi
fi

# Build and start with docker-compose
echo "🐳 Building and starting Docker containers..."
docker-compose up --build -d

echo ""
echo "⏳ Waiting for server to start..."
sleep 5

# Verify server is running
if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "✅ Production server is running at http://localhost:3000"
else
    echo "⚠️  Server may still be starting. Check logs with: docker-compose logs -f"
fi

echo ""
echo "📝 Useful commands:"
echo "   View logs:     docker-compose logs -f"
echo "   Stop server:   docker-compose down"
echo "   Check status:  ./run_prod.sh --check"
