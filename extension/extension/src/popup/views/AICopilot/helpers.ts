import BigNumber from "bignumber.js";
import { SwapSymbol } from "api/bakuSwapService";

const ONE_TOKEN = new BigNumber("10000000"); // 7 decimals

export const toBaseUnits = (human: string): string =>
  new BigNumber(human).multipliedBy(ONE_TOKEN).toFixed(0, BigNumber.ROUND_DOWN);

export const fromBaseUnits = (base: string): string =>
  new BigNumber(base).dividedBy(ONE_TOKEN).toString();

export const tokenLabel = (symbol: SwapSymbol): string =>
  symbol === "usdc" ? "USDC (Circle)" : "XLM";
