
with open("src/components/ecommerce/OrdersPage.tsx", "r", encoding="utf-8") as f:
    content = f.read()

# I need to add variant logic to confirmEdit, cancelOrder, confirmReturn
import re

# 1. In confirmEdit:
edit_variant_logic = """
      // -- VARIANT LOGIC: ADJUST STOCK --
      for (const b of before) {
        if (b.variantName) {
          const product = products.find(p => p.id === b.productId);
          if (product?.metadata?.variants) {
            const variants = [...product.metadata.variants];
            const variant = variants.find(v => v.name === b.variantName);
            if (variant) {
              variant.stock = (variant.stock || 0) + b.quantity;
              updateProduct(b.productId, { metadata: { ...product.metadata, variants } });
            }
          }
        }
      }
      for (const a of after) {
        if (a.variantName) {
          const product = products.find(p => p.id === a.productId);
          if (product?.metadata?.variants) {
            const variants = [...product.metadata.variants];
            const variant = variants.find(v => v.name === a.variantName);
            if (variant) {
              variant.stock = (variant.stock || 0) - a.quantity;
              updateProduct(a.productId, { metadata: { ...product.metadata, variants } });
            }
          }
        }
      }
      // ---------------------------------
"""

# Find where to inject it in confirmEdit: 
if "updateOrder(order.id, {" in content:
    content = content.replace("updateOrder(order.id, {", edit_variant_logic + "\n      updateOrder(order.id, {")

# 2. In cancelOrder
cancel_variant_logic = """
      // -- VARIANT LOGIC: RESTOCK --
      for (const line of order.stockItems ?? []) {
        if (line.variantName) {
          const product = products.find(p => p.id === line.productId);
          if (product?.metadata?.variants) {
            const variants = [...product.metadata.variants];
            const variant = variants.find(v => v.name === line.variantName);
            if (variant) {
              variant.stock = (variant.stock || 0) + line.quantity;
              updateProduct(line.productId, { metadata: { ...product.metadata, variants } });
            }
          }
        }
      }
      // ---------------------------------
"""

# Find where to inject it in cancelOrder:
if "updateOrder(orderId, { status: \"cancelled\"" in content:
    content = content.replace("updateOrder(orderId, { status: \"cancelled\"", cancel_variant_logic + "\n      updateOrder(orderId, { status: \"cancelled\"")

# 3. In confirmReturn
return_variant_logic = """
      // -- VARIANT LOGIC: RESTOCK RETURNED ITEMS --
      for (const l of returnedLines) {
        if (l.variantName) {
          const product = products.find(p => p.id === l.productId);
          if (product?.metadata?.variants) {
            const variants = [...product.metadata.variants];
            const variant = variants.find(v => v.name === l.variantName);
            if (variant) {
              variant.stock = (variant.stock || 0) + l.quantity;
              updateProduct(l.productId, { metadata: { ...product.metadata, variants } });
            }
          }
        }
      }
      // ------------------------------------------
"""

# Find where to inject it in confirmReturn:
if "updateOrder(order.id, {" in content.split("async function confirmReturn()")[1]:
    # We must be careful because there are multiple updateOrder calls.
    # In confirmReturn, the returned lines are `returnedLines` or `toReturn`.
    pass

with open("src/components/ecommerce/OrdersPage.tsx", "w", encoding="utf-8") as f:
    f.write(content)

