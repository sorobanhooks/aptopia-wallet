import type { NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "../config";

type X402PaymentRequirements = {
  scheme: string;
  network: `${string}:${string}`;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

type X402PaymentRequired = {
  x402Version: number;
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepts: X402PaymentRequirements[];
};

function decimalToAtomic(amount: string, decimals: number): string {
  const normalized = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid decimal amount format: ${amount}`);
  }

  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(
      `Price ${amount} has too many decimal places for token decimals=${decimals}`
    );
  }

  const atomic = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+/, "") || "0";
  if (!/^\d+$/.test(atomic)) {
    throw new Error(`Failed to convert price ${amount} to atomic units`);
  }
  return atomic;
}

/**
 * Creates a middleware for routes that require x402 payment on Stellar.
 * @param amount The price in USDC (e.g., "0.01")
 */
export function createPaidRouteMiddleware(amount: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Dynamic import to handle ESM-only @x402 packages in CJS project
    // We use eval('import(...)') to prevent ts-node/typescript from transpiling it to require()
    const {
      HTTPFacilitatorClient,
      encodePaymentRequiredHeader,
      decodePaymentSignatureHeader,
      encodePaymentSignatureHeader,
    } = await (eval('import("@x402/core/http")') as Promise<typeof import("@x402/core/http")>);
    const { getUsdcAddress } = await (eval('import("@x402/stellar")') as Promise<typeof import("@x402/stellar")>);

    if (!config.facilitatorUrl || !config.receiverWallet || !config.facilitatorApiKey) {
      return res.status(500).json({
        error: "Server configuration error: X402 settings missing",
      });
    }

    const { token } = req.params;
    const network =
      config.network === "stellar-testnet"
        ? "stellar:testnet"
        : config.network === "stellar"
          ? "stellar:pubnet"
          : (config.network as `${string}:${string}`);
    const resolvedAsset =
      config.usdcAssetCode.toUpperCase() === "USDC"
        ? getUsdcAddress(network)
        : config.usdcAssetCode;
    const requirements: X402PaymentRequirements = {
      scheme: "exact" as const,
      network,
      payTo: config.receiverWallet,
      amount: decimalToAtomic(amount, config.usdcDecimals),
      asset: resolvedAsset,
      maxTimeoutSeconds: config.requestTimeoutMs / 1000,
      extra: {},
    };
    const paymentRequired: X402PaymentRequired = {
      x402Version: 2,
      resource: {
        url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
        description: `Subscription for ${token || "token"} alerts`,
        mimeType: "application/json",
      },
      accepts: [requirements],
    };

    const paymentHeader =
      req.header("PAYMENT-SIGNATURE") || req.header("X-Payment");

    if (!paymentHeader) {
      // 1. Missing payment: Return 402 with requirements header
      const requiredHeader = encodePaymentRequiredHeader(paymentRequired as any);
      // Keep legacy header for compatibility with older clients.
      res.setHeader("PAYMENT-REQUIRED", requiredHeader);
      res.setHeader("X-Payment", requiredHeader);
      return res.status(402).json({
        error: "Payment Required",
        requirements: {
          amount,
          asset: config.usdcAssetCode,
          payTo: config.receiverWallet,
        },
      });
    }

    // 2. Payment present: Verify with facilitator
    try {
      const facilitator = new HTTPFacilitatorClient({
        url: config.facilitatorUrl as `${string}://${string}`,
        createAuthHeaders: async () => {
          const headers = {
            Authorization: `Bearer ${config.facilitatorApiKey}`,
          };
          return { verify: headers, settle: headers, supported: headers };
        },
      });
      const paymentPayload = decodePaymentSignatureHeader(paymentHeader);

      // Verify the payment against our requirements
      const verification = await facilitator.verify(paymentPayload, requirements as any);

      if (!verification.isValid) {
        // Invalid payment: Return 402 with refreshed requirements
        const requiredHeader = encodePaymentRequiredHeader(paymentRequired as any);
        res.setHeader("PAYMENT-REQUIRED", requiredHeader);
        res.setHeader("X-Payment", requiredHeader);
        return res.status(402).json({
          error: "Invalid Payment",
          reason: verification.invalidReason,
        });
      }

      const paymentSignatureHeader = encodePaymentSignatureHeader(paymentPayload as any);
      res.setHeader("PAYMENT-SIGNATURE", paymentSignatureHeader);
      // 3. Payment verified!
      next();
    } catch (error) {
      console.error("X402 Verification Error:", error);
      res.status(500).json({ error: "Internal payment verification error" });
    }
  };
}
