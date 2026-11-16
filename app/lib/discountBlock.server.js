// "Block all discounts": a store-wide switch that stops every discount from
// applying at checkout, used during sales (e.g. Black Friday) where the sale is
// done with sale prices and nothing should stack on top.
//
// The store has ~570k discount codes, so codes are never touched. Instead, while
// the block is on:
//   1. This app's discount functions read the public flag and apply nothing.
//      Their discounts stay active; nothing about them changes. The exception
//      is pos-only-discount, which keeps working in store.
//   2. Every other active or scheduled automatic discount (native Shopify or
//      another app's) is paused, since only its owner could stop it applying.
//      Its original dates are saved so it can be restored exactly.
//   3. The discount-block-checkout UI extension removes any code a customer
//      enters at checkout.
//   4. The discount-block-validation function blocks checkout if a discount is
//      still applied (Apple Pay / Google Pay express checkout, where codes
//      can't be removed by an extension).
// The validation function can't tell code discounts from automatic ones, so (2)
// matters: an automatic discount left running would block every checkout.
// guardAutomaticDiscounts (called from the discounts webhook) re-pauses any
// such discount that is created or resumed while the block is on.

// Discount and validation fields used here need a newer Admin API than the
// app's default version.
const API_VERSION = "2026-07";

// App-owned shop metafield read by the validation function and the checkout
// extension. Holds only what they need: { enabled, message }.
export const PUBLIC_NAMESPACE = "$app:discount_block";
export const PUBLIC_KEY = "config";
// App-installation metafield holding the full state, including what to restore.
const STATE_NAMESPACE = "discount_block";
const STATE_KEY = "state";

export const VALIDATION_FUNCTION_HANDLE = "discount-block-validation";
const VALIDATION_TITLE = "Block all discounts";

export const DEFAULT_MESSAGE =
  "Discount codes can't be used with our current sale prices.";

const MAX_PAGES = 10;

const DEFAULT_STATE = {
  enabled: false,
  message: DEFAULT_MESSAGE,
  enabledAt: null,
  disabledAt: null,
  // Discounts this block paused: [{ id, type, title, startsAt, endsAt }]
  paused: [],
  // Problems from the last enable/disable/guard run: [{ id, title, message }]
  errors: [],
};

const DATE_FIELDS = "title status startsAt endsAt";
const AUTOMATIC_SELECTION = `
  id
  discount {
    __typename
    ... on DiscountAutomaticBasic { ${DATE_FIELDS} }
    ... on DiscountAutomaticBxgy { ${DATE_FIELDS} }
    ... on DiscountAutomaticFreeShipping { ${DATE_FIELDS} }
    ... on DiscountAutomaticApp { ${DATE_FIELDS} appDiscountType { app { title apiKey } } }
  }`;

// Update mutation + input argument per automatic discount type, used to put
// back original dates after reactivating.
const DATE_UPDATES = {
  DiscountAutomaticBasic: ["discountAutomaticBasicUpdate", "automaticBasicDiscount", "DiscountAutomaticBasicInput"],
  DiscountAutomaticBxgy: ["discountAutomaticBxgyUpdate", "automaticBxgyDiscount", "DiscountAutomaticBxgyInput"],
  DiscountAutomaticFreeShipping: [
    "discountAutomaticFreeShippingUpdate",
    "freeShippingAutomaticDiscount",
    "DiscountAutomaticFreeShippingInput",
  ],
  DiscountAutomaticApp: ["discountAutomaticAppUpdate", "automaticAppDiscount", "DiscountAutomaticAppInput"],
};

async function gql(admin, query, variables) {
  const res = await admin.graphql(query, { variables, apiVersion: API_VERSION });
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
}

function firstUserError(payload) {
  const err = payload?.userErrors?.[0];
  return err ? err.message : null;
}

// ---------------------------------------------------------------------------
// State

export async function getBlockState(admin) {
  const data = await gql(
    admin,
    `query DiscountBlockState($namespace: String!, $key: String!) {
      currentAppInstallation {
        id
        metafield(namespace: $namespace, key: $key) { value }
      }
    }`,
    { namespace: STATE_NAMESPACE, key: STATE_KEY }
  );
  const raw = data.currentAppInstallation?.metafield?.value;
  let saved = {};
  if (raw) {
    try {
      saved = JSON.parse(raw);
    } catch {
      saved = {};
    }
  }
  return { ...DEFAULT_STATE, ...saved };
}

/** Saves the full state, and the public { enabled, message } flag on the shop. */
async function saveState(admin, state) {
  const data = await gql(
    admin,
    `query DiscountBlockOwners { currentAppInstallation { id } shop { id } }`
  );
  const result = await gql(
    admin,
    `mutation SaveDiscountBlock($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    {
      metafields: [
        {
          ownerId: data.currentAppInstallation.id,
          namespace: STATE_NAMESPACE,
          key: STATE_KEY,
          type: "json",
          value: JSON.stringify(state),
        },
        {
          ownerId: data.shop.id,
          namespace: PUBLIC_NAMESPACE,
          key: PUBLIC_KEY,
          type: "json",
          value: JSON.stringify({ enabled: state.enabled, message: state.message }),
        },
      ],
    }
  );
  const error = firstUserError(result.metafieldsSet);
  if (error) throw new Error(`Couldn't save discount block settings: ${error}`);
}

// ---------------------------------------------------------------------------
// Automatic discounts

function toAutomatic(node) {
  const d = node?.discount;
  if (!d) return null;
  return {
    id: node.id,
    type: d.__typename,
    title: d.title,
    status: d.status,
    startsAt: d.startsAt ?? null,
    endsAt: d.endsAt ?? null,
    app: d.appDiscountType?.app?.title ?? null,
    // This app's discounts stay active and are switched off by the flag instead.
    ownedByApp: !!process.env.SHOPIFY_API_KEY && d.appDiscountType?.app?.apiKey === process.env.SHOPIFY_API_KEY,
  };
}

/** Active and scheduled automatic discounts (any app, or native), each marked ownedByApp. */
export async function listLiveAutomaticDiscounts(admin) {
  const discounts = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await gql(
      admin,
      `query LiveAutomaticDiscounts($after: String) {
        discountNodes(first: 100, after: $after, query: "status:active,scheduled method:automatic") {
          pageInfo { hasNextPage endCursor }
          nodes { ${AUTOMATIC_SELECTION} }
        }
      }`,
      { after }
    );
    const conn = data.discountNodes;
    for (const node of conn.nodes) {
      const d = toAutomatic(node);
      if (d) discounts.push(d);
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return discounts;
}

async function deactivateAutomatic(admin, id) {
  const data = await gql(
    admin,
    `mutation PauseAutomatic($id: ID!) {
      discountAutomaticDeactivate(id: $id) { userErrors { field message } }
    }`,
    { id }
  );
  return firstUserError(data.discountAutomaticDeactivate);
}

/**
 * Reactivates a paused discount, then puts back its original start and end
 * dates if reactivating changed them.
 * Returns { active, error }: active is false only if reactivating failed.
 */
async function restoreAutomatic(admin, saved) {
  const activated = await gql(
    admin,
    `mutation ResumeAutomatic($id: ID!) {
      discountAutomaticActivate(id: $id) { userErrors { field message } }
    }`,
    { id: saved.id }
  );
  const activateError = firstUserError(activated.discountAutomaticActivate);
  if (activateError) return { active: false, error: `Couldn't turn back on: ${activateError}` };

  const now = await gql(admin, `query RestoredAutomatic($id: ID!) { discountNode(id: $id) { ${AUTOMATIC_SELECTION} } }`, {
    id: saved.id,
  });
  const current = toAutomatic(now.discountNode);
  if (!current) return { active: true, error: null };
  if (sameTime(current.startsAt, saved.startsAt) && sameTime(current.endsAt, saved.endsAt)) {
    return { active: true, error: null };
  }

  const update = DATE_UPDATES[saved.type];
  if (!update) return { active: true, error: null };
  const [mutation, arg, inputType] = update;
  const updated = await gql(
    admin,
    `mutation RestoreAutomaticDates($id: ID!, $input: ${inputType}!) {
      ${mutation}(id: $id, ${arg}: $input) { userErrors { field message } }
    }`,
    { id: saved.id, input: { startsAt: saved.startsAt, endsAt: saved.endsAt } }
  );
  const dateError = firstUserError(updated[mutation]);
  return {
    active: true,
    error: dateError ? `Turned back on, but its original dates couldn't be restored: ${dateError}` : null,
  };
}

function sameTime(a, b) {
  if (!a || !b) return !a && !b;
  return new Date(a).getTime() === new Date(b).getTime();
}

/**
 * Pauses the given live automatic discounts. New ones are added to
 * state.paused (and saved) before pausing, so a crash mid-way still leaves a
 * restore record; ones already on the list keep their original saved dates.
 * Returns how many were paused. Mutates state.
 */
async function pauseDiscounts(admin, state, live) {
  if (!live.length) return 0;
  const known = new Set(state.paused.map((d) => d.id));
  const added = live.filter((d) => !known.has(d.id));
  if (added.length) {
    state.paused = [
      ...state.paused,
      ...added.map(({ id, type, title, startsAt, endsAt, app }) => ({ id, type, title, startsAt, endsAt, app })),
    ];
    await saveState(admin, state);
  }

  const failed = new Set();
  for (const d of live) {
    let error;
    try {
      error = await deactivateAutomatic(admin, d.id);
    } catch (err) {
      error = err.message;
    }
    if (error) {
      failed.add(d.id);
      state.errors.push({ id: d.id, title: d.title, message: `Couldn't pause: ${error}` });
    }
  }
  // A newly added discount that never got paused has nothing to restore.
  const addedIds = new Set(added.map((d) => d.id));
  state.paused = state.paused.filter((d) => !(failed.has(d.id) && addedIds.has(d.id)));
  return live.length - failed.size;
}

async function getAutomaticDiscount(admin, id) {
  const data = await gql(admin, `query AutomaticDiscount($id: ID!) { discountNode(id: $id) { ${AUTOMATIC_SELECTION} } }`, {
    id,
  });
  return toAutomatic(data.discountNode);
}

const isLive = (d) => d && (d.status === "ACTIVE" || d.status === "SCHEDULED");
// Discounts the block has to pause: live ones this app can't switch off itself.
const needsPause = (d) => isLive(d) && !d.ownedByApp;

// ---------------------------------------------------------------------------
// Validation (checkout backstop)

async function findValidation(admin) {
  const data = await gql(
    admin,
    `query DiscountBlockValidations {
      validations(first: 25) {
        nodes { id enabled shopifyFunction { handle app { apiKey } } }
      }
    }`
  );
  return (
    data.validations.nodes.find(
      (v) =>
        v.shopifyFunction?.handle === VALIDATION_FUNCTION_HANDLE &&
        (!process.env.SHOPIFY_API_KEY || v.shopifyFunction?.app?.apiKey === process.env.SHOPIFY_API_KEY)
    ) ?? null
  );
}

export async function getValidationStatus(admin) {
  try {
    const validation = await findValidation(admin);
    return { found: !!validation, enabled: !!validation?.enabled, error: null };
  } catch (err) {
    return { found: false, enabled: false, error: err.message };
  }
}

async function setValidationEnabled(admin, enable) {
  const existing = await findValidation(admin);
  if (existing) {
    if (existing.enabled === enable) return;
    const data = await gql(
      admin,
      `mutation ToggleDiscountBlockValidation($id: ID!, $validation: ValidationUpdateInput!) {
        validationUpdate(id: $id, validation: $validation) { userErrors { field message } }
      }`,
      { id: existing.id, validation: { enable } }
    );
    const error = firstUserError(data.validationUpdate);
    if (error) throw new Error(`Couldn't ${enable ? "turn on" : "turn off"} the checkout validation: ${error}`);
    return;
  }
  if (!enable) return;
  const data = await gql(
    admin,
    `mutation CreateDiscountBlockValidation($validation: ValidationCreateInput!) {
      validationCreate(validation: $validation) { userErrors { field message } }
    }`,
    {
      validation: {
        functionHandle: VALIDATION_FUNCTION_HANDLE,
        title: VALIDATION_TITLE,
        enable: true,
        // If the function itself fails, let checkout through rather than
        // blocking every order.
        blockOnFailure: false,
      },
    }
  );
  const error = firstUserError(data.validationCreate);
  if (error) throw new Error(`Couldn't create the checkout validation: ${error}`);
}

// ---------------------------------------------------------------------------
// Public operations

/**
 * Turns the block on: set the flag (this app's discounts stop applying), pause
 * other automatic discounts, then turn on the checkout validation. Pausing goes
 * before the validation so there's no window where it sees a still-running
 * automatic discount and blocks checkout.
 */
export async function enableBlock(admin, { message } = {}) {
  const state = await getBlockState(admin);
  state.message = message?.trim() || state.message || DEFAULT_MESSAGE;
  state.errors = [];
  if (!state.enabled) {
    state.enabledAt = new Date().toISOString();
    state.disabledAt = null;
  }
  // Mark enabled before pausing so the discounts webhook treats any discount
  // resumed mid-way as something to re-pause.
  state.enabled = true;
  await saveState(admin, state);

  await pauseDiscounts(admin, state, (await listLiveAutomaticDiscounts(admin)).filter(needsPause));
  await saveState(admin, state);

  try {
    await setValidationEnabled(admin, true);
  } catch (err) {
    state.errors.push({ id: null, title: "Checkout validation", message: err.message });
    await saveState(admin, state);
  }
  return state;
}

/**
 * Turns the block off: drop the public flag and the validation first so
 * checkout stops blocking immediately, then restore paused discounts.
 * Discounts whose original end date passed while paused stay off.
 */
export async function disableBlock(admin) {
  const state = await getBlockState(admin);
  state.enabled = false;
  state.disabledAt = new Date().toISOString();
  state.errors = [];
  await saveState(admin, state);

  try {
    await setValidationEnabled(admin, false);
  } catch (err) {
    state.errors.push({ id: null, title: "Checkout validation", message: err.message });
  }

  const now = Date.now();
  const stillPaused = [];
  for (const saved of state.paused) {
    if (saved.endsAt && new Date(saved.endsAt).getTime() <= now) continue; // expired while paused
    try {
      const { active, error } = await restoreAutomatic(admin, saved);
      if (error) state.errors.push({ id: saved.id, title: saved.title, message: error });
      if (!active) stillPaused.push(saved);
    } catch (err) {
      state.errors.push({ id: saved.id, title: saved.title, message: `Couldn't turn back on: ${err.message}` });
      stillPaused.push(saved);
    }
  }
  // Keep anything that couldn't be restored so turning off again retries it.
  state.paused = stillPaused;
  await saveState(admin, state);
  return state;
}

/** Changes the customer-facing message, on or off. */
export async function updateMessage(admin, message) {
  const state = await getBlockState(admin);
  state.message = message?.trim() || DEFAULT_MESSAGE;
  await saveState(admin, state);
  return state;
}

/**
 * Called on every discounts/create|update webhook. While the block is on,
 * pauses the automatic discount if it's live (created or resumed in the admin)
 * and not this app's, and adds it to the restore list. Code discounts are ignored: they're handled
 * at checkout, and PostScript creates hundreds a day. Without a discount ID,
 * checks every automatic discount. Returns how many were paused.
 */
export async function guardAutomaticDiscounts(admin, discountGid) {
  if (discountGid && !discountGid.includes("DiscountAutomaticNode")) return 0;
  const state = await getBlockState(admin);
  if (!state.enabled) return 0;

  let live;
  if (discountGid) {
    const discount = await getAutomaticDiscount(admin, discountGid);
    live = needsPause(discount) ? [discount] : [];
  } else {
    live = (await listLiveAutomaticDiscounts(admin)).filter(needsPause);
  }
  if (!live.length) return 0;

  // Re-read just before writing: enable/disable may have run meanwhile.
  const fresh = await getBlockState(admin);
  if (!fresh.enabled) return 0;
  const paused = await pauseDiscounts(admin, fresh, live);
  await saveState(admin, fresh);
  return paused;
}
