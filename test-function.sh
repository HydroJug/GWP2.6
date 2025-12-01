#!/bin/bash

# Script to test which discount function extension works correctly
# Usage: ./test-function.sh [old|new]

echo "🧪 Testing Discount Function Extensions"
echo "========================================"
echo ""

# Check which extension to test
if [ "$1" == "old" ]; then
    echo "Testing: gwp-discount-function (old)"
    cd extensions
    mv new-gwp-discount-function new-gwp-discount-function.disabled 2>/dev/null
    mv gwp-discount-function.disabled gwp-discount-function 2>/dev/null
    echo "✅ Enabled: gwp-discount-function"
    echo "❌ Disabled: new-gwp-discount-function"
elif [ "$1" == "new" ]; then
    echo "Testing: new-gwp-discount-function (new)"
    cd extensions
    mv gwp-discount-function gwp-discount-function.disabled 2>/dev/null
    mv new-gwp-discount-function.disabled new-gwp-discount-function 2>/dev/null
    echo "✅ Enabled: new-gwp-discount-function"
    echo "❌ Disabled: gwp-discount-function"
else
    echo "Usage: ./test-function.sh [old|new]"
    echo ""
    echo "Current status:"
    ls -d extensions/*-discount-function* 2>/dev/null | sed 's|extensions/||' | while read dir; do
        if [[ "$dir" == *.disabled ]]; then
            echo "  ❌ Disabled: $dir"
        else
            echo "  ✅ Enabled: $dir"
        fi
    done
    exit 1
fi

cd ..
echo ""
echo "📋 Next steps:"
echo "1. Run: shopify app dev"
echo "2. Test adding items to cart that should trigger GWP discounts"
echo "3. Check function logs: shopify app logs"
echo "4. Look for console messages:"
echo "   - Old function: 'GWP Discount Function running'"
echo "   - New function: '🎁 GWP FUNCTION RUNNING'"
echo ""
echo "To switch back, run: ./test-function.sh [old|new]"

