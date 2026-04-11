import { config } from '../../config';

export type UsdcBalanceEvaluation = {
  usdc: number;
  isLow: boolean;
  belowFloor: boolean;
  cannotCoverNextPayment: boolean;
  floor: number;
  nextPayment: number;
};

/**
 * Interpret Horizon USDC balance string vs configured low-balance floor and x402 per-request price.
 */
export function evaluateUsdcBalance(
  usdcBalanceStr: string,
  overrides?: { floor?: number; nextPayment?: number }
): UsdcBalanceEvaluation {
  const usdc = parseFloat(usdcBalanceStr) || 0;
  const floor = overrides?.floor ?? config.usdcLowBalanceFloor;
  const nextPayment = overrides?.nextPayment ?? config.x402PaywallPriceUsdc;

  const belowFloor = usdc < floor;
  const cannotCoverNextPayment = usdc < nextPayment;
  const isLow = belowFloor || cannotCoverNextPayment;

  return {
    usdc,
    isLow,
    belowFloor,
    cannotCoverNextPayment,
    floor,
    nextPayment,
  };
}
