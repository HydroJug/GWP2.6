# GWP Progress Bar - CSS Selector Configuration

This theme extension supports dynamic progress bar placement using CSS selectors. You can configure exactly where the progress bar appears on your store.

## How to Use

### 1. Configure in Admin Interface
1. Go to your GWP app admin interface
2. Configure your gift tiers as usual
3. In the "Progress Bar Configuration" section:
   - **Enable/Disable**: Toggle the progress bar on/off
   - **CSS Selector**: Enter a CSS selector to target where the progress bar should appear
   - **Position**: Choose "Above" or "Below" the target element
4. **Save your settings**

### 2. Enable the App Embed in Your Theme

**This step is required!** After saving your settings:

1. Go to **Online Store → Themes** in your Shopify admin
2. Click **Customize** on your active theme
3. Click **App embeds** in the left sidebar (or look for the puzzle piece icon)
4. Find **"GWP Progress Bar (CSS Selector)"** and toggle it **ON**
5. Optionally enable **Debug Mode** to see console logs for troubleshooting
6. Click **Save**

> **Note:** There are two progress bar options:
> - **GWP Progress Bar (CSS Selector)** - Uses the CSS selector configured in the admin (recommended)
> - **GWP Progress Bar** - A static app block you place manually in a section

### 3. Common CSS Selectors

Here are some common CSS selectors you can use:

#### Cart Page
- `.cart__items` - Above/below cart items
- `#cart` - Above/below cart container
- `.cart__footer` - Above/below cart footer
- `.cart-drawer__inner` - Inside cart drawer
- `cart-items` - Dawn theme cart items

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

### 4. How to Find the Right CSS Selector

1. Open your store in Chrome/Firefox
2. Right-click on the element where you want the progress bar
3. Click "Inspect" or "Inspect Element"
4. Look at the element's class (`.classname`) or ID (`#idname`)
5. Use that as your selector

**Tips:**
- Class selectors start with a dot: `.cart-items`
- ID selectors start with a hash: `#cart`
- You can combine selectors: `.cart-drawer .cart-items`
- Test your selector in the browser console: `document.querySelector('.your-selector')`

### 5. How It Works

1. The app embed loads when your store pages load
2. It fetches your configuration from the app settings
3. It looks for the element matching your CSS selector
4. It injects the progress bar above or below that element
5. The progress bar automatically updates based on cart total
6. Users can click tier icons or the "Claim" button to open the gift modal

### 6. Customization

The progress bar uses CSS classes that you can customize in your theme's CSS:

- `#gwp-progress-bar-container` - Main container
- `.gwp-progress-bar` - Progress bar background
- `.gwp-tier` - Individual tier elements
- `.gwp-tier-achieved` - Achieved tier styling
- `.gwp-tier-locked` - Locked tier styling
- `.gwp-claim-button` - Claim button styling

### 7. Troubleshooting

**Progress bar not appearing:**
- Verify the CSS selector is correct by testing in browser console
- Ensure "GWP Progress Bar (CSS Selector)" app embed is enabled in theme customizer
- Enable Debug Mode in the app embed settings to see console logs
- Check that progress bar is "Enabled" in admin settings

**Progress bar in wrong position:**
- Verify the "Above/Below" setting matches your intention
- Try a more specific CSS selector

**"Target element not found" in console:**
- The CSS selector doesn't match any element on the current page
- The element may load dynamically - try increasing Max Retries in app embed settings
- Some themes have different class names - inspect the page to find the correct selector

**No configuration loaded:**
- Ensure you've saved your settings in the admin interface
- Check that your App URL is correct in the app embed settings
- Look for errors in the browser console

### 8. Example Usage

For a cart page with the Dawn theme, you might use:
- Selector: `cart-items`
- Position: `Above`

This would place the progress bar above the cart items list, showing customers their progress toward free gifts as they shop.
