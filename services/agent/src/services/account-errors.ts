/**
 * True when an error means "this Stellar account does not exist on-chain"
 * (Horizon 404). `server.loadAccount(address)` throws this for an address that
 * was never funded/created. Used so revoke can treat an unfunded agent as
 * "nothing to drain" instead of failing.
 */
export function isAccountNotFound(err: unknown): boolean {
  const e = err as
    | { response?: { status?: number; statusCode?: number }; name?: string; message?: string }
    | null
    | undefined;
  if (!e) return false;
  return (
    e.response?.status === 404 ||
    e.response?.statusCode === 404 ||
    e.name === 'NotFoundError' ||
    /not\s*found/i.test(e.message ?? '')
  );
}
