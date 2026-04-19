#!/bin/bash

# Full OCR Pipeline Runner
# This script runs the complete OCR verification pipeline on all test wines

set -e

echo "🍷 VinoBuzz Full OCR Pipeline"
echo "=============================="

# Check if server is running
if ! curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "❌ Server not running. Start it first with: ./run_dev.sh"
    exit 1
fi

echo "✅ Server is healthy"
echo ""

# Refresh wine catalog
echo "📚 Refreshing wine catalog..."
curl -s http://localhost:3000/api/refresh-wines -X POST | jq .
echo ""

# Get the wines data
echo "📝 Current test wines:"
curl -s http://localhost:3000/data/wines.json | jq -r '.[] | select(.source == "manual") | "  - \(.producer) \(.vintage) (\(.appellation // "N/A"))"'
echo ""

# Run OCR pipeline on first wine as demo
echo "🔍 Running OCR pipeline demo on first wine..."
echo ""

# Get first manual wine
FIRST_WINE=$(curl -s http://localhost:3000/data/wines.json | jq -r '[.[] | select(.source == "manual")][0] | {wine_name: (.name // .producer), vintage, appellation, vineyard, classification}')

echo "Testing: $(echo $FIRST_WINE | jq -r '.wine_name') $(echo $FIRST_WINE | jq -r '.vintage')"
echo ""

# Search for images
echo "1️⃣  Searching for images..."
SEARCH_RESULT=$(curl -s http://localhost:3000/api/search \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$FIRST_WINE")

CANDIDATE_COUNT=$(echo $SEARCH_RESULT | jq '.candidates | length')
echo "   Found $CANDIDATE_COUNT candidates"
echo ""

# Run OCR verification on top candidate
if [ "$CANDIDATE_COUNT" -gt 0 ]; then
  TOP_IMAGE=$(echo $SEARCH_RESULT | jq -r '.candidates[0].original')
  echo "2️⃣  Running OCR verification on top candidate..."
  echo "   Image: $TOP_IMAGE"
  echo ""
  
  OCR_RESULT=$(curl -s http://localhost:3000/api/verify-deterministic \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{\"sku\": $FIRST_WINE, \"imageUrl\": \"$TOP_IMAGE\"}")
  
  echo "3️⃣  OCR Results:"
  echo "   Verdict: $(echo $OCR_RESULT | jq -r '.verdict')"
  echo "   Confidence: $(echo $OCR_RESULT | jq -r '.confidence')"
  echo "   Quality Factor: $(echo $OCR_RESULT | jq -r '.qualityFactor // "N/A"')"
  echo ""
  echo "   Reasoning: $(echo $OCR_RESULT | jq -r '.reasoning')"
  echo ""
  echo "   Raw OCR Text:"
  echo "   -------------------"
  echo "$(echo $OCR_RESULT | jq -r '.ocr_raw // "N/A"' | head -20)"
  echo "   -------------------"
fi

echo ""
echo "✅ OCR Pipeline demo complete!"
echo ""
echo "🌐 To run full batch analysis, open:"
echo "   http://localhost:3000"
echo ""
echo "   Then go to 'Intern Challenge Pipeline' tab and click 'START BATCH ANALYSIS'"
