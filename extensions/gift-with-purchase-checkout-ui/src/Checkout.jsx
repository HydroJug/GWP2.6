import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';

// Gift-with-purchase picker shown before the checkout actions. Shows progress
// toward the first tier, lets the customer add (or swap) a free gift per
// unlocked tier, and removes gifts that no longer qualify.
//
// Config comes from the shop metafield gwp.config (written on save by
// app/lib/storage.server.js: toStorefrontGwpConfig). The picker hides while GWP
// is inactive or "Block all discounts" is on, since the cart transform prices
// any gift line at $0.

export default async () => {
  render(<Extension />, document.body);
};

const ITEMS_PER_PAGE = 3;

const GIFT_FLAGS = ['_gift_with_purchase', '_gwp_gift'];
const TIER_KEYS = ['_gift_tier_id', '_gwp_tier_id'];

const isGiftLine = (line) =>
  line.attributes?.some((a) => GIFT_FLAGS.includes(a.key) && a.value === 'true');
const lineTierId = (line) => line.attributes?.find((a) => TIER_KEYS.includes(a.key))?.value;
const toVariantGid = (id) =>
  String(id).startsWith('gid://') ? String(id) : `gid://shopify/ProductVariant/${id}`;
const formatDollars = (cents) => `$${(cents / 100).toFixed(2)}`;

function Extension() {
  const gwp = readGwpConfig(shopify.appMetafields.value);
  const cartLines = shopify.lines.value;
  const hasAnyDiscountCodes = shopify.discountCodes.value.length > 0;

  const [showModal, setShowModal] = useState(false);
  const [isChanging, setIsChanging] = useState(false);
  const [selectedGifts, setSelectedGifts] = useState({});
  const [pageByTier, setPageByTier] = useState({});

  // isActive is false while "Block all discounts" is on, unless the GWP
  // discount was marked to keep working (syncGWPActiveState).
  const tiers = gwp?.isActive !== false ? (gwp?.tiers ?? []) : [];

  const existingGifts = cartLines.filter(isGiftLine);
  const giftsForTier = (tierId) => existingGifts.filter((line) => lineTierId(line) === tierId);

  // Variants already in the cart, keyed by tier, for the "selected" state.
  const currentlySelectedVariants = {};
  for (const gift of existingGifts) {
    const tierId = lineTierId(gift);
    if (tierId && gift.merchandise?.id) currentlySelectedVariants[`${tierId}-${gift.merchandise.id}`] = true;
  }

  // Cart total in cents, excluding gift lines.
  const cartTotal = cartLines.reduce(
    (total, line) =>
      isGiftLine(line) ? total : total + Math.round(Number(line.cost.totalAmount.amount) * 100),
    0,
  );

  // Unlocked tiers, highest first.
  const unlockedTiers = [...tiers]
    .sort((a, b) => b.thresholdAmount - a.thresholdAmount)
    .filter((tier) => cartTotal >= tier.thresholdAmount);

  // Gift slots left per unlocked tier. A tier is skipped once the customer has
  // taken a gift from a higher tier.
  const availableSelections = {};
  for (const tier of unlockedTiers) {
    const selected = giftsForTier(tier.id).length;
    const remaining = tier.maxSelections - selected;
    if (remaining <= 0) continue;
    const hasHigherTierGifts = unlockedTiers.some(
      (higher) => higher.thresholdAmount > tier.thresholdAmount && giftsForTier(higher.id).length > 0,
    );
    if (!hasHigherTierGifts) availableSelections[tier.id] = {tier, remaining, selected};
  }

  // Remove gifts that no longer qualify (cart dropped below the tier threshold).
  const removing = useRef(new Set());
  useEffect(() => {
    if (!tiers.length) return undefined;
    const lowestTier = tiers.reduce((low, tier) => (tier.thresholdAmount < low.thresholdAmount ? tier : low));
    const id = setTimeout(async () => {
      for (const gift of existingGifts) {
        const tierId = lineTierId(gift);
        const threshold = tierId
          ? tiers.find((t) => t.id === tierId)?.thresholdAmount
          : lowestTier.thresholdAmount;
        if (threshold === undefined || cartTotal >= threshold || removing.current.has(gift.id)) continue;
        removing.current.add(gift.id);
        try {
          await shopify.applyCartLinesChange({type: 'removeCartLine', id: gift.id, quantity: gift.quantity});
        } catch (_) {
          // Leave it; the next cart change retries.
        } finally {
          removing.current.delete(gift.id);
        }
      }
    }, 500);
    return () => clearTimeout(id);
  }, [cartTotal, tiers.length, existingGifts.map((g) => g.id).join()]);

  // Add (or swap) a gift variant in the cart.
  const handleSelectGift = async (variantId, tierId) => {
    try {
      const existingTierGift = existingGifts.find((gift) => lineTierId(gift) === tierId);
      if (existingTierGift) {
        try {
          await shopify.applyCartLinesChange({
            type: 'removeCartLine',
            id: existingTierGift.id,
            quantity: existingTierGift.quantity,
          });
        } catch (_) {}
      }

      const result = await shopify.applyCartLinesChange({
        type: 'addCartLine',
        merchandiseId: variantId,
        quantity: 1,
        attributes: [
          {key: '_gift_with_purchase', value: 'true'},
          {key: '_gift_tier_id', value: tierId},
          {key: '_gwp_gift', value: 'true'},
          {key: '_gwp_tier_id', value: tierId},
          {key: '_gwp_added_via', value: 'checkout_extension'},
        ],
      });

      if (result.type === 'success') {
        setSelectedGifts((prev) => ({...prev, [`${tierId}-${variantId}`]: true}));
        const totalRemaining = Object.values(availableSelections).reduce((sum, sel) => sum + sel.remaining, 0);
        if (totalRemaining <= 1) {
          setTimeout(() => {
            setShowModal(false);
            setIsChanging(false);
          }, 1000);
        }
      }
    } catch (_) {}
  };

  const closeModal = () => {
    setShowModal(false);
    setIsChanging(false);
  };

  if (!tiers.length) return null;

  const showGiftOffer = Object.keys(availableSelections).length > 0 && !hasAnyDiscountCodes;
  const showDiscountWarning = existingGifts.length > 0 && hasAnyDiscountCodes;
  const highestTier = unlockedTiers[0] ?? null;
  const sortedAll = [...tiers].sort((a, b) => a.thresholdAmount - b.thresholdAmount);
  const nextTier = sortedAll.find((tier) => cartTotal < tier.thresholdAmount);

  // In change mode, list every unlocked tier (even full ones).
  const modalSelections = isChanging
    ? Object.fromEntries(
        unlockedTiers.map((tier) => [tier.id, {tier, remaining: 0, selected: giftsForTier(tier.id).length}]),
      )
    : availableSelections;

  const giftModal = showModal ? (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-heading>
          {isChanging
            ? 'Change Your Free Gift'
            : `Choose Your Free Gift${Object.keys(modalSelections).length > 1 ? 's' : ''}`}
        </s-heading>
        <s-text color="subdued">
          {isChanging
            ? 'Select a different gift to swap your current selection:'
            : 'Select your complimentary gift(s) to add to your cart:'}
        </s-text>

        {Object.entries(modalSelections).map(([tierId, selection]) => {
          const products = tierProducts(selection.tier);
          const page = pageByTier[tierId] || 0;
          const totalPages = Math.ceil(products.length / ITEMS_PER_PAGE);
          const visibleProducts = products.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

          return (
            <s-stack key={tierId} gap="small-300">
              <s-text type="strong">{selection.tier.name}</s-text>
              {!isChanging && (
                <s-text color="subdued">
                  {selection.tier.description} — {selection.remaining} remaining
                </s-text>
              )}

              {products.length === 0 && (
                <s-text color="subdued">No gift options configured for this tier.</s-text>
              )}

              {visibleProducts.map((product) => {
                const key = `${tierId}-${product.variantId}`;
                const isSelected = !!currentlySelectedVariants[key] || !!selectedGifts[key];
                return (
                  <s-grid
                    key={product.variantId}
                    gridTemplateColumns={product.image ? '72px 1fr auto' : '1fr auto'}
                    alignItems="center"
                    gap="small-200"
                  >
                    {product.image && (
                      <s-image src={product.image} alt={product.title} aspectRatio="1" objectFit="cover" loading="eager" />
                    )}
                    <s-stack gap="none">
                      <s-text type="strong">{product.title}</s-text>
                      <s-text color="subdued">FREE</s-text>
                    </s-stack>
                    <s-button
                      variant="secondary"
                      disabled={isSelected}
                      onClick={() => handleSelectGift(product.variantId, tierId)}
                    >
                      {isSelected ? '✓ Selected' : isChanging ? 'Select' : 'Add'}
                    </s-button>
                  </s-grid>
                );
              })}

              {totalPages > 1 && (
                <s-grid gridTemplateColumns="1fr auto 1fr" alignItems="center" gap="small-200">
                  <s-stack alignItems="start">
                    <s-button
                      variant="secondary"
                      accessibilityLabel="Previous gifts"
                      disabled={page === 0}
                      onClick={() => setPageByTier((prev) => ({...prev, [tierId]: page - 1}))}
                    >
                      ←
                    </s-button>
                  </s-stack>
                  <s-text color="subdued">
                    {page + 1} / {totalPages}
                  </s-text>
                  <s-stack alignItems="end">
                    <s-button
                      variant="secondary"
                      accessibilityLabel="More gifts"
                      disabled={page >= totalPages - 1}
                      onClick={() => setPageByTier((prev) => ({...prev, [tierId]: page + 1}))}
                    >
                      →
                    </s-button>
                  </s-stack>
                </s-grid>
              )}
            </s-stack>
          );
        })}

        <s-button variant="secondary" onClick={closeModal}>
          Close
        </s-button>
      </s-stack>
    </s-box>
  ) : null;

  // Eligible for gifts with slots still open.
  if (showGiftOffer) {
    return (
      <s-stack gap="base">
        {showDiscountWarning && (
          <s-banner tone="warning">
            <s-text type="strong">
              ⚠️ *Free gifts cannot be combined with other discount codes or promotional offers
            </s-text>
          </s-banner>
        )}

        <s-banner tone="success">
          <s-stack gap="small-200">
            <s-text type="strong">
              🎁 {highestTier ? `${highestTier.name}: ${highestTier.description}` : 'Free gifts available!'}
            </s-text>
            <s-button variant="secondary" onClick={() => setShowModal(true)}>
              Choose Your Free Gift{Object.keys(availableSelections).length > 1 ? 's' : ''}
            </s-button>
          </s-stack>
        </s-banner>

        {nextTier && (
          <s-banner tone="info">
            <s-text>{`${formatDollars(nextTier.thresholdAmount - cartTotal)} away from next tier`}</s-text>
          </s-banner>
        )}

        {giftModal}
      </s-stack>
    );
  }

  // A discount code is blocking the gift offer.
  if (hasAnyDiscountCodes && sortedAll.length > 0 && cartTotal >= sortedAll[0].thresholdAmount) {
    return (
      <s-banner tone="warning">
        <s-stack gap="small-200">
          <s-text type="strong">🚫 Free gifts unavailable with current discount code</s-text>
          <s-text>
            Free gifts cannot be combined with other discount codes. Remove your discount code to access free
            gifts.
          </s-text>
        </s-stack>
      </s-banner>
    );
  }

  // Progress toward the first tier.
  if (sortedAll.length > 0 && cartTotal > 0 && !hasAnyDiscountCodes) {
    const firstTier = sortedAll[0];
    const remaining = firstTier.thresholdAmount - cartTotal;
    if (remaining > 0) {
      return (
        <s-banner tone="info">
          <s-stack gap="small-200">
            <s-text type="strong">{`🎁 You're ${formatDollars(remaining)} away from a free gift!`}</s-text>
            <s-text>{firstTier.description}</s-text>
          </s-stack>
        </s-banner>
      );
    }
  }

  // Every gift slot filled: confirm, with an option to swap.
  if (existingGifts.length > 0 && unlockedTiers.length > 0 && !hasAnyDiscountCodes) {
    return (
      <s-stack gap="base">
        <s-banner tone="success">
          <s-stack gap="small-200">
            <s-text type="strong">🎁 Your free gift has been added to your cart!</s-text>
            <s-button
              variant="secondary"
              onClick={() => {
                setIsChanging(true);
                setShowModal(true);
              }}
            >
              Change Gift
            </s-button>
          </s-stack>
        </s-banner>
        {giftModal}
      </s-stack>
    );
  }

  return null;
}

/** One entry per gift variant: { variantId (GID), title, image }. */
function tierProducts(tier) {
  const list = Array.isArray(tier.giftProducts) && tier.giftProducts.length ? tier.giftProducts : tier.displayProducts ?? [];
  return list
    .filter((p) => p?.variantId)
    .map((p) => {
      let image = p.image ?? null;
      if (image?.startsWith('//')) image = `https:${image}`;
      if (image && !image.startsWith('http')) image = null;
      return {variantId: toVariantGid(p.variantId), title: p.title, image};
    });
}

/** The gwp.config shop metafield declared in shopify.extension.toml. */
function readGwpConfig(entries) {
  return parseJson(
    entries.find(
      ({target, metafield}) =>
        target.type === 'shop' && metafield.namespace === 'gwp' && metafield.key === 'config',
    ),
  );
}

function parseJson(entry) {
  if (!entry) return null;
  try {
    const value = JSON.parse(String(entry.metafield.value));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
