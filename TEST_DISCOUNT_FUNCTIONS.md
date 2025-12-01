# Testing Guide: Which Discount Function Extension is Correct?

## Key Differences

### `gwp-discount-function` (Old)
- **API Target**: `purchase.discount-automatic.run` (older, deprecated API)
- **API Version**: 2025-01
- **Status**: Not built (no dist folder)
- **Function**: Uses `discountNode` to get metafield
- **Returns**: `discountApplications` array

### `new-gwp-discount-function` (New)
- **API Target**: `cart.lines.discounts.generate.run` (newer, recommended API)
- **API Version**: 2025-04
- **Status**: Already built (has dist/function.wasm)
- **Function**: Uses `discount` to get metafield
- **Returns**: `operations` with `productDiscountsAdd`
- **Features**: Has test files, more complete implementation

## Testing Steps

### Option 1: Test by Temporarily Disabling One

1. **Test with only `new-gwp-discount-function`**:
   ```bash
   cd extensions
   mv gwp-discount-function gwp-discount-function.disabled
   shopify app dev
   ```
   - Try adding items to cart and see if discounts apply
   - Check function logs in Shopify admin

2. **Test with only `gwp-discount-function`**:
   ```bash
   cd extensions
   mv new-gwp-discount-function new-gwp-discount-function.disabled
   mv gwp-discount-function.disabled gwp-discount-function
   # First, build it:
   cd gwp-discount-function
   shopify app function build
   cd ../..
   shopify app dev
   ```
   - Try adding items to cart and see if discounts apply
   - Check function logs in Shopify admin

### Option 2: Check Which One is Actually Deployed

1. **Check deployed functions**:
   ```bash
   shopify app info
   ```
   Look for which function extension is listed

2. **Check in Shopify Admin**:
   - Go to Settings → Apps and sales channels → Your app
   - Check which function is actually installed/active

### Option 3: Check Function Logs

1. **View function logs during test**:
   ```bash
   shopify app logs
   ```
   - Add items to cart that should trigger GWP
   - Check which function's logs appear (look for console.log messages)
   - `gwp-discount-function` logs: "GWP Discount Function running"
   - `new-gwp-discount-function` logs: "🎁 GWP FUNCTION RUNNING"

### Option 4: Check Which API Your App Uses

Look at your app code in `app/routes/app._index.jsx`:
- If it uses `discountAutomaticAppCreate` → likely needs `gwp-discount-function`
- If it uses cart operations → likely needs `new-gwp-discount-function`

## Recommendation

Based on the code:
- **`new-gwp-discount-function`** appears to be the correct one because:
  1. Uses newer API (2025-04 vs 2025-01)
  2. Uses `cart.lines.discounts.generate.run` which is the recommended approach
  3. Already built and tested
  4. More complete implementation with proper operations structure
  5. Has test files

- **`gwp-discount-function`** appears to be deprecated because:
  1. Uses older `purchase.discount-automatic.run` API
  2. Not built yet
  3. Simpler/older implementation

## Next Steps

1. Test with `new-gwp-discount-function` first (disable the old one)
2. If it works, delete `gwp-discount-function`
3. If it doesn't work, test the old one and update it to use the new API

