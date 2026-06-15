import { Operation, Asset, xdr } from "stellar-sdk";

/**
 * Build the single operation that funds the agent address.
 * A brand-new Stellar account must be created with `createAccount` (a plain
 * `payment` fails with op_no_destination); an existing account takes a payment.
 * Returns a real xdr.Operation usable by TransactionBuilder.addOperation().
 */
export const buildFundingOperation = ({
  destination,
  amount,
  accountExists,
}: {
  destination: string;
  amount: string;
  accountExists: boolean;
}): xdr.Operation => {
  if (!accountExists) {
    return Operation.createAccount({ destination, startingBalance: amount });
  }
  return Operation.payment({ destination, asset: Asset.native(), amount });
};
