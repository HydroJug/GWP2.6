import { json } from "@remix-run/node";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get('shop') || 'hydrojug.myshopify.com';
  
  const demoHTML = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Gift with Purchase - Cart Modal Demo</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body {
                font-family: Arial, sans-serif;
                max-width: 800px;
                margin: 0 auto;
                padding: 20px;
                background: #f9f9f9;
            }
            .demo-container {
                background: white;
                padding: 30px;
                border-radius: 10px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .cart-simulator {
                border: 2px solid #e5e5e5;
                border-radius: 8px;
                padding: 20px;
                margin: 20px 0;
                background: #fafafa;
            }
            .cart-total {
                font-size: 24px;
                font-weight: bold;
                color: #333;
                margin: 10px 0;
            }
            .threshold-info {
                background: #e7f3ff;
                padding: 15px;
                border-radius: 5px;
                margin: 15px 0;
                border-left: 4px solid #007cba;
            }
            .demo-button {
                background: #0161FE;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 16px;
                margin: 10px 5px;
                transition: background-color 0.2s;
            }
            .demo-button:hover {
                background: #005a87;
            }
            .demo-button.secondary {
                background: #6c757d;
            }
            .demo-button.secondary:hover {
                background: #545b62;
            }
            .instructions {
                background: #fff3cd;
                padding: 15px;
                border-radius: 5px;
                margin: 20px 0;
                border-left: 4px solid #ffc107;
            }
        </style>
    </head>
    <body>
        <div class="demo-container">
            <h1>🎁 Gift with Purchase - Cart Modal Demo</h1>
            
            <div class="instructions">
                <strong>📋 Instructions:</strong> Use the buttons below to simulate different cart totals. When you reach the gift threshold ($120), the congratulations modal will automatically appear!
            </div>
            
            <div class="cart-simulator">
                <h3>🛒 Simulated Cart</h3>
                <div class="cart-total" id="cart-total">Cart Total: $0.00</div>
                
                <div class="threshold-info">
                    <strong>🎯 Gift Thresholds:</strong><br>
                    • Tier 1: $80.00 - Choose from Can Coolers<br>
                    • Tier 2: $120.00 - Choose from Shakers
                </div>
                
                <h4>Simulate Cart Changes:</h4>
                <button class="demo-button" onclick="setCartTotal(5000)">$50.00 Cart</button>
                <button class="demo-button" onclick="setCartTotal(7500)">$80.00 Cart</button>
                <button class="demo-button" onclick="setCartTotal(12000)">$120.00 Cart (Trigger Modal!)</button>
                <button class="demo-button" onclick="setCartTotal(15000)">$160.00 Cart</button>
                <button class="demo-button secondary" onclick="setCartTotal(0)">Clear Cart</button>
            </div>
            
            <div class="instructions">
                <strong>🔧 How to Install on Your Store:</strong><br>
                Add this script to your cart page template:<br>
                <code>&lt;script src="/cart-modal?shop={{ shop.myshopify_domain }}"&gt;&lt;/script&gt;</code>
            </div>
            
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e5e5; text-align: center; color: #666;">
                <small>This is a demo page. The modal uses your actual store configuration and products.</small>
            </div>
        </div>
        
        <!-- Simulate Shopify cart object -->
        <script>
            // Create mock Shopify cart object
            window.Shopify = {
                cart: {
                    total_price: 0
                }
            };
            
            function setCartTotal(cents) {
                window.Shopify.cart.total_price = cents;
                document.getElementById('cart-total').textContent = 'Cart Total: $' + (cents / 100).toFixed(2);
                
                // Trigger cart change event
                window.dispatchEvent(new CustomEvent('cartUpdated'));
            }
            
            function updateCartDisplay() {
                const total = window.Shopify.cart.total_price || 0;
                document.getElementById('cart-total').textContent = 'Cart Total: $' + (total / 100).toFixed(2);
            }
            
            // Update display on load
            updateCartDisplay();
        </script>
        
        <!-- Load the actual GWP cart modal script -->
        <script src="/cart-modal?shop=${shop}"></script>
    </body>
    </html>
  `;

  return new Response(demoHTML, {
    headers: {
      'Content-Type': 'text/html',
      'Cache-Control': 'public, max-age=300',
    },
  });
}; 