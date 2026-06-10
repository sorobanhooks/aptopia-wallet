import { wallet as sdkWallet } from "@shared/helpers/stellar";
import { FundAccountMessage } from "@shared/api/types/message-request";
export const fundAccount = async ({
  request,
}: {
  request: FundAccountMessage;
}) => {
  const { publicKey, friendbotUrl } = request;

  try {
    if (!friendbotUrl || friendbotUrl.includes("friendbot.stellar.org")) {
      // Prioritize the SDK's fundAccount as the primary and default method
      await sdkWallet.fundAccount(publicKey);
    } else {
      // Manual fetch only for custom Friendbot URLs the SDK might not handle
      const res = await fetch(`${friendbotUrl}?addr=${publicKey}`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} - ${text}`);
      }
    }
  } catch (sdkErr: any) {
    if (sdkErr.message && sdkErr.message.includes("account already funded")) {
      console.log("Account already funded from friendbot. Proceeding.");
      return { publicKey };
    }
    console.error("SDK fundAccount failed:", sdkErr);
    throw new Error(`Error funding account: ${sdkErr.message || "Friendbot failure"}`);
  }

  return { publicKey };
};
