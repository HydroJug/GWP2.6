import {
  reactExtension,
  Banner,
  BlockStack,
  Button,
  Heading,
  Image,
  InlineLayout,
  Text,
  SkeletonText,
  useShop,
  useApplyCartLinesChange,
  useCartLines,
  useDiscountCodes,
  View,
} from '@shopify/ui-extensions-react/checkout';
import { useState, useEffect, useCallback } from 'react';

export default reactExtension(
  'purchase.checkout.actions.render-before',
  () => <Extension />,
);

// The deployed app URL — config is read from here via network_access fetch
// For local dev, temporarily replace this with your shopify app dev tunnel URL
const APP_URL = 'https://gwp-2-6.vercel.app';

const ITEMS_PER_PAGE = 3;

function Extension() {
  const { myshopifyDomain } = useShop();
  const cartLines = useCartLines();
  const applyCartLinesChange = useApplyCartLinesChange();
  const discountCodes = useDiscountCodes();

  const [showModal, setShowModal] = useState(false);
  const [isChanging, setIsChanging] = useState(false);
  const [availableTiers, setAvailableTiers] = useState([]);
  const [selectedGifts, setSelectedGifts] = useState({});
  const [pageByTier, setPageByTier] = useState({});
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState(null);
  const [lastCartTotal, setLastCartTotal] = useState(0);
  const [hasShownModalForTier, setHasShownModalForTier] = useState(new Set());

  // Identify gift items already in the cart
  const existingGifts = cartLines.filter(line =>
    line.attributes?.some(attr =>
      (attr.key === '_gift_with_purchase' && attr.value === 'true') ||
      (attr.key === '_gwp_gift' && attr.value === 'true')
    )
  );

  // Map existing gift cart lines to their variantId+tierId for "selected" state
  const currentlySelectedVariants = {};
  existingGifts.forEach(gift => {
    const tierId = gift.attributes?.find(
      a => a.key === '_gwp_tier_id' || a.key === '_gift_tier_id'
    )?.value;
    const variantId = gift.merchandise?.id?.split('/').pop();
    if (tierId && variantId) {
      currentlySelectedVariants[`${tierId}-${variantId}`] = true;
    }
  });

  // Cart subtotal in cents, excluding gift items
  const cartTotal = cartLines.reduce((total, line) => {
    const isGift = line.attributes?.some(attr =>
      (attr.key === '_gwp_gift' && attr.value === 'true') ||
      (attr.key === '_gift_with_purchase' && attr.value === 'true')
    );
    if (isGift) return total;
    return total + Math.round(parseFloat(line.cost.totalAmount.amount) * 100);
  }, 0);

  const appliedDiscountCodes = discountCodes || [];
  const hasAnyDiscountCodes = appliedDiscountCodes.length > 0;
  const showDiscountWarning = existingGifts.length > 0 && hasAnyDiscountCodes;

  // Which tiers has the cart value unlocked?
  const getUnlockedTiers = useCallback(() => {
    return [...availableTiers]
      .sort((a, b) => b.thresholdAmount - a.thresholdAmount)
      .filter(tier => cartTotal >= tier.thresholdAmount);
  }, [availableTiers, cartTotal]);

  // How many gift selections remain per unlocked tier?
  const getAvailableSelections = useCallback(() => {
    const sortedTiers = getUnlockedTiers();
    const availableSelections = {};

    sortedTiers.forEach(tier => {
      if (cartTotal < tier.thresholdAmount) return;

      const tierGifts = existingGifts.filter(gift =>
        gift.attributes?.some(attr =>
          (attr.key === '_gift_tier_id' && attr.value === tier.id) ||
          (attr.key === '_gwp_tier_id' && attr.value === tier.id)
        )
      );
      const remainingSelections = tier.maxSelections - tierGifts.length;

      if (remainingSelections > 0) {
        const hasHigherTierGifts = sortedTiers.some(higherTier => {
          if (higherTier.thresholdAmount <= tier.thresholdAmount) return false;
          return existingGifts.some(gift =>
            gift.attributes?.some(attr =>
              (attr.key === '_gift_tier_id' && attr.value === higherTier.id) ||
              (attr.key === '_gwp_tier_id' && attr.value === higherTier.id)
            )
          );
        });

        if (!hasHigherTierGifts) {
          availableSelections[tier.id] = {
            tier,
            remaining: remainingSelections,
            selected: tierGifts.length,
          };
        }
      }
    });

    return availableSelections;
  }, [getUnlockedTiers, existingGifts, cartTotal, availableTiers]);

  // Load GWP config from the app's public endpoint via fetch (network_access)
  // displayProducts is pre-built at save time — no Storefront API call needed
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        if (!myshopifyDomain) throw new Error('Could not determine shop domain');

        const response = await fetch(
          `${APP_URL}/api/public/gwp-settings?shop=${myshopifyDomain}`
        );
        if (!response.ok) throw new Error(`Config fetch failed: ${response.status}`);

        const data = await response.json();

        // tiers may be an array or a JSON string depending on storage path
        let tiers = data.tiers;
        if (typeof tiers === 'string') tiers = JSON.parse(tiers);

        if (Array.isArray(tiers) && tiers.length > 0) {
          setAvailableTiers(tiers);
        } else {
          throw new Error('No tier configuration found');
        }
      } catch (error) {
        setConfigError(error.message || 'Failed to load configuration');
      } finally {
        setConfigLoading(false);
      }
    };

    fetchConfig();
  }, [myshopifyDomain]);

  // Auto-show modal when a new tier is unlocked
  useEffect(() => {
    if (configLoading || availableTiers.length === 0) return;

    const unlockedTiers = getUnlockedTiers();
    const availableSelections = getAvailableSelections();

    const newlyUnlocked = unlockedTiers.filter(
      tier => !hasShownModalForTier.has(tier.id) && availableSelections[tier.id]?.remaining > 0
    );

    if (newlyUnlocked.length > 0 && cartTotal > lastCartTotal && cartTotal > 0) {
      const updated = new Set(hasShownModalForTier);
      newlyUnlocked.forEach(tier => updated.add(tier.id));
      setHasShownModalForTier(updated);
    }

    setLastCartTotal(cartTotal);
  }, [cartTotal, availableTiers, configLoading]);

  // Remove gifts that no longer qualify (cart dropped below tier threshold)
  const removeIneligibleGifts = useCallback(async () => {
    if (!cartLines || availableTiers.length === 0) return;

    const giftItems = cartLines.filter(line =>
      line.attributes?.some(attr =>
        (attr.key === '_gift_with_purchase' && attr.value === 'true') ||
        (attr.key === '_gwp_gift' && attr.value === 'true')
      )
    );

    const lowestTier = availableTiers.reduce((lowest, tier) =>
      tier.thresholdAmount < lowest.thresholdAmount ? tier : lowest
    );

    for (const giftItem of giftItems) {
      const tierIdAttr = giftItem.attributes?.find(
        attr => attr.key === '_gift_tier_id' || attr.key === '_gwp_tier_id'
      );

      const threshold = tierIdAttr
        ? availableTiers.find(t => t.id === tierIdAttr.value)?.thresholdAmount
        : lowestTier.thresholdAmount;

      if (threshold !== undefined && cartTotal < threshold) {
        try {
          await applyCartLinesChange({
            type: 'removeCartLine',
            id: giftItem.id,
            quantity: giftItem.quantity,
          });
        } catch (_) {}
      }
    }
  }, [cartLines, cartTotal, availableTiers, applyCartLinesChange]);

  useEffect(() => {
    if (cartTotal !== undefined && availableTiers.length > 0) {
      const id = setTimeout(() => removeIneligibleGifts(), 500);
      return () => clearTimeout(id);
    }
  }, [cartTotal, removeIneligibleGifts]);

  // Add (or swap) a gift variant in the cart
  const handleSelectGift = async (variantId, tierId) => {
    try {
      // Remove any existing gift for this tier first (handles swap/change flow)
      const existingTierGift = existingGifts.find(gift =>
        gift.attributes?.some(attr =>
          (attr.key === '_gift_tier_id' && attr.value === tierId) ||
          (attr.key === '_gwp_tier_id' && attr.value === tierId)
        )
      );
      if (existingTierGift) {
        try {
          await applyCartLinesChange({
            type: 'removeCartLine',
            id: existingTierGift.id,
            quantity: existingTierGift.quantity,
          });
        } catch (_) {}
      }

      const result = await applyCartLinesChange({
        type: 'addCartLine',
        merchandiseId: `gid://shopify/ProductVariant/${variantId}`,
        quantity: 1,
        attributes: [
          { key: '_gift_with_purchase', value: 'true' },
          { key: '_gift_tier_id', value: tierId },
          { key: '_gwp_gift', value: 'true' },
          { key: '_gwp_tier_id', value: tierId },
          { key: '_gwp_added_via', value: 'checkout_extension' },
        ],
      });

      if (result.type === 'success') {
        setSelectedGifts(prev => ({ ...prev, [`${tierId}-${variantId}`]: true }));
        const availableSelections = getAvailableSelections();
        const totalRemaining = Object.values(availableSelections).reduce(
          (sum, sel) => sum + sel.remaining,
          0
        );
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

  // ── Derived display values ────────────────────────────────────────────────
  const availableSelections = getAvailableSelections();
  const showGiftOffer = Object.keys(availableSelections).length > 0 && !hasAnyDiscountCodes;
  const unlockedTiers = getUnlockedTiers();
  const highestTier = unlockedTiers[0] ?? null;
  const sortedAll = [...availableTiers].sort((a, b) => a.thresholdAmount - b.thresholdAmount);
  const nextTier = sortedAll.find(tier => cartTotal < tier.thresholdAmount);

  // In change mode, build selections from all unlocked tiers (even if slots are full)
  const modalSelections = isChanging
    ? Object.fromEntries(
        unlockedTiers.map(tier => [
          tier.id,
          {
            tier,
            remaining: 0,
            selected: existingGifts.filter(g =>
              g.attributes?.some(a =>
                (a.key === '_gwp_tier_id' && a.value === tier.id) ||
                (a.key === '_gift_tier_id' && a.value === tier.id)
              )
            ).length,
          },
        ])
      )
    : availableSelections;

  // ── Shared gift picker modal ──────────────────────────────────────────────
  const giftModal = showModal ? (
    <BlockStack spacing="none" padding="base" border="base" cornerRadius="base">
      <BlockStack spacing="extraTight">
        <Heading level={2} inlineAlignment="center">
          {isChanging
            ? 'Change Your Free Gift'
            : `Choose Your Free Gift${Object.keys(modalSelections).length > 1 ? 's' : ''}`}
        </Heading>
        <BlockStack inlineAlignment="center">
          <Text size="small" appearance="subdued">
            {isChanging
              ? 'Select a different gift to swap your current selection:'
              : 'Select your complimentary gift(s) to add to your cart:'}
          </Text>
        </BlockStack>

        {Object.entries(modalSelections).map(([tierId, selection]) => {
          const products = selection.tier.displayProducts || [];
          const page = pageByTier[tierId] || 0;
          const totalPages = Math.ceil(products.length / ITEMS_PER_PAGE);
          const visibleProducts = products.slice(
            page * ITEMS_PER_PAGE,
            (page + 1) * ITEMS_PER_PAGE
          );

          return (
            <BlockStack key={tierId} spacing="none" padding={['extraTight', 'none', 'none', 'none']}>
              <Text size="base" emphasis="strong">{selection.tier.name}</Text>
              {!isChanging && (
                <Text size="base" appearance="subdued">
                  {selection.tier.description} — {selection.remaining} remaining
                </Text>
              )}

              <BlockStack spacing="none" padding={['extraTight', 'none', 'none', 'none']}>
                {products.length > 0 ? (
                  <>
                    {visibleProducts.map(product => {
                      let imageUrl = product.image;
                      if (imageUrl?.startsWith('//')) imageUrl = `https:${imageUrl}`;
                      if (imageUrl && !imageUrl.startsWith('http')) imageUrl = null;

                      const key = `${tierId}-${product.variantId}`;
                      const isCurrentCart = !!currentlySelectedVariants[key];
                      const wasJustAdded = !!selectedGifts[key];
                      const isSelected = isCurrentCart || wasJustAdded;

                      return (
                        <BlockStack key={product.variantId} spacing="extraTight" padding="extraTight">
                          <InlineLayout
                            spacing="tight"
                            blockAlignment="center"
                            columns={imageUrl ? ['72px', 'fill', 'auto'] : ['fill', 'auto']}
                          >
                            {imageUrl && (
                              <View>
                                <Image
                                  source={imageUrl}
                                  accessibilityDescription={product.title}
                                  aspectRatio={1}
                                  fit="cover"
                                  loading="eager"
                                  sizes="small"
                                />
                              </View>
                            )}
                            <BlockStack spacing="none">
                              <Text size="base" emphasis="strong">
                                {product.title}
                              </Text>
                              <Text size="small" appearance="subdued">
                                FREE
                              </Text>
                            </BlockStack>
                            <Button
                              kind="secondary"
                              size="extraSmall"
                              disabled={isSelected}
                              onPress={() => handleSelectGift(product.variantId, tierId)}
                            >
                              {isSelected ? '✓ Selected' : isChanging ? 'Select' : 'Add'}
                            </Button>
                          </InlineLayout>
                        </BlockStack>
                      );
                    })}

                    {totalPages > 1 && (
                      <InlineLayout columns={['fill', 'auto', 'fill']} blockAlignment="center" padding={['tight', 'none', 'none', 'none']}>
                        <BlockStack inlineAlignment="start">
                          <Button
                            kind="secondary"
                            size="small"
                            disabled={page === 0}
                            onPress={() =>
                              setPageByTier(prev => ({ ...prev, [tierId]: page - 1 }))
                            }
                          >
                            ←
                          </Button>
                        </BlockStack>
                        <Text size="extraSmall" appearance="subdued">
                          {page + 1} / {totalPages}
                        </Text>
                        <BlockStack inlineAlignment="end">
                          <Button
                            kind="secondary"
                            size="small"
                            disabled={page >= totalPages - 1}
                            onPress={() =>
                              setPageByTier(prev => ({ ...prev, [tierId]: page + 1 }))
                            }
                          >
                            →
                          </Button>
                        </BlockStack>
                      </InlineLayout>
                    )}
                  </>
                ) : (
                  <Text size="extraSmall" appearance="subdued">
                    No gift options configured for this tier.
                  </Text>
                )}
              </BlockStack>
            </BlockStack>
          );
        })}

        <Button kind="secondary" size="small" onPress={closeModal}>
          Close
        </Button>
      </BlockStack>
    </BlockStack>
  ) : null;

  // ── Render ────────────────────────────────────────────────────────────────

  if (configLoading) {
    return (
      <BlockStack spacing="base">
        <Banner status="info">
          <BlockStack spacing="tight">
            <SkeletonText inlineSize="large" />
            <SkeletonText inlineSize="medium" />
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  // Show error for debugging (remove in production)
  if (configError) {
    return (
      <Banner status="critical">
        <Text size="small">GWP config error: {configError}</Text>
      </Banner>
    );
  }

  if (availableTiers.length === 0) {
    return null;
  }

  // Eligible for gifts — slots still available
  if (showGiftOffer) {
    return (
      <BlockStack spacing="base">
        {showDiscountWarning && (
          <Banner status="warning">
            <Text size="small" emphasis="strong">
              ⚠️ *Free gifts cannot be combined with other discount codes or promotional offers
            </Text>
          </Banner>
        )}

        <Banner status="success">
          <BlockStack spacing="tight">
            <Text size="medium" emphasis="strong">
              🎁 {highestTier
                ? `${highestTier.name}: ${highestTier.description}`
                : 'Free gifts available!'}
            </Text>
            <Button kind="secondary" onPress={() => setShowModal(true)}>
              Choose Your Free Gift{Object.keys(availableSelections).length > 1 ? 's' : ''}
            </Button>
          </BlockStack>
        </Banner>

        {nextTier && (
          <Banner status="info">
            <Text size="small">
              {`$${((nextTier.thresholdAmount - cartTotal) / 100).toFixed(2)} away from next tier`}
            </Text>
          </Banner>
        )}

        {giftModal}
      </BlockStack>
    );
  }

  // Discount code blocking gift offer
  if (hasAnyDiscountCodes && sortedAll.length > 0 && cartTotal >= sortedAll[0].thresholdAmount) {
    return (
      <BlockStack spacing="base">
        <Banner status="warning">
          <BlockStack spacing="tight">
            <Text size="medium" emphasis="strong">
              🚫 Free gifts unavailable with current discount code
            </Text>
            <Text size="small">
              Free gifts cannot be combined with other discount codes. Remove your discount code to
              access free gifts.
            </Text>
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  // Progress toward first tier
  if (sortedAll.length > 0 && cartTotal > 0 && !hasAnyDiscountCodes) {
    const firstTier = sortedAll[0];
    const remaining = firstTier.thresholdAmount - cartTotal;

    if (remaining > 0) {
      return (
        <BlockStack spacing="base">
          <Banner status="info">
            <BlockStack spacing="tight">
              <Text size="medium" emphasis="strong">
                {`🎁 You're $${(remaining / 100).toFixed(2)} away from a free gift!`}
              </Text>
              <Text size="small">{firstTier.description}</Text>
            </BlockStack>
          </Banner>
        </BlockStack>
      );
    }
  }

  // All gift slots filled — show confirmation with change option
  if (existingGifts.length > 0 && unlockedTiers.length > 0 && !hasAnyDiscountCodes) {
    return (
      <BlockStack spacing="base">
        <Banner status="success">
          <BlockStack spacing="tight">
            <Text size="medium" emphasis="strong">
              🎁 Your free gift has been added to your cart!
            </Text>
            <Button
              kind="secondary"
              onPress={() => {
                setIsChanging(true);
                setShowModal(true);
              }}
            >
              Change Gift
            </Button>
          </BlockStack>
        </Banner>

        {giftModal}
      </BlockStack>
    );
  }

  return null;
}
