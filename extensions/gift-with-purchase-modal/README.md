# Gift with Purchase App

A Shopify app that offers free gifts when customers reach a minimum cart threshold.

## Features

- **Automatic Gift Trigger**: Offers free gifts when cart total reaches $70 (configurable)
- **Modal Interface**: Beautiful modal popup displays gift options in the cart area
- **Gift Selection**: Customers can choose one free gift from a carousel of eligible products
- **Automatic Pricing**: Selected gifts are automatically added to cart at $0.00
- **Merchant Configuration**: Easy setup through extension settings

## How It Works

1. **Cart Monitoring**: The checkout UI extension monitors the cart total in real-time
2. **Threshold Check**: When cart total ≥ $70, the gift offer is triggered
3. **Modal Display**: A modal popup shows available gift products with images and details
4. **Gift Selection**: Customer selects one gift from the available options
5. **Cart Addition**: Selected gift is added to cart with special attributes
6. **Price Override**: Cart transform function sets gift price to $0.00

## Architecture

### Extensions

1. **Checkout UI Extension** (`gift-with-purchase-modal`)
   - Monitors cart total and triggers gift offers
   - Displays modal with gift selection interface
   - Handles gift product selection and cart addition
   - Target: `purchase.checkout.cart-line-list.render-after`

2. **Cart Transform Function** (`gift-pricing-transform`)
   - Detects products with `_gift_with_purchase` attribute
   - Sets price to $0.00 for gift products
   - Ensures gifts are always free at checkout

### Configuration

The app uses extension settings for merchant configuration:

- **Threshold Amount**: Minimum cart total to trigger gift offer (in cents)
- **Gift Product IDs**: Comma-separated list of product IDs eligible as gifts

## Setup Instructions

### 1. Configure Gift Products

1. In your Shopify admin, note the product IDs of items you want to offer as gifts
2. In the app settings, add these IDs to the "Gift Product IDs" field (comma-separated)
3. Set your desired threshold amount in cents (e.g., 7000 for $70)

### 2. Deploy the App

```bash
# Install dependencies
npm install

# Start development server
shopify app dev

# Deploy to production
shopify app deploy
```

### 3. Install in Store

1. Install the app in your Shopify store
2. Configure the extension settings:
   - Set threshold amount (default: 7000 cents = $70)
   - Add gift product IDs (e.g., "123456789,987654321")

### 4. Test the Flow

1. Add products to cart totaling less than threshold
2. Add more products to exceed threshold
3. Verify gift modal appears
4. Select a gift and confirm it's added at $0.00
5. Complete checkout to ensure pricing is maintained

## Technical Details

### Cart Line Attributes

Gift products are identified by these attributes:
- `_gift_with_purchase`: "true" (marks item as a gift)
- `_original_price`: Original product price (for reference)

### API Integration

- **Storefront API**: Fetches gift product details and images
- **Checkout API**: Adds products to cart with custom attributes
- **Cart Transform API**: Modifies pricing for gift items

### Error Handling

- Graceful fallback if gift products are unavailable
- Loading states during API calls
- Prevents duplicate gift additions

## Customization

### Styling
The modal uses Shopify's UI components and inherits the store's theme styling.

### Threshold Logic
Modify the threshold check in `Checkout.jsx`:
```javascript
const thresholdAmount = settings.threshold_amount || 7000;
```

### Gift Detection
Update the cart transform function in `run.js` to modify gift detection logic:
```javascript
const giftAttribute = line.attribute({ key: '_gift_with_purchase' });
const isGift = giftAttribute && giftAttribute.value === 'true';
```

## Troubleshooting

### Gift Modal Not Appearing
- Check that cart total exceeds threshold
- Verify gift product IDs are correct
- Ensure products exist and are published

### Gifts Not Free
- Confirm cart transform function is deployed
- Check that gift attributes are properly set
- Verify function has necessary permissions

### API Errors
- Check network access is enabled in extension settings
- Verify Storefront API access is configured
- Ensure product IDs are valid

## Support

For issues or questions:
1. Check the browser console for error messages
2. Verify extension settings are correct
3. Test with different products and thresholds
4. Review Shopify app logs for function errors 