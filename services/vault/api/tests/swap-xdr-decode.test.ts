// vault/api/tests/swap-xdr-decode.test.ts
import { describe, expect, test } from "bun:test";
import { Contract, scValToNative, xdr } from "@stellar/stellar-sdk";
import { addrScVal, i128ScVal, pathScVal, u64ScVal } from "../src/rpc";

const ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
// Valid Stellar Ed25519 public key. The plan used a made-up address with an
// invalid checksum; replaced with a valid one from Keypair.random() for the test.
const USER = "GCVM73IEG45VXQFOGA47CW4W2BJ2UCGE3S6DWXTFDI5GDFLN74BKRYLH";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

describe("swap op encoding", () => {
  test("contract.call('swap_exact_tokens_for_tokens', ...) round-trips the 5 args", () => {
    const args = [
      i128ScVal("5000000"),
      i128ScVal("37810000"),
      pathScVal([USDC, XLM]),
      addrScVal(USER),
      u64ScVal(1234567890),
    ];
    const op = new Contract(ROUTER).call("swap_exact_tokens_for_tokens", ...args);
    // Decode the invoke-contract op back to native and assert the args.
    const invoke = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
    const decodedArgs = invoke.args().map((a: xdr.ScVal) => scValToNative(a));
    expect(decodedArgs[0]).toBe(5000000n);
    expect(decodedArgs[1]).toBe(37810000n);
    expect(decodedArgs[2]).toEqual([USDC, XLM]);
    expect(decodedArgs[3]).toBe(USER);
    expect(decodedArgs[4]).toBe(1234567890n);
  });
});
