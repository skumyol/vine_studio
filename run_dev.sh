#!/bin/bash

# Development server runner
# Uses npm run dev (tsx server.ts) for hot-reload development

set -e

echo "🚀 Starting development server..."

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Run dev server
exec npm run dev
