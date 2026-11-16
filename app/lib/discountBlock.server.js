// "Block all discounts": a store-wide switch that stops every discount from
// applying at checkout, used during sales (e.g. Black Friday) where the sale is
// done with sale prices and nothing should stack on top.
//
// The store has ~570k discount codes, so codes are never touched. Instead, while
// the block is on:
//   1. This app's discount functions read the public flag and apply nothing.
//      Their discounts stay active; nothing about them changes. The exceptions
//      are pos-only-discount, which keeps working in store, and any discount
//      the merchant marks "Keep working" (setExempt), which keeps applying.
//   2. Every other active or scheduled automatic discount (native Shopify or
//      another app's) is paused, since only its owner could stop it applying.
//      Its original dates are saved so it can be restored exactly.
//   3. The discount-block-checkout UI extension removes any code a customer
//      enters at checkout.
//   4. The discount-block-validation function blocks payment if a discount is
//      still applied (Apple Pay / Google Pay express checkout, where codes
//      can't be removed by an extension).
// The validation function can't tell code discounts from automatic ones (it
// does skip exempt ones), so an automatic discount left running would block
// every order it applies to. So the validation is only turned on once every
// other automatic discount is confirmed paused (reconcile). If anything can't
// be paused, or the list of discounts couldn't be read in full, the validation
// is held off and the block shows as "not fully on" until a later reconcile
// succeeds: on the next discounts webhook, page load, or Enable click.

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

// Boolean metafield on one of this app's discounts: "true" keeps it applying
// while the block is on. Read by the discount functions (input.discount) and
// the validation function (cart.discountApplications).
export const EXEMPT_NAMESPACE = "$app:discount_block";
export const EXEMPT_KEY = "exempt";

// This app's discount functions that can't be kept working during the block.
// bundle-builder's input query is at Shopify's complexity limit of 30, so it
// can't read the exempt metafield; pos-only-discount ignores the block anyway.
const EXEMPT_UNSUPPORTED = {
  "bundle-builder": "Bundle discounts can't be kept working during the block.",
  "pos-only-discount": "POS-only discounts always keep working in store.",
};

export const VALIDATION_FUNCTION_HANDLE = "discount-block-validation";
const VALIDATION_TITLE = "Block all discounts";

export const DEFAULT_MESSAGE =
  "Discount codes can't be used with our current sale prices.";

// 100 per page. Past this the list is reported incomplete, which holds the
// validation off rather than risk a live discount nobody saw.
const MAX_PAGES = 10;

const DEFAULT_STATE = {
  enabled: false,
  message: DEFAULT_MESSAGE,
  enabledAt: null,
  disabledAt: null,
  // Discounts this block paused: [{ id, type, title, startsAt, endsAt, app }]
  paused: [],
  // Problems from the last run: [{ id, title, message }]
  errors: [],
  // True when the last reconcile didn't finish cleanly (a pause failed, the
  // discount list was incomplete, or a webhook guard errored). The checkout
  // validation is off while this is true; the next reconcile retries.
  needsSweep: false,
};

const DATE_FIELDS = "title status startsAt endsAt";
const AUTOMATIC_SELECTION = `
  id
  blockExempt: metafield(namespace: "${EXEMPT_NAMESPACE}", key: "${EXEMPT_KEY}") { value }
  discount {
    __typename
    ... on DiscountAutomaticBasic { ${DATE_FIELDS} }
    ... on DiscountAutomaticBxgy { ${DATE_FIELDS} }
    ... on DiscountAutomaticFreeShipping { ${DATE_FIELDS} }
    ... on DiscountAutomaticApp { ${DATE_FIELDS} appDiscountType { functionId app { title apiKey } } }
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

// ---------------------------------------------------------------------------
// Admin API with retries

// Waits between attempts when Shopify throttles (likely during a sale, when
// other apps are busy too). About 15s in total before giving up.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(err) {
  let body = "";
  try {
    body = JSON.stringify(err?.body ?? err?.graphQLErrors ?? err?.errors ?? "");
  } catch {
    body = "";
  }
  return `${err?.message ?? err} ${body}`;
}

// Throttled requests never ran, so they're always safe to repeat.
const isThrottle = (err) => /THROTTLED|Throttled|\b429\b/.test(errorText(err));
// Server and network failures may or may not have run.
const isTransient = (err) =>
  /\b50[234]\b|Internal error|timed? ?out|ETIMEDOUT|ECONNRESET|fetch failed|socket hang up/i.test(errorText(err));

/**
 * Runs an Admin GraphQL operation, retrying with backoff on throttling (and on
 * server or network errors unless `once` is set, for operations that mustn't
 * run twice).
 */
async function gql(admin, query, variables, { once = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    let error;
    try {
      const res = await admin.graphql(query, { variables, apiVersion: API_VERSION, tries: 3 });
      const data = await res.json();
      if (!data.errors?.length) return data.data;
      error = Object.assign(new Error(data.errors[0].message), { errors: data.errors });
    } catch (err) {
      error = err;
    }
    const retry = isThrottle(error) || (!once && isTransient(error));
    if (!retry || attempt >= RETRY_DELAYS_MS.length) {
      throw error instanceof Error ? error : new Error(errorText(error));
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

function firstUserError(payload) {
  const err = payload?.userErrors?.[0];
  return err ? err.message : null;
}

// ---------------------------------------------------------------------------
// State

async function readState(admin) {
  const data = await gql(
    admin,
    `query DiscountBlockState($namespace: String!, $key: String!) {
      shop { id }
      currentAppInstallation {
        id
        metafield(namespace: $namespace, key: $key) { value compareDigest }
      }
    }`,
    { namespace: STATE_NAMESPACE, key: STATE_KEY }
  );
  const metafield = data.currentAppInstallation?.metafield;
  let saved = {};
  if (metafield?.value) {
    try {
      saved = JSON.parse(metafield.value);
    } catch {
      saved = {};
    }
  }
  return {
    state: { ...DEFAULT_STATE, ...saved },
    digest: metafield?.compareDigest ?? null,
    installationId: data.currentAppInstallation.id,
    shopId: data.shop.id,
  };
}

export async function getBlockState(admin) {
  return (await readState(admin)).state;
}

/**
 * Reads the state, applies `mutate` to it and saves it, but only if nobody
 * saved in between (compareDigest). On a clash it re-reads and applies
 * `mutate` again, so mutate must work from whatever it's given, not from
 * values captured earlier. Return false from mutate to skip the write.
 * Also writes the public { enabled, message } flag. Returns the saved state.
 */
async function updateState(admin, mutate) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { state, digest, installationId, shopId } = await readState(admin);
    if (mutate(state) === false) return state;
    const result = await gql(
      admin,
      `mutation SaveDiscountBlock($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message code } }
      }`,
      {
        metafields: [
          {
            ownerId: installationId,
            namespace: STATE_NAMESPACE,
            key: STATE_KEY,
            type: "json",
            value: JSON.stringify(state),
            // null means "only if it doesn't exist yet".
            compareDigest: digest,
          },
          {
            ownerId: shopId,
            namespace: PUBLIC_NAMESPACE,
            key: PUBLIC_KEY,
            type: "json",
            value: JSON.stringify({ enabled: state.enabled, message: state.message }),
          },
        ],
      }
    );
    const errors = result.metafieldsSet?.userErrors ?? [];
    if (!errors.length) return state;
    if (errors.some((e) => e.code === "STALE_OBJECT" || e.code === "INVALID_COMPARE_DIGEST")) {
      await sleep(200 * (attempt + 1));
      continue;
    }
    throw new Error(`Couldn't save discount block settings: ${errors[0].message}`);
  }
  throw new Error("Couldn't save discount block settings: it kept changing underneath. Try again.");
}

// ---------------------------------------------------------------------------
// Automatic discounts

/** Map of this app's function IDs to handles. */
async function getFunctionHandles(admin) {
  const data = await gql(admin, `query DiscountBlockFunctions { shopifyFunctions(first: 50) { nodes { id handle } } }`);
  return new Map((data.shopifyFunctions?.nodes ?? []).map((f) => [f.id, f.handle]));
}

function toAutomatic(node, handles = null) {
  const d = node?.discount;
  if (!d) return null;
  const ownedByApp =
    !!process.env.SHOPIFY_API_KEY && d.appDiscountType?.app?.apiKey === process.env.SHOPIFY_API_KEY;
  const functionHandle = handles?.get(d.appDiscountType?.functionId) ?? null;
  return {
    id: node.id,
    type: d.__typename,
    title: d.title,
    status: d.status,
    startsAt: d.startsAt ?? null,
    endsAt: d.endsAt ?? null,
    app: d.appDiscountType?.app?.title ?? null,
    // This app's discounts stay active and are switched off by the flag instead.
    ownedByApp,
    functionHandle,
    // Only meaningful for this app's discounts; others are paused regardless.
    exempt: node.blockExempt?.value === "true",
    // Why it can't be kept working, or null if it can. Unknown handle: allowed.
    exemptUnsupported: ownedByApp ? (EXEMPT_UNSUPPORTED[functionHandle] ?? null) : null,
  };
}

/**
 * Active and scheduled automatic discounts (any app, or native), each marked
 * ownedByApp. `complete` is false if there were more than MAX_PAGES pages.
 */
export async function listLiveAutomaticDiscounts(admin) {
  const handles = await getFunctionHandles(admin).catch(() => null);
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
      const d = toAutomatic(node, handles);
      if (d) discounts.push(d);
    }
    if (!conn.pageInfo.hasNextPage) return { discounts, complete: true };
    after = conn.pageInfo.endCursor;
  }
  return { discounts, complete: false };
}

async function getAutomaticDiscount(admin, id, handles = null) {
  const data = await gql(admin, `query AutomaticDiscount($id: ID!) { discountNode(id: $id) { ${AUTOMATIC_SELECTION} } }`, {
    id,
  });
  return toAutomatic(data.discountNode, handles);
}

const isLive = (d) => d && (d.status === "ACTIVE" || d.status === "SCHEDULED");
// Discounts the block has to pause: live ones this app can't switch off itself.
const needsPause = (d) => isLive(d) && !d.ownedByApp;

/** Returns null on success, or why it failed. Never throws. */
async function deactivateAutomatic(admin, id) {
  try {
    const data = await gql(
      admin,
      `mutation PauseAutomatic($id: ID!) {
        discountAutomaticDeactivate(id: $id) { userErrors { field message } }
      }`,
      { id }
    );
    return firstUserError(data.discountAutomaticDeactivate);
  } catch (err) {
    return err.message;
  }
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

  const current = await getAutomaticDiscount(admin, saved.id);
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

const restoreRecord = ({ id, type, title, startsAt, endsAt, app }) => ({ id, type, title, startsAt, endsAt, app });

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
    },
    // A timed-out create may have gone through; repeating it would make a second validation.
    { once: true }
  );
  const error = firstUserError(data.validationCreate);
  if (error) throw new Error(`Couldn't create the checkout validation: ${error}`);
}

// ---------------------------------------------------------------------------
// Reconcile: pause what needs pausing, then decide on the validation

/**
 * Brings the store in line with an enabled block: pauses every live automatic
 * discount that isn't this app's (all of them, or just `only`), then turns the
 * checkout validation on if nothing is left running, or holds it off if
 * anything is. Safe to run repeatedly. Never throws for a single discount;
 * throws only if the state itself can't be read or saved.
 * Returns { paused, held, state }.
 */
async function reconcile(admin, { only = null } = {}) {
  let live;
  let complete = true;
  let listError = null;
  if (only) {
    live = only.filter(needsPause);
  } else {
    try {
      const listed = await listLiveAutomaticDiscounts(admin);
      live = listed.discounts.filter(needsPause);
      complete = listed.complete;
    } catch (err) {
      live = [];
      complete = false;
      listError = err.message;
    }
  }

  // Record restore entries before pausing, so a crash mid-way still leaves
  // them restorable. Entries already on the list keep their original dates.
  let enabled = true;
  let addedIds = new Set();
  if (live.length) {
    await updateState(admin, (state) => {
      enabled = state.enabled;
      addedIds = new Set();
      if (!enabled) return false;
      const known = new Set(state.paused.map((d) => d.id));
      const added = live.filter((d) => !known.has(d.id));
      if (!added.length) return false;
      addedIds = new Set(added.map((d) => d.id));
      state.paused = [...state.paused, ...added.map(restoreRecord)];
    });
  }
  if (!enabled) return { paused: 0, held: false, state: await getBlockState(admin) };

  const failures = [];
  for (const d of live) {
    const error = await deactivateAutomatic(admin, d.id);
    if (error) failures.push({ id: d.id, title: d.title, message: `Couldn't pause: ${error}` });
  }

  const problems = [...failures];
  if (listError) problems.push({ id: null, title: "Automatic discounts", message: `Couldn't list them: ${listError}` });
  else if (!complete) {
    problems.push({
      id: null,
      title: "Automatic discounts",
      message: `There are more than ${MAX_PAGES * 100}; only the first ${MAX_PAGES * 100} were checked.`,
    });
  }
  // A single-discount run can't vouch for the rest if an earlier run failed,
  // so it keeps the hold (and store-wide errors) until a full sweep clears it.
  const failedIds = new Set(failures.map((f) => f.id));
  let state = await updateState(admin, (s) => {
    if (!s.enabled) return false;
    // A discount added this run that never got paused has nothing to
    // restore. One already on the list keeps its original dates.
    s.paused = s.paused.filter((d) => !(failedIds.has(d.id) && addedIds.has(d.id)));
    const ids = new Set(live.map((d) => d.id));
    if (!only) ids.add(null);
    s.errors = [...s.errors.filter((e) => !ids.has(e.id)), ...problems];
    s.needsSweep = problems.length > 0 || (only ? s.needsSweep : false);
  });
  if (!state.enabled) {
    // The block was turned off while this ran, and turning it off may already
    // have restored the list. Undo this run's pauses so none is left stranded.
    for (const d of live) {
      if (failedIds.has(d.id)) continue;
      try {
        await restoreAutomatic(admin, restoreRecord(d));
      } catch (err) {
        console.error(`[discount-block] Couldn't restore "${d.title}" after the block was turned off:`, err.message);
      }
    }
    return { paused: 0, held: false, state };
  }

  const held = state.needsSweep;
  try {
    await setValidationEnabled(admin, !held);
  } catch (err) {
    state = await updateState(admin, (s) => {
      s.errors = [...s.errors.filter((e) => e.title !== "Checkout validation"), { id: null, title: "Checkout validation", message: err.message }];
    });
  }
  return { paused: live.length - failures.length, held, state };
}

// ---------------------------------------------------------------------------
// Public operations

/**
 * Turns the block on: set the flag (this app's discounts stop applying), then
 * reconcile. The validation only comes on once every other automatic
 * discount is paused. Clicking it again resumes a run that stopped part way.
 */
export async function enableBlock(admin, { message } = {}) {
  await updateState(admin, (state) => {
    state.message = message?.trim() || state.message || DEFAULT_MESSAGE;
    state.errors = [];
    if (!state.enabled) {
      state.enabledAt = new Date().toISOString();
      state.disabledAt = null;
    }
    // Mark enabled before pausing so the discounts webhook treats any discount
    // resumed mid-way as something to re-pause.
    state.enabled = true;
    state.needsSweep = true;
  });
  return (await reconcile(admin)).state;
}

/**
 * Turns the block off: drop the public flag and the validation first so
 * checkout stops blocking immediately, then restore paused discounts.
 * Discounts whose original end date passed while paused stay off. Anything
 * not restored stays on the list, and clicking again retries it.
 */
export async function disableBlock(admin) {
  const { paused } = await updateState(admin, (state) => {
    state.enabled = false;
    state.disabledAt = new Date().toISOString();
    state.errors = [];
    state.needsSweep = false;
  });

  const errors = [];
  try {
    await setValidationEnabled(admin, false);
  } catch (err) {
    errors.push({ id: null, title: "Checkout validation", message: err.message });
  }

  const now = Date.now();
  const done = new Set();
  for (const saved of paused) {
    if (saved.endsAt && new Date(saved.endsAt).getTime() <= now) {
      done.add(saved.id); // expired while paused
      continue;
    }
    try {
      const { active, error } = await restoreAutomatic(admin, saved);
      if (error) errors.push({ id: saved.id, title: saved.title, message: error });
      if (active) done.add(saved.id);
    } catch (err) {
      errors.push({ id: saved.id, title: saved.title, message: `Couldn't turn back on: ${err.message}` });
    }
  }
  return updateState(admin, (state) => {
    state.paused = state.paused.filter((d) => !done.has(d.id));
    state.errors = [...state.errors, ...errors];
  });
}

/** Changes the customer-facing message, on or off. */
export async function updateMessage(admin, message) {
  return updateState(admin, (state) => {
    state.message = message?.trim() || DEFAULT_MESSAGE;
  });
}

/**
 * Marks one of this app's automatic discounts as kept working (or not) while
 * the block is on. Takes effect at checkout immediately, on or off.
 */
export async function setExempt(admin, discountId, exempt) {
  const discount = await getAutomaticDiscount(admin, discountId, await getFunctionHandles(admin));
  if (!discount) throw new Error("Discount not found.");
  if (!discount.ownedByApp) throw new Error("Only this app's discounts can keep working during the block.");
  if (exempt && discount.exemptUnsupported) throw new Error(discount.exemptUnsupported);
  const data = await gql(
    admin,
    `mutation SetDiscountBlockExempt($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    {
      metafields: [
        { ownerId: discount.id, namespace: EXEMPT_NAMESPACE, key: EXEMPT_KEY, type: "boolean", value: String(!!exempt) },
      ],
    }
  );
  const error = firstUserError(data.metafieldsSet);
  if (error) throw new Error(`Couldn't update "${discount.title}": ${error}`);
  return { ...discount, exempt: !!exempt };
}

/**
 * Re-runs the full sweep if the block is on and the last run didn't finish
 * cleanly. Called on page load. Returns the current state.
 */
export async function resumeIfNeeded(admin) {
  const state = await getBlockState(admin);
  if (!state.enabled || !state.needsSweep) return state;
  return (await reconcile(admin)).state;
}

/**
 * Called on every discounts/create|update webhook. While the block is on,
 * pauses the automatic discount if it's live (created or resumed in the admin)
 * and not this app's. Code discounts are ignored: they're handled at checkout,
 * and PostScript creates hundreds a day. Does a full sweep instead when there's
 * no ID or the last run didn't finish cleanly.
 *
 * If it fails, or a discount is left running, it holds the validation off (so
 * that discount doesn't block orders), marks the state for a full sweep, and
 * throws so the webhook returns an error and Shopify retries it.
 * Returns how many were paused.
 */
export async function guardAutomaticDiscounts(admin, discountGid) {
  if (discountGid && !discountGid.includes("DiscountAutomaticNode")) return 0;
  const state = await getBlockState(admin);
  if (!state.enabled) return 0;

  let result;
  try {
    if (!discountGid || state.needsSweep) {
      result = await reconcile(admin);
    } else {
      const discount = await getAutomaticDiscount(admin, discountGid);
      if (!needsPause(discount)) return 0;
      result = await reconcile(admin, { only: [discount] });
    }
  } catch (err) {
    try {
      await setValidationEnabled(admin, false);
    } catch {
      // Already failing; the throw below gets the webhook retried.
    }
    try {
      await updateState(admin, (s) => {
        if (!s.enabled) return false;
        s.needsSweep = true;
        s.errors = [...s.errors, { id: discountGid ?? null, title: "Discount check", message: err.message }];
      });
    } catch {
      // Same.
    }
    throw err;
  }
  if (result.held) {
    throw new Error(
      `Discount block isn't fully on: ${result.state.errors.map((e) => `${e.title}: ${e.message}`).join("; ")}`
    );
  }
  return result.paused;
}
