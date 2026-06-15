// Cross-view signal that on-chain balances changed (e.g. a Yield Hub deposit or
// withdraw). The Yield Hub refreshes its own state via loadAll(), but the Tokens
// tab's account balances are fetched once on mount by the Account view and would
// otherwise stay stale until the popup is closed and reopened. Emitting this
// lightweight window event lets the Account view re-fetch in place.

export const BALANCES_CHANGED_EVENT = "xyra:balances-changed";

/** Notify listeners (e.g. the Account view) that balances should be re-fetched. */
export const emitBalancesChanged = (): void => {
  window.dispatchEvent(new CustomEvent(BALANCES_CHANGED_EVENT));
};

/** Subscribe to balance-change notifications. Returns an unsubscribe function. */
export const onBalancesChanged = (handler: () => void): (() => void) => {
  window.addEventListener(BALANCES_CHANGED_EVENT, handler);
  return () => window.removeEventListener(BALANCES_CHANGED_EVENT, handler);
};
