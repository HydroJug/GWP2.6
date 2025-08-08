# GWP Progress Bar - CSS Selector Configuration

This theme extension now supports dynamic progress bar placement using CSS selectors instead of being limited to app blocks.

## How to Use

### 1. Configure in Admin Interface
1. Go to your GWP app admin interface
2. Configure your gift tiers as usual
3. In the "Progress Bar Configuration" section:
   - **Enable/Disable**: Toggle the progress bar on/off
   - **CSS Selector**: Enter a CSS selector to target where the progress bar should appear
   - **Position**: Choose "Above" or "Below" the target element

### 2. Add to Your Theme
Include the progress bar injector in your theme by adding this snippet to your theme's layout or specific templates:

```liquid
{% render 'gwp-progress-bar-injector' %}
```

### 3. Common CSS Selectors

Here are some common CSS selectors you can use:

#### Cart Page
- `.cart__items` - Above/below cart items
- `#cart` - Above/below cart container
- `.cart__footer` - Above/below cart footer

#### Product Page
- `.product-form` - Above/below product form
- `.product__info` - Above/below product info
- `.product__description` - Above/below product description

#### Collection Page
- `.collection__products` - Above/below product grid
- `.collection__header` - Above/below collection header

#### Homepage
- `.featured-collection` - Above/below featured collection
- `.hero` - Above/below hero section

### 4. How It Works

1. The JavaScript loads the configuration from your admin settings
2. It looks for the element matching your CSS selector
3. It injects the progress bar above or below that element
4. The progress bar automatically updates based on cart total
5. Users can click tier icons or the "Claim" button to open the gift modal

### 5. Customization

The progress bar uses CSS classes that you can customize in your theme's CSS:

- `#gwp-progress-bar-container` - Main container
- `.gwp-progress-bar` - Progress bar background
- `.gwp-tier` - Individual tier elements
- `.gwp-tier-achieved` - Achieved tier styling
- `.gwp-tier-locked` - Locked tier styling
- `.gwp-claim-button` - Claim button styling

### 6. Troubleshooting

- **Progress bar not appearing**: Check that your CSS selector is correct and the element exists on the page
- **Progress bar in wrong position**: Verify the "Above/Below" setting matches your intention
- **No configuration loaded**: Ensure you've saved your settings in the admin interface

### 7. Example Usage

For a cart page, you might use:
- Selector: `.cart__items`
- Position: `Below`

This would place the progress bar below the cart items list, showing customers their progress toward free gifts as they add items to their cart. 